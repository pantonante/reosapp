<script lang="ts">
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { papers, threads, ui } from '$lib/stores.svelte';
	import { Button, Badge } from '$lib/components/ui';
	import { goto } from '$app/navigation';
	import { Plus, Trash2, Archive, ArchiveRestore } from 'lucide-svelte';
	import type { ReadingStatus, ThreadStatus } from '$lib/types';
	import PaperCard from '$lib/components/PaperCard.svelte';

	const id = $derived(page.params.id!);
	const thread = $derived(threads.get(id));

	$effect(() => {
		if (id) untrack(() => ui.openThread(id));
	});

	const threadPapers = $derived.by(() =>
		(thread?.papers ?? []).map((tp) => papers.get(tp.paperId)).filter(Boolean)
	);

	const cols: { status: ReadingStatus; label: string }[] = [
		{ status: 'unread', label: 'Unread' },
		{ status: 'reading', label: 'Reading' },
		{ status: 'read', label: 'Read' }
	];

	function papersByStatus(status: ReadingStatus) {
		return threadPapers.filter((p) => p && p.readingStatus === status);
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
	<div class="space-y-6 p-8">
		<header>
			<div class="flex items-start justify-between gap-4">
				<div class="flex-1">
					<input
						class="w-full bg-transparent font-mono text-2xl font-light tracking-tight text-foreground focus:outline-none"
						value={thread.title}
						onblur={(e) => threads.update(thread.id, { title: e.currentTarget.value })}
					/>
					<textarea
						class="mt-1 w-full resize-none bg-transparent text-sm text-muted-foreground focus:outline-none"
						placeholder="What question does this thread explore?"
						value={thread.question}
						rows={2}
						onblur={(e) => threads.update(thread.id, { question: e.currentTarget.value })}
					></textarea>
				</div>
				<div class="flex items-center gap-2">
					<Button onclick={openAddPaper}>
						<Plus class="h-4 w-4" />
						Add paper
					</Button>
					<select
						class="h-9 rounded-md border border-input bg-background px-3 text-sm"
						value={thread.status}
						onchange={(e) => setStatus(e.currentTarget.value as ThreadStatus)}
					>
						<option value="active">Active</option>
						<option value="paused">Paused</option>
						<option value="concluded">Concluded</option>
						<option value="archived">Archived</option>
					</select>
					{#if thread.status === 'archived'}
						<Button
							variant="ghost"
							size="icon"
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
							onclick={() => setStatus('archived')}
							aria-label="Archive thread"
							title="Archive"
						>
							<Archive class="h-4 w-4" />
						</Button>
					{/if}
					<Button variant="ghost" size="icon" onclick={deleteThread} aria-label="Delete thread">
						<Trash2 class="h-4 w-4" />
					</Button>
				</div>
			</div>
			<div class="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
				<Badge variant="outline">{thread.papers.length} papers</Badge>
				<span>created {thread.createdAt.slice(0, 10)}</span>
			</div>
		</header>

		<div class="grid gap-6 lg:grid-cols-3">
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

		<!-- TODO: thread chat panel -->
	</div>
{/if}
