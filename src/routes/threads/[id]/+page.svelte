<script lang="ts">
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { papers, threads, ui } from '$lib/stores.svelte';
	import { Button, Input } from '$lib/components/ui';
	import { goto } from '$app/navigation';
	import {
		Plus,
		Trash2,
		Archive,
		ArchiveRestore,
		MessageSquare,
		ChevronDown
	} from 'lucide-svelte';
	import type { ReadingStatus, ThreadStatus } from '$lib/types';
	import PaperCard from '$lib/components/PaperCard.svelte';

	const id = $derived(page.params.id!);
	const thread = $derived(threads.get(id));

	$effect(() => {
		if (id) untrack(() => ui.openThread(id));
	});

	let search = $state('');
	let sortBy = $state<'order' | 'added' | 'published' | 'title' | 'rating'>('order');

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
		await papers.move(paperId, 'inbox');
	}

	async function deleteThread() {
		if (!thread) return;
		if (!confirm(`Delete thread "${thread.title}"? Papers stay in your library.`)) return;
		const tid = thread.id;
		ui.closeThread(tid);
		await threads.remove(tid);
		goto('/threads');
	}

	function openPaper(pid: string) {
		ui.openPaper(pid);
		goto(`/paper/${pid}`);
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
					<Button variant="subtle" onclick={() => goto(`/threads/${thread.id}/chat`)}>
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

		<div class="!mt-2 flex flex-wrap items-center gap-2">
			<Input
				bind:value={search}
				placeholder="Filter title, authors, arxiv ID…"
				class="max-w-xs"
			/>
			<select
				class="h-9 rounded-md border border-input bg-background px-3 text-sm sm:ml-auto"
				bind:value={sortBy}
			>
				<option value="order">Thread order</option>
				<option value="added">Recently added</option>
				<option value="published">Published date</option>
				<option value="title">Title</option>
				<option value="rating">Rating</option>
			</select>
		</div>

		<div class="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
			{#each cols as col (col.status)}
				<div>
					<h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
						{col.label}
						<span class="ml-2 font-mono text-[10px] text-muted-foreground/80">
							{papersByStatus(col.status).length}
						</span>
					</h3>
					<div class="space-y-2">
						{#each papersByStatus(col.status) as p (p?.id)}
							{#if p}
								<div class="group relative">
									<PaperCard paper={p} compact onclick={() => openPaper(p.id)} />
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

	</div>
{/if}
