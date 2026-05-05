<script lang="ts">
	import { papers, threads, ui } from '$lib/stores.svelte';
	import { Button, Card, Input } from '$lib/components/ui';
	import { goto } from '$app/navigation';
	import { Plus, LayoutGrid, Rows3 } from 'lucide-svelte';
	import type { Thread, ThreadStatus } from '$lib/types';

	const cols: { status: ThreadStatus; label: string }[] = [
		{ status: 'active', label: 'Active' },
		{ status: 'paused', label: 'Paused' },
		{ status: 'concluded', label: 'Concluded' }
	];

	let search = $state('');
	let sortBy = $state<'created' | 'lastPaper' | 'name' | 'papers'>('created');

	const nonArchived = $derived(threads.items.filter((t) => t.status !== 'archived'));

	function lastPaperAddedAt(t: Thread): number {
		let max = 0;
		for (const tp of t.papers) {
			const p = papers.items.find((x) => x.id === tp.paperId);
			if (p?.addedAt) {
				const ts = Date.parse(p.addedAt);
				if (ts > max) max = ts;
			}
		}
		return max;
	}

	const filteredSorted = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const list = nonArchived.filter((t) => !q || t.title.toLowerCase().includes(q));
		const sorted = [...list];
		switch (sortBy) {
			case 'name':
				sorted.sort((a, b) => a.title.localeCompare(b.title));
				break;
			case 'papers':
				sorted.sort((a, b) => b.papers.length - a.papers.length);
				break;
			case 'lastPaper':
				sorted.sort((a, b) => lastPaperAddedAt(b) - lastPaperAddedAt(a));
				break;
			default:
				sorted.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
		}
		return sorted;
	});

	function byStatus(status: ThreadStatus): Thread[] {
		return filteredSorted.filter((t) => t.status === status);
	}

	function open(t: Thread) {
		ui.openThread(t.id);
		goto(`/threads/${t.id}`);
	}
</script>

<div class="space-y-6 p-4 sm:p-8">
	<header class="flex flex-wrap items-end justify-between gap-3">
		<div class="min-w-0">
			<h1 class="font-mono text-2xl font-light tracking-tight">Threads</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				{filteredSorted.length} of {nonArchived.length} threads
			</p>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<div class="flex gap-1 rounded-md border border-border/60 p-0.5">
				<Button
					variant={!ui.threadsCompact ? 'secondary' : 'ghost'}
					size="icon"
					onclick={() => (ui.threadsCompact = false)}
					aria-label="Kanban view"
				>
					<LayoutGrid class="h-4 w-4" />
				</Button>
				<Button
					variant={ui.threadsCompact ? 'secondary' : 'ghost'}
					size="icon"
					onclick={() => (ui.threadsCompact = true)}
					aria-label="Compact view"
				>
					<Rows3 class="h-4 w-4" />
				</Button>
			</div>
			<Button onclick={() => (ui.newThreadOpen = true)}>
				<Plus class="h-4 w-4" />
				New thread
			</Button>
		</div>
	</header>

	<div class="flex flex-wrap items-center gap-2">
		<Input
			bind:value={search}
			placeholder="Filter by name…"
			class="max-w-xs"
		/>
		<select
			class="h-9 rounded-md border border-input bg-background px-3 text-sm sm:ml-auto"
			bind:value={sortBy}
		>
			<option value="created">Creation date</option>
			<option value="lastPaper">Last paper added</option>
			<option value="name">Name</option>
			<option value="papers">Number of papers</option>
		</select>
	</div>

	{#if ui.threadsCompact}
		<div class="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
			{#each filteredSorted as t (t.id)}
				<button
					class="rounded-md border border-border/60 bg-card p-2 text-left transition-colors hover:border-border hover:bg-card/80"
					onclick={() => open(t)}
				>
					<div class="flex items-center gap-2">
						<span class="h-1.5 w-1.5 rounded-full {t.status === 'active' ? 'bg-accent' : t.status === 'paused' ? 'bg-yellow-500' : 'bg-muted-foreground/60'}"></span>
						<span class="line-clamp-1 text-xs font-medium">{t.title}</span>
					</div>
					<div class="mt-1 text-[10px] text-muted-foreground">{t.papers.length} papers</div>
				</button>
			{/each}
		</div>
	{:else}
		<div class="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
			{#each cols as col (col.status)}
				<div>
					<h3 class="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
						<span class="h-1.5 w-1.5 rounded-full {col.status === 'active' ? 'bg-accent' : col.status === 'paused' ? 'bg-yellow-500' : 'bg-muted-foreground/60'}"></span>
						{col.label}
						<span class="ml-auto font-mono text-[10px] text-muted-foreground/80">
							{byStatus(col.status).length}
						</span>
					</h3>
					<div class="space-y-2">
						{#each byStatus(col.status) as t (t.id)}
							<Card class="cursor-pointer p-3 transition-colors hover:border-border hover:bg-card/80">
								<button class="w-full text-left" onclick={() => open(t)}>
									<div class="line-clamp-2 text-sm font-medium">{t.title}</div>
									{#if t.question}
										<div class="mt-1 line-clamp-2 text-xs text-muted-foreground">{t.question}</div>
									{/if}
									<div class="mt-2 text-[10px] text-muted-foreground">{t.papers.length} papers</div>
								</button>
							</Card>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}

	{#if filteredSorted.length === 0}
		<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 py-20 text-center text-sm text-muted-foreground">
			{#if search.trim()}
				<p>No threads match your filter.</p>
			{:else}
				<p>No threads yet.</p>
				<Button class="mt-4" onclick={() => (ui.newThreadOpen = true)}>
					<Plus class="h-4 w-4" />
					Create your first thread
				</Button>
			{/if}
		</div>
	{/if}
</div>
