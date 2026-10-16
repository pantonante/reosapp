<script lang="ts">
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { papers, threads, threadChildren, threadAncestors, ui } from '$lib/stores.svelte';
	import { Badge, Button, Dialog, Input } from '$lib/components/ui';
	import { goto } from '$app/navigation';
	import {
		Plus,
		Trash2,
		Archive,
		ArchiveRestore,
		ChevronRight,
		FolderTree,
		LibraryBig,
		MessagesSquare,
		NotebookPen
	} from 'lucide-svelte';
	import type { ReadingStatus, Thread, ThreadStatus } from '$lib/types';
	import PaperCard from '$lib/components/PaperCard.svelte';
	import { renderTitleHtml } from '$lib/utils/render-title';
	import ThreadNotes from '$lib/components/ThreadNotes.svelte';
	import ThreadChatList from '$lib/components/ThreadChatList.svelte';
	import { cn } from '$lib/utils/cn';
	import { ask } from '@tauri-apps/plugin-dialog';

	const id = $derived(page.params.id!);
	const thread = $derived(threads.get(id));

	const ancestors = $derived(thread ? threadAncestors(thread.id) : []);
	const subThreads = $derived(thread ? threadChildren(thread.id) : []);

	let movePickerOpen = $state(false);

	// Valid parent options: any thread that isn't self or a descendant. Inbox excluded.
	const parentOptions = $derived.by<Thread[]>(() => {
		if (!thread) return [];
		const excluded = new Set<string>([thread.id, ...threads.descendantIds(thread.id)]);
		return threads.items.filter((t) => !excluded.has(t.id));
	});

	$effect(() => {
		if (id) untrack(() => ui.openThread(id));
	});

	type ThreadTab = 'library' | 'notes' | 'chats';
	const TABS = [
		{ value: 'library', label: 'Library', icon: LibraryBig },
		{ value: 'notes', label: 'Notes', icon: NotebookPen },
		{ value: 'chats', label: 'Chats', icon: MessagesSquare }
	] as const;

	// Remembered per thread, like the paper page's last view.
	const tabKey = (tid: string) => `reos:threadTab:${tid}`;
	let tab = $state<ThreadTab>('library');

	$effect(() => {
		const tid = id;
		untrack(() => {
			let stored: string | null = null;
			try {
				stored = localStorage.getItem(tabKey(tid));
			} catch {
				// storage unavailable — fall back to Library
			}
			tab = stored === 'chats' || stored === 'notes' ? stored : 'library';
		});
	});

	function setTab(next: ThreadTab) {
		tab = next;
		try {
			localStorage.setItem(tabKey(id), next);
		} catch {
			// best effort
		}
	}

	let search = $state('');
	let sortBy = $state<'order' | 'added' | 'published' | 'title' | 'rating'>('order');
	let viewMode = $state<'library' | 'list' | 'status'>('library');

	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		const stored = localStorage.getItem('reos:threadViewMode');
		if (stored === 'library' || stored === 'list' || stored === 'status') {
			untrack(() => (viewMode = stored));
		}
	});

	function setViewMode(mode: 'library' | 'list' | 'status') {
		viewMode = mode;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('reos:threadViewMode', mode);
		}
	}

	const threadPapers = $derived.by(() =>
		(thread?.papers ?? []).map((tp) => papers.get(tp.paperId)).filter(Boolean)
	);

	const filteredPapers = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const list = threadPapers.filter((p) => {
			if (!p) return false;
			if (!q) return true;
			const hay = `${p.title} ${p.authors.join(' ')} ${p.arxivId}`.toLowerCase();
			return hay.includes(q);
		});
		const sorted = [...list];
		switch (sortBy) {
			case 'added':
				sorted.sort((a, b) => (a!.addedAt > b!.addedAt ? -1 : 1));
				break;
			case 'published':
				sorted.sort((a, b) => (a!.publishedDate > b!.publishedDate ? -1 : 1));
				break;
			case 'title':
				sorted.sort((a, b) => a!.title.localeCompare(b!.title));
				break;
			case 'rating':
				sorted.sort((a, b) => (b!.rating ?? -1) - (a!.rating ?? -1));
				break;
			default:
				break;
		}
		return sorted;
	});

	const cols: { status: ReadingStatus; label: string }[] = [
		{ status: 'unread', label: 'Unread' },
		{ status: 'reading', label: 'Reading' },
		{ status: 'read', label: 'Read' }
	];

	function papersByStatus(status: ReadingStatus) {
		return filteredPapers.filter((p) => p && p.readingStatus === status);
	}

	async function setStatus(threadStatus: ThreadStatus) {
		if (!thread) return;
		await threads.update(thread.id, { status: threadStatus });
	}

	function openAddPaper() {
		if (!thread) return;
		ui.addPaperTargetThreadId = thread.id;
		ui.addPaperOpen = true;
	}

	async function removePaper(paperId: string) {
		if (!thread) return;
		const p = papers.get(paperId);
		const title = p?.title ?? 'this paper';
		const ok = await ask(
			`Move "${title}" out of "${thread.title}" and back to the inbox? The paper, its PDF, notes, and chats are kept — only the thread membership is removed.`,
			{
				title: 'Remove from thread',
				kind: 'warning',
				okLabel: 'Move to inbox',
				cancelLabel: 'Cancel'
			}
		);
		if (!ok) return;
		await papers.move(paperId, 'inbox');
	}

	async function deleteThread() {
		if (!thread) return;
		const subCount = subThreads.length;
		const msg = subCount
			? `Permanently delete thread "${thread.title}" and its ${subCount} sub-thread${subCount === 1 ? '' : 's'}?\n\nThis will:\n• Delete this thread, its notes, synthesis, and chats\n• Delete all ${subCount} nested sub-thread${subCount === 1 ? '' : 's'} (and their notes, syntheses, and chats)\n• Move every paper inside back to the inbox — papers, PDFs, notes, and annotations are kept\n• Remove the thread folders from disk\n\nThis cannot be undone.`
			: `Permanently delete thread "${thread.title}"?\n\nThis will:\n• Delete this thread, its notes, synthesis, and chats\n• Move its papers back to the inbox — papers, PDFs, notes, and annotations are kept\n• Remove the thread folder from disk\n\nThis cannot be undone.`;
		const ok = await ask(msg, {
			title: 'Delete thread',
			kind: 'warning',
			okLabel: 'Delete',
			cancelLabel: 'Cancel'
		});
		if (!ok) return;
		const tid = thread.id;
		ui.closeThread(tid);
		await threads.remove(tid);
		goto('/threads');
	}

	function openPaper(pid: string, e?: MouseEvent) {
		const newTab = !!(e && (e.metaKey || e.ctrlKey));
		ui.openPaper(pid, { newTab });
		goto(`/paper/${pid}`);
	}

	function openNewSubThread() {
		if (!thread) return;
		ui.newThreadParentId = thread.id;
		ui.newThreadOpen = true;
	}

	function openThread(tid: string, e?: MouseEvent) {
		const newTab = !!(e && (e.metaKey || e.ctrlKey));
		ui.openThread(tid, { newTab });
		goto(`/threads/${tid}`);
	}

	async function setParent(newParent: string | null) {
		if (!thread) return;
		try {
			await threads.update(thread.id, { parentId: newParent });
			movePickerOpen = false;
		} catch (err) {
			alert(err instanceof Error ? err.message : String(err));
		}
	}

	const PAPER_DRAG_MIME = 'application/x-reos-paper-id';
	let dropTargetThreadId = $state<string | null>(null);
	let dropTargetStatus = $state<ReadingStatus | null>(null);

	function onPaperDragStart(e: DragEvent, paperId: string) {
		if (!e.dataTransfer) return;
		e.dataTransfer.setData(PAPER_DRAG_MIME, paperId);
		e.dataTransfer.setData('text/plain', paperId);
		e.dataTransfer.effectAllowed = 'move';
	}

	function onSubThreadDragOver(e: DragEvent, subThreadId: string) {
		if (!e.dataTransfer?.types.includes(PAPER_DRAG_MIME)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		if (dropTargetThreadId !== subThreadId) dropTargetThreadId = subThreadId;
	}

	function onSubThreadDragLeave(e: DragEvent, subThreadId: string) {
		// Ignore enter/leave bubbling from children inside the card.
		const related = e.relatedTarget as Node | null;
		if (related && (e.currentTarget as HTMLElement).contains(related)) return;
		if (dropTargetThreadId === subThreadId) dropTargetThreadId = null;
	}

	async function onSubThreadDrop(e: DragEvent, subThreadId: string) {
		const paperId = e.dataTransfer?.getData(PAPER_DRAG_MIME);
		dropTargetThreadId = null;
		if (!paperId) return;
		e.preventDefault();
		await papers.move(paperId, subThreadId);
	}

	function onStatusDragOver(e: DragEvent, status: ReadingStatus) {
		if (!e.dataTransfer?.types.includes(PAPER_DRAG_MIME)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		if (dropTargetStatus !== status) dropTargetStatus = status;
	}

	function onStatusDragLeave(e: DragEvent, status: ReadingStatus) {
		const related = e.relatedTarget as Node | null;
		if (related && (e.currentTarget as HTMLElement).contains(related)) return;
		if (dropTargetStatus === status) dropTargetStatus = null;
	}

	async function onStatusDrop(e: DragEvent, status: ReadingStatus) {
		const paperId = e.dataTransfer?.getData(PAPER_DRAG_MIME);
		dropTargetStatus = null;
		if (!paperId) return;
		e.preventDefault();
		const current = papers.get(paperId);
		if (!current || current.readingStatus === status) return;
		await papers.update(paperId, { readingStatus: status });
	}
</script>

{#if !thread}
	<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
		Thread not found.
	</div>
{:else}
	<div class="space-y-6 p-4 sm:p-8">
		<header class="space-y-1">
			<div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
				<div class="relative min-w-0 flex-1 basis-full lg:basis-0">
					<span class="pointer-events-none absolute -top-5 left-0 text-[10px] text-muted-foreground">
						created {thread.createdAt.slice(0, 10)}
					</span>
					<input
						class="w-full bg-transparent font-mono text-2xl font-light tracking-tight text-foreground focus:outline-none"
						value={thread.title}
						onblur={(e) => threads.update(thread.id, { title: e.currentTarget.value })}
					/>
				</div>
				<div class="flex flex-wrap items-center gap-3">
					<div
						class="flex items-center rounded-[10px] border border-border/60 bg-secondary/30 p-0.5 shadow-[inset_0_1px_0_0_hsl(var(--panel-highlight)/0.3)]"
						role="tablist"
						aria-label="Thread sections"
					>
						{#each TABS as t (t.value)}
							<button
								type="button"
								role="tab"
								aria-selected={tab === t.value}
								class={cn(
									'flex h-8 items-center gap-1.5 rounded-[8px] px-3 text-sm font-medium transition-colors',
									tab === t.value
										? 'bg-secondary text-foreground shadow-[inset_0_1px_0_0_hsl(var(--panel-highlight)/0.4)]'
										: 'text-muted-foreground hover:text-foreground'
								)}
								onclick={() => setTab(t.value)}
							>
								<t.icon class="h-4 w-4" />
								{t.label}
							</button>
						{/each}
					</div>
					<div class="flex items-center rounded-[10px] border border-border/60 bg-secondary/30 p-0.5 shadow-[inset_0_1px_0_0_hsl(var(--panel-highlight)/0.3)]">
						<Button
							variant="ghost"
							size="icon"
							class="h-8 w-8 rounded-[8px]"
							onclick={() => (movePickerOpen = true)}
							aria-label="Move thread"
							title="Move thread"
						>
							<FolderTree class="h-4 w-4" />
						</Button>
						{#if thread.status === 'archived'}
							<Button
								variant="ghost"
								size="icon"
								class="h-8 w-8 rounded-[8px]"
								onclick={() => setStatus('active')}
								aria-label="Unarchive thread"
								title="Unarchive"
							>
								<ArchiveRestore class="h-4 w-4" />
							</Button>
						{:else}
							<Button
								variant="ghost"
								size="icon"
								class="h-8 w-8 rounded-[8px]"
								onclick={() => setStatus('archived')}
								aria-label="Archive thread"
								title="Archive"
							>
								<Archive class="h-4 w-4" />
							</Button>
						{/if}
						<Button
							variant="ghost"
							size="icon"
							class="h-8 w-8 rounded-[8px] hover:text-destructive"
							onclick={deleteThread}
							aria-label="Delete thread"
							title="Delete"
						>
							<Trash2 class="h-4 w-4" />
						</Button>
					</div>
				</div>
			</div>
			<textarea
				class="w-full resize-none bg-transparent text-sm text-muted-foreground focus:outline-none"
				placeholder="What question does this thread explore?"
				value={thread.question}
				rows={2}
				onblur={(e) => threads.update(thread.id, { question: e.currentTarget.value })}
			></textarea>
		</header>

		{#if ancestors.length > 0}
			<nav class="!mt-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground" aria-label="Thread ancestors">
				{#each ancestors as a (a.id)}
					<button
						type="button"
						class="rounded px-1.5 py-0.5 transition-colors hover:bg-secondary/40 hover:text-foreground"
						onclick={(e) => openThread(a.id, e)}
					>
						{a.title}
					</button>
					<ChevronRight class="h-3 w-3 text-muted-foreground/60" />
				{/each}
				<span class="px-1.5 py-0.5 text-foreground">{thread.title}</span>
			</nav>
		{/if}

		<section class="!mt-2 flex flex-wrap items-center gap-1.5" aria-label="Sub-threads">
			<span class="mr-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				Sub-threads
			</span>
			{#each subThreads as st (st.id)}
				{@const stChildren = threadChildren(st.id).length}
				{@const isDropTarget = dropTargetThreadId === st.id}
				<button
					class={cn(
						'flex h-7 max-w-[18rem] items-center gap-1.5 rounded-md border bg-card px-2 text-xs transition-colors',
						isDropTarget
							? 'border-accent bg-accent/10 ring-2 ring-accent/50'
							: 'border-border/60 hover:border-border hover:bg-card/80'
					)}
					title="{st.title} · {st.papers.length} papers{stChildren > 0 ? ` · ${stChildren} sub-threads` : ''}"
					onclick={(e) => openThread(st.id, e)}
					ondragover={(e) => onSubThreadDragOver(e, st.id)}
					ondragleave={(e) => onSubThreadDragLeave(e, st.id)}
					ondrop={(e) => onSubThreadDrop(e, st.id)}
				>
					<span class="h-1.5 w-1.5 shrink-0 rounded-full {st.status === 'active' ? 'bg-accent' : st.status === 'paused' ? 'bg-yellow-500' : 'bg-muted-foreground/60'}"></span>
					<span class="truncate font-medium">{st.title}</span>
					<span class="shrink-0 font-mono text-[10px] text-muted-foreground">{st.papers.length}</span>
				</button>
			{/each}
			<button
				class="flex h-7 items-center gap-1 rounded-md border border-dashed border-border/60 bg-transparent px-2 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-secondary/30 hover:text-foreground"
				onclick={openNewSubThread}
				title="New sub-thread"
			>
				<Plus class="h-3 w-3" />
				New
			</button>
		</section>

		{#if tab === 'notes'}
			<ThreadNotes threadSlug={thread.id} />
		{:else if tab === 'chats'}
			<ThreadChatList threadSlug={thread.id} />
		{:else if tab === 'library'}
		<div class="space-y-6">
		<div class="flex flex-wrap items-center gap-2">
			<Input
				bind:value={search}
				placeholder="Filter title, authors, arxiv ID…"
				class="max-w-xs"
			/>
			<div class="flex items-center rounded-md border border-input bg-background p-0.5 sm:ml-auto">
				<button
					type="button"
					class={cn(
						'h-7 rounded px-3 text-xs font-medium transition-colors',
						viewMode === 'library'
							? 'bg-secondary text-foreground'
							: 'text-muted-foreground hover:text-foreground'
					)}
					onclick={() => setViewMode('library')}
				>
					Grid
				</button>
				<button
					type="button"
					class={cn(
						'h-7 rounded px-3 text-xs font-medium transition-colors',
						viewMode === 'list'
							? 'bg-secondary text-foreground'
							: 'text-muted-foreground hover:text-foreground'
					)}
					onclick={() => setViewMode('list')}
				>
					List
				</button>
				<button
					type="button"
					class={cn(
						'h-7 rounded px-3 text-xs font-medium transition-colors',
						viewMode === 'status'
							? 'bg-secondary text-foreground'
							: 'text-muted-foreground hover:text-foreground'
					)}
					onclick={() => setViewMode('status')}
				>
					Status
				</button>
			</div>
			<select
				class="h-9 rounded-md border border-input bg-background px-3 text-sm"
				bind:value={sortBy}
			>
				<option value="order">Thread order</option>
				<option value="added">Recently added</option>
				<option value="published">Published date</option>
				<option value="title">Title</option>
				<option value="rating">Rating</option>
			</select>
			<Button onclick={openAddPaper}>
				<Plus class="h-4 w-4" />
				Add paper
			</Button>
		</div>

		{#if viewMode === 'library'}
			<div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
				{#each filteredPapers as p (p?.id)}
					{#if p}
						<div
							class="group relative cursor-grab active:cursor-grabbing"
							draggable="true"
							role="button"
							tabindex="-1"
							ondragstart={(e) => onPaperDragStart(e, p.id)}
						>
							<PaperCard paper={p} compact onclick={(e) => openPaper(p.id, e)} />
							<button
								class="absolute right-2 top-2 rounded p-1 opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100"
								onclick={() => removePaper(p.id)}
								aria-label="Remove from thread"
							>
								<Trash2 class="h-3 w-3" />
							</button>
						</div>
					{/if}
				{/each}
			</div>
		{:else if viewMode === 'list'}
			<div class="overflow-x-auto rounded-md border border-border/60">
				<table class="w-full text-sm">
					<thead class="border-b border-border/60 bg-muted/30 text-xs text-muted-foreground">
						<tr>
							<th class="px-3 py-2 text-left font-medium">Title</th>
							<th class="px-3 py-2 text-left font-medium">Authors</th>
							<th class="px-3 py-2 text-left font-medium">Published</th>
							<th class="px-3 py-2 text-left font-medium">Status</th>
							<th class="px-3 py-2 text-left font-medium">Rating</th>
							<th class="w-8 px-2 py-2"><span class="sr-only">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each filteredPapers as p (p?.id)}
							{#if p}
								<tr
									class="group cursor-pointer border-b border-border/40 last:border-b-0 hover:bg-accent/5"
									draggable="true"
									ondragstart={(e) => onPaperDragStart(e, p.id)}
									onclick={(e) => openPaper(p.id, e)}
								>
									<td class="px-3 py-2">
										<div class="paper-title line-clamp-2 font-medium">{@html renderTitleHtml(p.title)}</div>
										<div class="font-mono text-[10px] text-muted-foreground">{p.arxivId}</div>
									</td>
									<td class="px-3 py-2 text-xs text-muted-foreground">
										{p.authors.slice(0, 2).join(', ')}{p.authors.length > 2 ? ' et al.' : ''}
									</td>
									<td class="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
										{p.publishedDate?.slice(0, 10) || '—'}
									</td>
									<td class="px-3 py-2">
										<Badge variant="outline">{p.readingStatus}</Badge>
									</td>
									<td class="whitespace-nowrap px-3 py-2 text-xs text-amber-500">
										{p.rating ? '★'.repeat(p.rating) : '—'}
									</td>
									<td class="px-2 py-2">
										<button
											class="rounded p-1 opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
											onclick={(e) => {
												e.stopPropagation();
												removePaper(p.id);
											}}
											aria-label="Remove from thread"
											title="Remove from thread"
										>
											<Trash2 class="h-3 w-3" />
										</button>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<div class="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
				{#each cols as col (col.status)}
					{@const isStatusDropTarget = dropTargetStatus === col.status}
					<div
						class={cn(
							'rounded-md p-1 transition-colors',
							isStatusDropTarget
								? 'bg-accent/10 ring-2 ring-accent/50'
								: 'ring-2 ring-transparent'
						)}
						role="region"
						aria-label="{col.label} papers"
						ondragover={(e) => onStatusDragOver(e, col.status)}
						ondragleave={(e) => onStatusDragLeave(e, col.status)}
						ondrop={(e) => onStatusDrop(e, col.status)}
					>
						<h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							{col.label}
							<span class="ml-2 font-mono text-[10px] text-muted-foreground/80">
								{papersByStatus(col.status).length}
							</span>
						</h3>
						<div class="min-h-[3rem] space-y-2">
							{#each papersByStatus(col.status) as p (p?.id)}
								{#if p}
									<div
										class="group relative cursor-grab active:cursor-grabbing"
										draggable="true"
										role="button"
										tabindex="-1"
										ondragstart={(e) => onPaperDragStart(e, p.id)}
									>
										<PaperCard paper={p} compact onclick={(e) => openPaper(p.id, e)} />
										<button
											class="absolute right-2 top-2 rounded p-1 opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100"
											onclick={() => removePaper(p.id)}
											aria-label="Remove from thread"
										>
											<Trash2 class="h-3 w-3" />
										</button>
									</div>
								{/if}
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{/if}
		</div>
		{/if}


	</div>

	<Dialog
		bind:open={movePickerOpen}
		title="Move thread"
		description="Choose a parent thread, or make this a root thread."
	>
		<div class="space-y-2">
			<button
				type="button"
				class="flex w-full items-center justify-between rounded-md border border-border/60 px-3 py-2 text-left text-sm transition-colors hover:bg-secondary/40 disabled:cursor-not-allowed disabled:opacity-50"
				disabled={!thread.parentId}
				onclick={() => setParent(null)}
			>
				<span>(None — make root thread)</span>
				{#if !thread.parentId}
					<span class="text-[10px] text-muted-foreground">current</span>
				{/if}
			</button>
			<div class="max-h-72 space-y-1 overflow-y-auto">
				{#each parentOptions as opt (opt.id)}
					{@const isCurrent = thread.parentId === opt.id}
					{@const optAncestors = threadAncestors(opt.id)}
					<button
						type="button"
						class="flex w-full items-center justify-between rounded-md border border-border/60 px-3 py-2 text-left text-sm transition-colors hover:bg-secondary/40 disabled:cursor-not-allowed disabled:opacity-50"
						disabled={isCurrent}
						onclick={() => setParent(opt.id)}
					>
						<span class="min-w-0 truncate">
							{#if optAncestors.length > 0}
								<span class="text-muted-foreground">
									{optAncestors.map((a) => a.title).join(' › ')} ›
								</span>
							{/if}
							{opt.title}
						</span>
						{#if isCurrent}
							<span class="text-[10px] text-muted-foreground">current</span>
						{/if}
					</button>
				{/each}
				{#if parentOptions.length === 0}
					<div class="rounded-md border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
						No other threads available.
					</div>
				{/if}
			</div>
		</div>
	</Dialog>
{/if}
