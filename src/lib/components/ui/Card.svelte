<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import type { Snippet } from 'svelte';

	let {
		class: className = '',
		children
	}: { class?: string; children?: Snippet } = $props();
</script>

<div class={cn('panel text-card-foreground', className)}>
	{@render children?.()}
</div>
