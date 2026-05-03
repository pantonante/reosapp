<script lang="ts">
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { papers, threads, ui } from '$lib/stores.svelte';
	import { Button, Badge, Card, Dialog, Input } from '$lib/components/ui';
	import { goto } from '$app/navigation';
	import { Plus, Trash2 } from 'lucide-svelte';
	import type { ReadingStatus, ThreadStatus } from '$lib/types';
	import PaperCard from '$lib/components/PaperCard.svelte';

	const id = $derived(page.params.id!);
	const thread = $derived(threads.get(id));

	let addPapersOpen = $state(false);
	let paperSearch = $state('');

	$effect(() => {
		if (id) untrack(() => ui.openThread(id));
	});

	const threadPapers = $derived.by(() =>
		(thread?.papers ?? []).map((tp) => papers.get(tp.paperId)).filter(Boolean)
	);

	const eligible = $derived.by(() => {
		const q = paperSearch.trim().toLowerCase();
		const owned = new Set(thread?.papers.map((p) => p.paperId) ?? []);
		return papers.items
			.filter((p) => !owned.has(p.id))
			.filter((p) => !q || `${p.title} ${p.arxivId}`.toLowerCase().includes(q));
	});

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

	async function addPaper(paperId: string) {
		if (!thread) return;
		const next = {
			...thread,
			papers: [
				...thread.papers,
				{ paperId, contextNote: '', order: thread.papers.length }
			]
		};
		await threads.update(thread.id, next);
	}

	async function removePaper(paperId: string) {
		if (!thread) return;
		await threads.update(thread.id, {
			papers: thread.papers.filter((p) => p.paperId !== paperId)
		});
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
					<select
						class="h-9 rounded-md border border-input bg-background px-3 text-sm"
						value={thread.status}
						onchange={(e) => setStatus(e.currentTarget.value as ThreadStatus)}
					>
						<option value="active">Active</option>
						<option value="paused">Paused</option>
						<option value="concluded">Concluded</option>
					</select>
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

		<div class="flex justify-end">
			<Button onclick={() => (addPapersOpen = true)}>
				<Plus class="h-4 w-4" />
				Add paper
			</Button>
		</div>

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

	<Dialog bind:open={addPapersOpen} title="Add papers to thread">
		<Input bind:value={paperSearch} placeholder="Search papers in your library…" />
		<div class="max-h-80 space-y-1 overflow-y-auto">
			{#each eligible as p (p.id)}
				<button
					class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/10"
					onclick={() => addPaper(p.id)}
				>
					<span class="flex-1 truncate">{p.title}</span>
					<span class="font-mono text-[10px] text-muted-foreground">{p.arxivId}</span>
				</button>
			{:else}
				<p class="px-2 py-4 text-center text-xs text-muted-foreground">No matching papers.</p>
			{/each}
		</div>
	</Dialog>
{/if}
