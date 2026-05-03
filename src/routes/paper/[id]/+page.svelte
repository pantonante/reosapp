<script lang="ts">
	import { page } from '$app/state';
	import { papers, ui } from '$lib/stores.svelte';
	import { Button, Badge, Textarea, Separator } from '$lib/components/ui';
	import PdfViewer from '$lib/components/PdfViewer.svelte';
	import PaperChat from '$lib/components/PaperChat.svelte';
	import PaperSummary from '$lib/components/PaperSummary.svelte';
	import { revealInFinder, openExternal } from '$lib/tauri/shell';
	import { readNotes, writeNotes } from '$lib/tauri/fs';
	import { ExternalLink, FolderOpen, Star, FileText, Sparkles, MessageSquare, PanelRight } from 'lucide-svelte';
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

	$effect(() => {
		if (id) ui.openPaper(id);
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
{/if}
