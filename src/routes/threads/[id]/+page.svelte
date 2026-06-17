<script lang="ts">
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { papers, threads, threadChildren, threadAncestors, ui } from '$lib/stores.svelte';
	import { Button, Dialog, Input } from '$lib/components/ui';
	import { goto } from '$app/navigation';
	import {
		Plus,
		Trash2,
		Archive,
		ArchiveRestore,
		MessageSquare,
		ChevronDown,
		ChevronRight,
		FolderTree
	} from 'lucide-svelte';
	import type { ReadingStatus, Thread, ThreadStatus } from '$lib/types';
	import PaperCard from '$lib/components/PaperCard.svelte';
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

	let search = $state('');
	let sortBy = $state<'order' | 'added' | 'published' | 'title' | 'rating'>('order');
	let viewMode = $state<'library' | 'status'>('library');

	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		const stored = localStorage.getItem('reos:threadViewMode');
		if (stored === 'library' || stored === 'status') {
			untrack(() => (viewMode = stored));
		}
	});

	function setViewMode(mode: 'library' | 'status') {
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
			? `Permanently delete thread "${thread.title}" and its ${subCount} sub-thread${subCount === 1 ? '' : 's'}?\n\nThis will:\n• Delete this thread, its synthesis notes, and its chats\n• Delete all ${subCount} nested sub-thread${subCount === 1 ? '' : 's'} (and their syntheses and chats)\n• Move every paper inside back to the inbox — papers, PDFs, notes, and annotations are kept\n• Remove the thread folders from disk\n\nThis cannot be undone.`
			: `Permanently delete thread "${thread.title}"?\n\nThis will:\n• Delete this thread, its synthesis notes, and its chats\n• Move its papers back to the inbox — papers, PDFs, notes, and annotations are kept\n• Remove the thread folder from disk\n\nThis cannot be undone.`;
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
		<header>
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div class="relative min-w-0 flex-1 basis-full lg:basis-0">
					<span class="pointer-events-none absolute -top-5 left-0 text-[10px] text-muted-foreground">
						created {thread.createdAt.slice(0, 10)}
					</span>
					<input
						class="w-full bg-transparent font-mono text-2xl font-light tracking-tight text-foreground focus:outline-none"
						value={thread.title}
						onblur={(e) => threads.update(thread.id, { title: e.currentTarget.value })}
					/>
					<textarea
						class="w-full resize-none bg-transparent text-sm text-muted-foreground focus:outline-none"
						placeholder="What question does this thread explore?"
						value={thread.question}
						rows={1}
						onblur={(e) => threads.update(thread.id, { question: e.currentTarget.value })}
					></textarea>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<Button
						variant="subtle"
						onclick={() => {
							ui.openThreadChat(thread.id);
							goto(`/threads/${thread.id}/chat`);
						}}
					>
						<MessageSquare class="h-4 w-4" />
						Chat
					</Button>
					<Button onclick={openAddPaper}>
						<Plus class="h-4 w-4" />
						Add paper
					</Button>
					<label class="thread-status-select group">
						<select
							value={thread.status}
							onchange={(e) => setStatus(e.currentTarget.value as ThreadStatus)}
						>
							<option value="active">Active</option>
							<option value="paused">Paused</option>
							<option value="concluded">Concluded</option>
							<option value="archived">Archived</option>
						</select>
						<ChevronDown
							class="pointer-events-none h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-foreground"
						/>
					</label>
					<div class="ml-1 flex items-center rounded-[10px] border border-border/60 bg-secondary/30 p-0.5 shadow-[inset_0_1px_0_0_hsl(var(--panel-highlight)/0.3)]">
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

		<section class="!mt-2 space-y-2">
				<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					Sub-threads
					{#if subThreads.length > 0}
						<span class="ml-2 font-mono text-[10px] text-muted-foreground/80">{subThreads.length}</span>
					{/if}
				</h3>
				<div class="flex flex-wrap gap-2">
					{#each subThreads as st (st.id)}
						{@const stChildren = threadChildren(st.id).length}
						{@const isDropTarget = dropTargetThreadId === st.id}
						<button
							class={cn(
								'rounded-md border bg-card px-2.5 py-1.5 text-left transition-colors',
								isDropTarget
									? 'border-accent bg-accent/10 ring-2 ring-accent/50'
									: 'border-border/60 hover:border-border hover:bg-card/80'
							)}
							onclick={(e) => openThread(st.id, e)}
							ondragover={(e) => onSubThreadDragOver(e, st.id)}
							ondragleave={(e) => onSubThreadDragLeave(e, st.id)}
							ondrop={(e) => onSubThreadDrop(e, st.id)}
						>
							<div class="flex items-center gap-2">
								<span class="h-1.5 w-1.5 rounded-full {st.status === 'active' ? 'bg-accent' : st.status === 'paused' ? 'bg-yellow-500' : 'bg-muted-foreground/60'}"></span>
								<span class="line-clamp-1 text-xs font-medium">{st.title}</span>
							</div>
							<div class="mt-0.5 text-[10px] text-muted-foreground">
								{st.papers.length} papers{#if stChildren > 0} · {stChildren} sub{/if}
							</div>
						</button>
					{/each}
					<button
						class="rounded-md border border-dashed border-border/60 bg-transparent px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-secondary/30 hover:text-foreground"
						onclick={openNewSubThread}
					>
						<Plus class="inline h-3 w-3" />
						New sub-thread
					</button>
				</div>
			</section>

		<div class="!mt-2 flex flex-wrap items-center gap-2">
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
					Library
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
