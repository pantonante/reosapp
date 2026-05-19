<script lang="ts">
	import 'katex/dist/katex.min.css';
	import type { Paper } from '$lib/types';
	import { Badge, Card } from '$lib/components/ui';
	import { cn } from '$lib/utils/cn';
	import { renderTitleHtml } from '$lib/utils/render-title';

	let {
		paper,
		compact = false,
		onclick
	}: { paper: Paper; compact?: boolean; onclick?: (e: MouseEvent) => void } = $props();

	function statusDot(status: Paper['readingStatus']): string {
		switch (status) {
			case 'reading':
				return 'bg-yellow-500';
			case 'read':
				return 'bg-green-500';
			case 'archived':
				return 'bg-muted-foreground/60';
			default:
				return 'bg-accent';
		}
	}

	const stars = $derived(paper.rating ?? 0);
	const isWebpage = $derived(!paper.pdfPath && !!paper.sourceUrl);
	const displayCategories = $derived(
		isWebpage && paper.categories.length === 0 ? ['web'] : paper.categories
	);
</script>

<Card class={cn('h-full p-4 transition-colors hover:border-border', onclick && 'cursor-pointer hover:bg-secondary/40')}>
	{#if onclick}
		<button class="flex h-full w-full flex-col text-left" {onclick}>
			{@render body()}
		</button>
	{:else}
		{@render body()}
	{/if}
</Card>

{#snippet body()}
	<div class="flex items-center gap-2 text-xs text-muted-foreground">
		<span class={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDot(paper.readingStatus))}></span>
		<span class="min-w-0 truncate font-mono">{paper.arxivId}</span>
		<span class="shrink-0">·</span>
		<span class="shrink-0">{paper.publishedDate?.slice(0, 10) || '—'}</span>
		{#if stars > 0}
			<span class="ml-auto shrink-0 font-mono text-amber-500">
				{'★'.repeat(stars)}{'☆'.repeat(5 - stars)}
			</span>
		{/if}
	</div>
	<h3 class="paper-title mt-2 line-clamp-2 text-base font-medium leading-snug">{@html renderTitleHtml(paper.title)}</h3>
	<p class="mt-1 line-clamp-1 text-sm text-muted-foreground">
		{paper.authors.slice(0, 3).join(', ')}{paper.authors.length > 3 ? ' et al.' : ''}
	</p>
	{#if !compact && paper.abstract}
		<p class="mt-2 line-clamp-3 text-sm leading-relaxed text-muted-foreground">{paper.abstract}</p>
	{/if}
	{#if displayCategories.length > 0}
		<div class="mt-3 flex flex-wrap gap-1">
			{#each displayCategories.slice(0, 3) as cat (cat)}
				<Badge variant="outline" class="font-mono text-xs">{cat}</Badge>
			{/each}
		</div>
	{/if}
{/snippet}

<style>
	.paper-title :global(.katex) {
		font-size: 1em;
		line-height: inherit;
	}
</style>
