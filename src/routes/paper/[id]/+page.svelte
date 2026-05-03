<script lang="ts">
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { papers, threads, ui } from '$lib/stores.svelte';
	import { Button, Badge, Textarea, Separator, Dialog, Input } from '$lib/components/ui';
	import PdfViewer from '$lib/components/PdfViewer.svelte';
	import PaperChat from '$lib/components/PaperChat.svelte';
	import PaperSummary from '$lib/components/PaperSummary.svelte';
	import { revealInFinder, openExternal } from '$lib/tauri/shell';
	import { readNotes, writeNotes } from '$lib/tauri/fs';
	import { ExternalLink, FolderOpen, Star, FileText, Sparkles, MessageSquare, PanelRight, Inbox, Check, ArrowRightLeft } from 'lucide-svelte';
	import type { ReadingStatus } from '$lib/types';

	const id = $derived(page.params.id!);
	const paper = $derived(papers.get(id));

	type MainView = 'pdf' | 'summary' | 'chat';
	type SidePanel = 'info' | 'notes';

	let mainView = $state<MainView>('pdf');
	let panel = $state<SidePanel>('info');
	let sidebarOpen = $state(true);
	let notes = $state('');
	let notesLoaded = $state(false);
	let movingThread = $state(false);
	let movePickerOpen = $state(false);
	let moveQuery = $state('');

	const currentThreadId = $derived(paper?.threadId ?? 'inbox');
	const currentThreadLabel = $derived(
		currentThreadId === 'inbox' ? 'Inbox' : threads.get(currentThreadId)?.title ?? 'Inbox'
	);

	type MoveOption = { id: string; label: string; question: string; isInbox: boolean };

	const moveOptions = $derived.by<MoveOption[]>(() => {
		const q = moveQuery.trim().toLowerCase();
		const all: MoveOption[] = [
			{ id: 'inbox', label: 'Inbox', question: 'Untriaged papers', isInbox: true },
			...threads.items.map((t) => ({
				id: t.id,
				label: t.title || '(untitled thread)',
				question: t.question ?? '',
				isInbox: false
			}))
		];
		if (!q) return all;
		return all.filter(
			(o) => o.label.toLowerCase().includes(q) || o.question.toLowerCase().includes(q)
		);
	});

	$effect(() => {
		// Depend only on `id` — untrack the openPaper call so its read of
		// tabOrder doesn't make this effect re-fire when other code mutates
		// the tab list (e.g. closing the active tab).
		if (id) untrack(() => ui.openPaper(id));
	});

	async function loadNotes() {
		if (!paper) return;
		notesLoaded = false;
		notes = await readNotes(paper.threadId ?? 'inbox', paper.arxivId);
		notesLoaded = true;
	}

	$effect(() => {
		if (paper && !notesLoaded) {
			void loadNotes();
		}
	});

	// When the paper moves between threads, its notes file relocates with it.
	// Force a reload so the textarea reflects the new path.
	$effect(() => {
		void paper?.threadId;
		notesLoaded = false;
	});

	async function saveNotes() {
		if (!paper) return;
		await writeNotes(paper.threadId ?? 'inbox', paper.arxivId, notes);
	}

	async function setStatus(status: ReadingStatus) {
		if (!paper) return;
		await papers.update(paper.id, { readingStatus: status });
	}

	async function setRating(r: number) {
		if (!paper) return;
		await papers.update(paper.id, { rating: paper.rating === r ? null : r });
	}

	function openMovePicker() {
		moveQuery = '';
		movePickerOpen = true;
	}

	async function moveToThread(toId: string) {
		if (!paper) return;
		if (toId === currentThreadId) {
			movePickerOpen = false;
			return;
		}
		movingThread = true;
		movePickerOpen = false;
		try {
			await papers.move(paper.id, toId);
		} finally {
			movingThread = false;
		}
	}

	const mainTabs: { id: MainView; label: string; icon: typeof FileText }[] = [
		{ id: 'pdf', label: 'PDF', icon: FileText },
		{ id: 'summary', label: 'Summary', icon: Sparkles },
		{ id: 'chat', label: 'Chat', icon: MessageSquare }
	];
</script>

{#if !paper}
	<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
		Paper not found.
	</div>
{:else}
	<div class="flex h-full flex-col">
		{#if !ui.pdfFullscreen}
			<div
				class="flex h-9 shrink-0 items-center justify-between border-b border-border/60 bg-card pl-2 pr-2"
			>
				<div
					class="inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-background/40 p-0.5"
					role="tablist"
					aria-label="Paper view"
				>
					{#each mainTabs as t (t.id)}
						{@const Icon = t.icon}
						<button
							class="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors {mainView ===
							t.id
								? 'bg-accent/15 text-accent'
								: 'text-muted-foreground hover:text-foreground'}"
							role="tab"
							aria-selected={mainView === t.id}
							onclick={() => (mainView = t.id)}
						>
							<Icon class="h-3.5 w-3.5" />
							{t.label}
						</button>
					{/each}
				</div>

				<button
					class="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					class:text-accent={sidebarOpen}
					onclick={() => (sidebarOpen = !sidebarOpen)}
					aria-pressed={sidebarOpen}
					title={sidebarOpen ? 'Hide details' : 'Show details'}
				>
					<PanelRight class="h-3.5 w-3.5" />
				</button>
			</div>
		{/if}

		<div class="flex min-h-0 flex-1">
			<div class="relative min-w-0 flex-1">
				<!-- All three views are mounted; we toggle visibility so streams and
				     PDF viewer state survive view switches. -->
				<div class="absolute inset-0" class:hidden={mainView !== 'pdf'}>
					<PdfViewer path={paper.pdfPath} />
				</div>
				<div class="absolute inset-0 bg-background" class:hidden={mainView !== 'summary'}>
					<PaperSummary {paper} />
				</div>
				<div class="absolute inset-0 bg-background" class:hidden={mainView !== 'chat'}>
					<PaperChat {paper} />
				</div>
			</div>

			{#if !ui.pdfFullscreen && sidebarOpen}
				<aside
					class="flex w-[340px] shrink-0 flex-col border-l border-border/60 bg-card"
				>
					<div class="flex border-b border-border/60">
						{#each ['info', 'notes'] as p (p)}
							<button
								class="flex-1 border-b-2 px-3 py-2 text-xs font-medium uppercase tracking-wider transition-colors {panel === p
									? 'border-accent text-accent'
									: 'border-transparent text-muted-foreground hover:text-foreground'}"
								onclick={() => (panel = p as SidePanel)}
							>
								{p}
							</button>
						{/each}
					</div>

					<div class="flex-1 overflow-y-auto">
						{#if panel === 'info'}
							<div class="space-y-4 p-4">
								<div>
									<h2 class="text-sm font-semibold leading-snug">{paper.title}</h2>
									<p class="mt-1 text-xs text-muted-foreground">
										{paper.authors.join(', ')}
									</p>
								</div>

								<div class="flex flex-wrap gap-1">
									{#each paper.categories as c (c)}
										<Badge variant="outline" class="font-mono text-[10px]">{c}</Badge>
									{/each}
								</div>

								<Separator />

								<div>
									<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
										Reading status
									</div>
									<div class="mt-2 flex flex-wrap gap-1">
										{#each ['unread', 'reading', 'read', 'archived'] as s (s)}
											<Button
												size="sm"
												variant={paper.readingStatus === s ? 'secondary' : 'ghost'}
												onclick={() => setStatus(s as ReadingStatus)}
											>
												{s}
											</Button>
										{/each}
									</div>
								</div>

								<div>
									<div class="flex items-center justify-between">
										<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
											Thread
										</div>
										{#if movingThread}
											<span class="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
												<span class="h-2 w-2 animate-pulse rounded-full bg-accent"></span>
												moving…
											</span>
										{/if}
									</div>
									<button
										type="button"
										class="mt-2 flex w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm transition-colors hover:bg-accent/5 disabled:opacity-50"
										disabled={movingThread}
										onclick={openMovePicker}
									>
										<span class="flex min-w-0 items-center gap-2">
											{#if currentThreadId === 'inbox'}
												<Inbox class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
											{/if}
											<span class="truncate">{currentThreadLabel}</span>
										</span>
										<ArrowRightLeft class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
									</button>
									<p class="mt-1 text-[10px] text-muted-foreground">Click to move to another thread.</p>
								</div>

								<div>
									<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Rating</div>
									<div class="mt-2 flex gap-0.5">
										{#each [1, 2, 3, 4, 5] as n (n)}
											<button
												class="text-amber-500 transition-transform hover:scale-110"
												onclick={() => setRating(n)}
												aria-label={`Rate ${n}`}
											>
												<Star
													class={`h-4 w-4 ${(paper.rating ?? 0) >= n ? 'fill-amber-500' : ''}`}
												/>
											</button>
										{/each}
									</div>
								</div>

								{#if paper.abstract}
									<div>
										<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
											Abstract
										</div>
										<p class="mt-2 text-xs leading-relaxed text-muted-foreground">
											{paper.abstract}
										</p>
									</div>
								{/if}

								<Separator />

								<div class="flex flex-wrap gap-2">
									{#if paper.arxivUrl}
										<Button
											size="sm"
											variant="outline"
											onclick={() => openExternal(paper.arxivUrl)}
										>
											<ExternalLink class="h-3.5 w-3.5" />
											Arxiv
										</Button>
									{/if}
									<Button
										size="sm"
										variant="outline"
										onclick={() => revealInFinder(paper.pdfPath)}
									>
										<FolderOpen class="h-3.5 w-3.5" />
										Reveal in Finder
									</Button>
								</div>
							</div>
						{:else if panel === 'notes'}
							<div class="flex h-full flex-col p-3">
								<Textarea
									bind:value={notes}
									onblur={saveNotes}
									placeholder="Your notes on this paper…"
									class="h-full min-h-0 flex-1 resize-none font-mono text-xs"
								/>
							</div>
						{/if}
					</div>
				</aside>
			{/if}
		</div>
	</div>

	<Dialog
		bind:open={movePickerOpen}
		title="Move paper to…"
		description="Pick a thread, or move back to Inbox."
		onOpenChange={(open) => {
			if (!open) moveQuery = '';
		}}
	>
		<div class="space-y-3">
			<Input bind:value={moveQuery} placeholder="Search threads…" autofocus />
			<div class="max-h-80 space-y-0.5 overflow-y-auto">
				{#each moveOptions as o (o.id)}
					{@const isCurrent = o.id === currentThreadId}
					<button
						type="button"
						class="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm transition-colors hover:bg-accent/10 disabled:cursor-default disabled:opacity-60"
						disabled={isCurrent}
						onclick={() => moveToThread(o.id)}
					>
						{#if o.isInbox}
							<Inbox class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						{/if}
						<span class="flex min-w-0 flex-1 flex-col">
							<span class="truncate font-medium">{o.label}</span>
							{#if o.question}
								<span class="truncate text-[11px] text-muted-foreground">{o.question}</span>
							{/if}
						</span>
						{#if isCurrent}
							<span class="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
								<Check class="h-3 w-3" /> current
							</span>
						{/if}
					</button>
				{:else}
					<p class="px-2 py-6 text-center text-xs text-muted-foreground">No threads match.</p>
				{/each}
			</div>
		</div>
	</Dialog>
{/if}
