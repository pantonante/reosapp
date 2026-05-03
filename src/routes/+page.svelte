<script lang="ts">
	import { papers } from '$lib/stores.svelte';
	import PaperCard from '$lib/components/PaperCard.svelte';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui';
	import { Plus } from 'lucide-svelte';
	import { ui } from '$lib/stores.svelte';

	const reading = $derived(papers.items.filter((p) => p.readingStatus === 'reading'));
	const unread = $derived(papers.items.filter((p) => p.readingStatus === 'unread'));
	const recent = $derived(
		[...papers.items]
			.sort((a, b) => (a.addedAt > b.addedAt ? -1 : 1))
			.slice(0, 9)
	);

	function open(id: string) {
		ui.openPaper(id);
		goto(`/paper/${id}`);
	}
</script>

<div class="space-y-12 p-8">
	<header class="flex items-end justify-between">
		<div>
			<h1 class="font-mono text-2xl font-light tracking-tight">Inbox</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				{papers.items.length} papers · {reading.length} reading · {unread.length} unread
			</p>
		</div>
		<Button onclick={() => (ui.addPaperOpen = true)}>
			<Plus class="h-4 w-4" />
			Add paper
		</Button>
	</header>

	{#if reading.length > 0}
		<section>
			<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				Currently reading
			</h2>
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each reading as p (p.id)}
					<PaperCard paper={p} onclick={() => open(p.id)} />
				{/each}
			</div>
		</section>
	{/if}

	{#if unread.length > 0}
		<section>
			<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				Unread
			</h2>
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each unread.slice(0, 9) as p (p.id)}
					<PaperCard paper={p} onclick={() => open(p.id)} />
				{/each}
			</div>
		</section>
	{/if}

	{#if recent.length > 0}
		<section>
			<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				Recently added
			</h2>
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each recent as p (p.id)}
					<PaperCard paper={p} onclick={() => open(p.id)} />
				{/each}
			</div>
		</section>
	{/if}

	{#if papers.items.length === 0}
		<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 py-20 text-center text-sm text-muted-foreground">
			<p>No papers yet.</p>
			<Button class="mt-4" onclick={() => (ui.addPaperOpen = true)}>
				<Plus class="h-4 w-4" />
				Add your first paper
			</Button>
		</div>
	{/if}
</div>
