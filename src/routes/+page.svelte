<script lang="ts">
	import { papers } from '$lib/stores.svelte';
	import PaperCard from '$lib/components/PaperCard.svelte';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui';
	import { Plus } from 'lucide-svelte';
	import { ui } from '$lib/stores.svelte';

	const unfiled = $derived(
		[...papers.items.filter((p) => !p.threadId || p.threadId === 'inbox')].sort((a, b) =>
			a.addedAt > b.addedAt ? -1 : 1
		)
	);
	const reading = $derived(unfiled.filter((p) => p.readingStatus === 'reading'));
	const unread = $derived(unfiled.filter((p) => p.readingStatus === 'unread'));

	function open(id: string) {
		ui.openPaper(id);
		goto(`/paper/${id}`);
	}
</script>

<div class="space-y-10 p-8">
	<header class="flex items-end justify-between">
		<div>
			<h1 class="font-mono text-2xl font-light tracking-tight">Inbox</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				Papers not in any thread · {unfiled.length} unfiled · {reading.length} reading · {unread.length} unread
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

	{#if unfiled.length > 0}
		<section class="border-l-2 border-accent/60 pl-4">
			<div class="mb-3 flex items-baseline justify-between">
				<h2 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					Unfiled
					<span class="ml-2 font-mono text-[10px] text-muted-foreground/80">{unfiled.length}</span>
				</h2>
				<span class="text-[11px] text-muted-foreground/70">
					Open a paper and use the right sidebar to move it into a thread.
				</span>
			</div>
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each unfiled as p (p.id)}
					<PaperCard paper={p} onclick={() => open(p.id)} />
				{/each}
			</div>
		</section>
	{:else}
		<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 py-20 text-center text-sm text-muted-foreground">
			<p>{papers.items.length === 0 ? 'No papers yet.' : 'No unfiled papers — every paper is in a thread.'}</p>
			<Button class="mt-4" onclick={() => (ui.addPaperOpen = true)}>
				<Plus class="h-4 w-4" />
				{papers.items.length === 0 ? 'Add your first paper' : 'Add paper'}
			</Button>
		</div>
	{/if}
</div>
