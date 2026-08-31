<script lang="ts">
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { papers, threads, ui, type MainView } from '$lib/stores.svelte';
	import { Button, Badge, Textarea, Separator, Dialog, Input } from '$lib/components/ui';
	import PdfViewer from '$lib/components/PdfViewer.svelte';
	import SourceViewer from '$lib/components/SourceViewer.svelte';
	import PaperChat from '$lib/components/PaperChat.svelte';
	import PaperSummary from '$lib/components/PaperSummary.svelte';
	import { revealInFinder, openExternal } from '$lib/tauri/shell';
	import { toAlphaxivUrl } from '$lib/arxiv';
	import { readNotes, writeNotes } from '$lib/tauri/fs';
	import { ask } from '@tauri-apps/plugin-dialog';
	import { ExternalLink, FolderOpen, Copy, Star, FileText, Globe, Sparkles, MessageSquare, PanelRight, Inbox, Check, ArrowRightLeft, Github, Trash2, RotateCw } from 'lucide-svelte';
	import type { ReadingStatus } from '$lib/types';

	const id = $derived(page.params.id!);
	const paper = $derived(papers.get(id));
	const isWebpage = $derived(!!paper?.sourceUrl && !paper?.pdfPath);
	// arxivUrl doubles as the bioRxiv/medRxiv content URL for preprints from
	// those servers; AlphaXiv mirroring only makes sense for actual arXiv links.
	const isArxivSource = $derived(
		!!paper?.arxivUrl && /^https?:\/\/(?:www\.)?arxiv\.org\//i.test(paper.arxivUrl)
	);
	const sourceSiteLabel = $derived(
		!paper?.arxivUrl
			? ''
			: /biorxiv\.org\//i.test(paper.arxivUrl)
				? 'bioRxiv'
				: /medrxiv\.org\//i.test(paper.arxivUrl)
					? 'medRxiv'
					: 'Arxiv'
	);

	type SidePanel = 'info' | 'notes';

	const mainView = $derived(ui.getPaperView(id));
	function setMainView(v: MainView) {
		ui.setPaperView(id, v);
	}
	let panel = $state<SidePanel>('info');
	// Auto-collapse the right detail panel on narrow viewports (e.g. Mac half-screen)
	// where a 300px panel would leave the main pane too cramped to use.
	let sidebarOpen = $state(
		typeof window === 'undefined' ? true : window.innerWidth >= 900
	);
	let notes = $state('');
	let notesLoaded = $state(false);
	let reloadToken = $state(0);
	let movingThread = $state(false);
	let deleting = $state(false);
	let movePickerOpen = $state(false);
	let moveQuery = $state('');
	let pathCopyState = $state<'idle' | 'copied' | 'failed'>('idle');
	let pathCopyReset: ReturnType<typeof setTimeout> | undefined;

	let refCopyState = $state<'idle' | 'copied' | 'failed'>('idle');
	let refCopyReset: ReturnType<typeof setTimeout> | undefined;

	const currentThreadId = $derived(paper?.threadId ?? 'inbox');
	const currentThreadLabel = $derived(
		currentThreadId === 'inbox' ? 'Inbox' : threads.get(currentThreadId)?.title ?? 'Inbox'
	);

	type MoveOption = { id: string; label: string; question: string; isInbox: boolean };

	const moveOptions = $derived.by<MoveOption[]>(() => {
		const q = moveQuery.trim().toLowerCase();
		const all: MoveOption[] = [
			{ id: 'inbox', label: 'Inbox', question: 'Untriaged papers', isInbox: true },
			...threads.items
				.filter((t) => t.status !== 'archived')
				.map((t) => ({
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

	async function copyPaperPath() {
		if (!paper?.pdfPath) return;
		try {
			await navigator.clipboard.writeText(paper.pdfPath);
			pathCopyState = 'copied';
		} catch {
			pathCopyState = 'failed';
		}
		if (pathCopyReset) clearTimeout(pathCopyReset);
		pathCopyReset = setTimeout(() => (pathCopyState = 'idle'), 1800);
	}

	// Copies an unambiguous paper reference (id + title) for pasting into an
	// MCP-connected Claude session, e.g.: read 2303.04137 ("Diffusion Policy…")
	async function copyPaperRef() {
		if (!paper) return;
		try {
			await navigator.clipboard.writeText(`${paper.arxivId} ("${paper.title}")`);
			refCopyState = 'copied';
		} catch {
			refCopyState = 'failed';
		}
		if (refCopyReset) clearTimeout(refCopyReset);
		refCopyReset = setTimeout(() => (refCopyState = 'idle'), 1800);
	}

	async function setStatus(status: ReadingStatus) {
		if (!paper) return;
		await papers.update(paper.id, { readingStatus: status });
	}

	async function setRating(r: number) {
		if (!paper) return;
		await papers.update(paper.id, { rating: paper.rating === r ? null : r });
	}

	// Webpage-papers don't carry canonical metadata from an Arxiv API or an
	// extracted PDF — let the user edit the abstract and published date
	// directly from the info panel. Drafts re-sync whenever the active paper
	// changes (route switch, store refresh, etc.).
	let abstractDraft = $state('');
	let publishedDateDraft = $state('');
	let editableSyncedFor = $state<string | null>(null);
	$effect(() => {
		if (paper && editableSyncedFor !== paper.id) {
			abstractDraft = paper.abstract;
			publishedDateDraft = paper.publishedDate;
			editableSyncedFor = paper.id;
		}
	});

	async function saveAbstract() {
		if (!paper) return;
		if (abstractDraft === paper.abstract) return;
		await papers.update(paper.id, { abstract: abstractDraft });
	}

	async function savePublishedDate() {
		if (!paper) return;
		if (publishedDateDraft === paper.publishedDate) return;
		await papers.update(paper.id, { publishedDate: publishedDateDraft });
	}

	function formatPublishedDate(value: string): string {
		const d = new Date(value);
		if (isNaN(d.getTime())) return value;
		return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
	}

	let newLink = $state('');

	function normalizeUrl(raw: string): string | null {
		const trimmed = raw.trim();
		if (!trimmed) return null;
		const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
		try {
			return new URL(withScheme).toString();
		} catch {
			return null;
		}
	}

	function linkLabel(url: string): string {
		try {
			return new URL(url).hostname.replace(/^www\./, '');
		} catch {
			return url;
		}
	}

	function isGithub(url: string): boolean {
		try {
			const h = new URL(url).hostname;
			return h === 'github.com' || h.endsWith('.github.io');
		} catch {
			return false;
		}
	}

	async function addLink() {
		if (!paper) return;
		const url = normalizeUrl(newLink);
		if (!url) return;
		if (paper.links?.includes(url)) {
			newLink = '';
			return;
		}
		await papers.update(paper.id, { links: [...(paper.links ?? []), url] });
		newLink = '';
	}

	async function removeLink(url: string) {
		if (!paper) return;
		const ok = await ask(
			`Remove this link from the paper?\n\n${url}\n\nThe link is only detached from this paper — the destination page itself is not affected. You can paste the URL back later to re-add it.`,
			{
				title: 'Remove link',
				kind: 'warning',
				okLabel: 'Remove',
				cancelLabel: 'Cancel'
			}
		);
		if (!ok) return;
		await papers.update(paper.id, {
			links: (paper.links ?? []).filter((l) => l !== url)
		});
	}

	function openMovePicker() {
		moveQuery = '';
		movePickerOpen = true;
	}

	async function deletePaper() {
		if (!paper || deleting) return;
		const ok = await ask(
			`Permanently delete "${paper.title}"?\n\nThis will:\n• Remove the paper from your library and from any threads it belongs to\n• Delete the PDF file and the paper's folder from disk\n• Delete all notes, annotations, and chats attached to this paper\n• Delete its cached summary\n\nThis cannot be undone.`,
			{ title: 'Delete paper', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Cancel' }
		);
		if (!ok) return;
		deleting = true;
		try {
			// papers.remove drops the paper from the store and closes its tab
			// synchronously before touching disk/DB, so we can leave this page
			// right away and let the cleanup finish in the background.
			const removal = papers.remove(paper.id);
			const next = ui.activePaperId;
			goto(next ? `/paper/${next}` : '/');
			await removal;
		} finally {
			deleting = false;
		}
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

	const mainTabs = $derived<{ id: MainView; label: string; icon: typeof FileText }[]>([
		{
			id: 'pdf',
			label: isWebpage ? 'Source' : 'PDF',
			icon: isWebpage ? Globe : FileText
		},
		{ id: 'summary', label: 'Summary', icon: Sparkles },
		{ id: 'chat', label: 'Chat', icon: MessageSquare }
	]);
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
							title={t.id === 'chat' ? 'Chat (⌘-click to open in new tab)' : undefined}
							onclick={(e) => {
								if (t.id === 'chat' && (e.metaKey || e.ctrlKey)) {
									ui.openPaperChat(id);
									goto(`/paper/${id}/chat`);
									return;
								}
								setMainView(t.id);
							}}
						>
							<Icon class="h-3.5 w-3.5" />
							{t.label}
						</button>
					{/each}
				</div>

				<div class="flex items-center gap-0.5">
					{#if isWebpage}
						<button
							class="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							onclick={() => (reloadToken += 1)}
							title="Reload page"
							aria-label="Reload page"
						>
							<RotateCw class="h-3.5 w-3.5" />
						</button>
					{/if}
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
			</div>
		{/if}

		<div class="flex min-h-0 flex-1">
			<div class="relative min-w-0 flex-1">
				<!-- All three views are mounted; we toggle visibility so streams and
				     PDF viewer state survive view switches. -->
				<div class="absolute inset-0" class:hidden={mainView !== 'pdf'}>
					{#if isWebpage}
						<SourceViewer url={paper.sourceUrl!} paperId={paper.id} {reloadToken} />
					{:else}
						{#key paper.id}
							<PdfViewer
								path={paper.pdfPath}
								paperId={paper.id}
								threadSlug={paper.threadId ?? 'inbox'}
								arxivId={paper.arxivId}
							/>
						{/key}
					{/if}
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
					class="flex w-[260px] shrink-0 flex-col border-l border-border/60 bg-card lg:w-[300px] xl:w-[340px]"
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
									<div class="flex items-start justify-between gap-2">
										<h2 class="text-sm font-semibold leading-snug">{paper.title}</h2>
										<button
											class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
											onclick={copyPaperRef}
											title={refCopyState === 'failed'
												? 'Could not copy the reference'
												: `Copy reference: ${paper.arxivId} ("${paper.title}")`}
										>
											{#if refCopyState === 'copied'}
												<Check class="h-3.5 w-3.5" />
											{:else}
												<Copy class="h-3.5 w-3.5" />
											{/if}
										</button>
									</div>
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

								{#if isWebpage}
									<div>
										<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
											Published
										</div>
										<Input
											type="date"
											bind:value={publishedDateDraft}
											onblur={savePublishedDate}
											class="mt-2 h-8 text-xs"
										/>
									</div>
								{:else if paper.publishedDate}
									<div>
										<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
											Published
										</div>
										<p class="mt-2 text-xs">{formatPublishedDate(paper.publishedDate)}</p>
									</div>
								{/if}

								{#if isWebpage}
									<div>
										<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
											Abstract
										</div>
										<textarea
											bind:value={abstractDraft}
											onblur={saveAbstract}
											placeholder="What is this page about?"
											rows="5"
											class="mt-2 w-full resize-none rounded-md border border-border/60 bg-secondary/30 px-2 py-1.5 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-1 focus:ring-ring"
										></textarea>
									</div>
								{:else if paper.abstract}
									<div>
										<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
											Abstract
										</div>
										<p class="mt-2 text-xs leading-relaxed text-muted-foreground">
											{paper.abstract}
										</p>
									</div>
								{/if}

								<div>
									<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
										Links
									</div>
									{#if paper.links?.length}
										<ul class="mt-2 space-y-1">
											{#each paper.links as url (url)}
												<li class="group flex items-center gap-2">
													<button
														type="button"
														class="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border/60 bg-card px-2 py-1 text-left text-xs transition-colors hover:border-border hover:bg-card/80"
														onclick={() => openExternal(url)}
														title={url}
													>
														{#if isGithub(url)}
															<Github class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
														{:else}
															<ExternalLink class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
														{/if}
														<span class="truncate">{linkLabel(url)}</span>
													</button>
													<button
														type="button"
														class="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100"
														onclick={() => removeLink(url)}
														aria-label="Remove link"
													>
														<Trash2 class="h-3 w-3" />
													</button>
												</li>
											{/each}
										</ul>
									{/if}
									<form
										class="mt-2 flex gap-1"
										onsubmit={(e) => {
											e.preventDefault();
											void addLink();
										}}
									>
										<Input
											bind:value={newLink}
											placeholder="Add a link (GitHub, project page, blog…)"
											class="h-8 text-xs"
										/>
										<Button
											type="submit"
											size="sm"
											variant="outline"
											disabled={!normalizeUrl(newLink)}
										>
											Add
										</Button>
									</form>
								</div>

								<Separator />

								<div class="flex flex-wrap gap-2">
									{#if paper.arxivUrl}
										<Button
											size="sm"
											variant="outline"
											onclick={() => openExternal(paper.arxivUrl)}
										>
											<ExternalLink class="h-3.5 w-3.5" />
											{sourceSiteLabel}
										</Button>
										{#if isArxivSource}
											<Button
												size="sm"
												variant="outline"
												onclick={() => openExternal(toAlphaxivUrl(paper.arxivUrl))}
												title="Open this paper on AlphaXiv"
											>
												<Globe class="h-3.5 w-3.5" />
												AlphaXiv
											</Button>
										{/if}
									{/if}
									{#if paper.sourceUrl}
										<Button
											size="sm"
											variant="outline"
											onclick={() => openExternal(paper.sourceUrl!)}
										>
											<Globe class="h-3.5 w-3.5" />
											Open source
										</Button>
									{/if}
									{#if paper.pdfPath}
										<Button
											size="sm"
											variant="outline"
											onclick={copyPaperPath}
											title={pathCopyState === 'failed' ? 'Could not copy the path' : paper.pdfPath}
										>
											{#if pathCopyState === 'copied'}
												<Check class="h-3.5 w-3.5" />
												Copied
											{:else}
												<Copy class="h-3.5 w-3.5" />
												{pathCopyState === 'failed' ? 'Copy failed' : 'Copy path'}
											{/if}
										</Button>
										<Button
											size="sm"
											variant="outline"
											onclick={() => revealInFinder(paper.pdfPath)}
										>
											<FolderOpen class="h-3.5 w-3.5" />
											Reveal in Finder
										</Button>
									{/if}
								</div>

								<Separator />

								<div>
									<Button
										size="sm"
										variant="ghost"
										class="text-destructive hover:bg-destructive/10 hover:text-destructive"
										onclick={deletePaper}
										disabled={deleting}
										title="Permanently delete this paper, its PDF, notes, and chats"
									>
										<Trash2 class="h-3.5 w-3.5" />
										{deleting ? 'Deleting…' : 'Delete paper'}
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
