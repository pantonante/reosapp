<script lang="ts">
	import { threads, ui } from '$lib/stores.svelte';
	import { goto } from '$app/navigation';
	import type { Thread } from '$lib/types';

	const archived = $derived(threads.items.filter((t) => t.status === 'archived'));

	function open(t: Thread) {
		ui.openThread(t.id);
		goto(`/threads/${t.id}`);
	}
</script>

<div class="space-y-6 p-4 sm:p-8">
	<header>
		<h1 class="font-mono text-2xl font-light tracking-tight">Archive</h1>
		<p class="mt-1 text-sm text-muted-foreground">
			{archived.length} archived {archived.length === 1 ? 'thread' : 'threads'}
		</p>
	</header>

	{#if archived.length === 0}
		<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 py-20 text-center text-sm text-muted-foreground">
			<p>No archived threads.</p>
		</div>
	{:else}
		<div class="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
			{#each archived as t (t.id)}
				<button
					class="rounded-md border border-border/60 bg-card p-2 text-left transition-colors hover:border-border hover:bg-card/80"
					onclick={() => open(t)}
				>
					<div class="flex items-center gap-2">
						<span class="h-1.5 w-1.5 rounded-full bg-muted-foreground/60"></span>
						<span class="line-clamp-1 text-xs font-medium">{t.title}</span>
					</div>
					<div class="mt-1 text-[10px] text-muted-foreground">{t.papers.length} papers</div>
				</button>
			{/each}
		</div>
	{/if}
</div>
