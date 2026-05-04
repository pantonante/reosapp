<script lang="ts">
	import type { Paper } from '$lib/types';
	import { Badge, Card } from '$lib/components/ui';
	import { cn } from '$lib/utils/cn';

	let {
		paper,
		compact = false,
		onclick
	}: { paper: Paper; compact?: boolean; onclick?: () => void } = $props();

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
</script>

<Card class={cn('p-4 transition-colors hover:border-border', onclick && 'cursor-pointer hover:bg-secondary/40')}>
	{#if onclick}
		<button class="w-full text-left" {onclick}>
			{@render body()}
		</button>
	{:else}
		{@render body()}
	{/if}
</Card>

{#snippet body()}
	<div class="flex items-center gap-2 text-xs text-muted-foreground">
		<span class={cn('h-1.5 w-1.5 rounded-full', statusDot(paper.readingStatus))}></span>
		<span class="font-mono">{paper.arxivId}</span>
		<span>·</span>
		<span>{paper.publishedDate?.slice(0, 10) || '—'}</span>
		{#if stars > 0}
			<span class="ml-auto font-mono text-amber-500">
				{'★'.repeat(stars)}{'☆'.repeat(5 - stars)}
			</span>
		{/if}
	</div>
	<h3 class="mt-2 line-clamp-2 text-base font-medium leading-snug">{paper.title}</h3>
	<p class="mt-1 line-clamp-1 text-sm text-muted-foreground">
		{paper.authors.slice(0, 3).join(', ')}{paper.authors.length > 3 ? ' et al.' : ''}
	</p>
	{#if !compact && paper.abstract}
		<p class="mt-2 line-clamp-3 text-sm leading-relaxed text-muted-foreground">{paper.abstract}</p>
	{/if}
	{#if paper.categories.length > 0}
		<div class="mt-3 flex flex-wrap gap-1">
			{#each paper.categories.slice(0, 3) as cat (cat)}
				<Badge variant="outline" class="font-mono text-xs">{cat}</Badge>
			{/each}
		</div>
	{/if}
{/snippet}
