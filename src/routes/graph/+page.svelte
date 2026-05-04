<script lang="ts">
	import GraphView from '$lib/components/GraphView.svelte';
	import { papers, summaryMeta } from '$lib/stores.svelte';
</script>

<svelte:head>
	<title>Graph · Re:OS</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col">
	<header class="border-b border-border/60 px-4 py-3 sm:px-8">
		<h1 class="font-mono text-xl font-light tracking-tight">Graph</h1>
		<p class="mt-0.5 text-xs text-muted-foreground">
			Papers connected by shared topics, domains, and keywords from their summaries.
		</p>
	</header>
	<div class="min-h-0 flex-1">
		<GraphView papers={papers.items} summaryMetaItems={summaryMeta.items} />
	</div>
</div>
