<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import type { HTMLInputAttributes } from 'svelte/elements';

	type Props = { class?: string; value?: string } & Omit<HTMLInputAttributes, 'class'>;
	let { class: className = '', value = $bindable(''), ...rest }: Props = $props();
</script>

<input
	bind:value
	class={cn(
		'flex h-9 w-full rounded-[10px] border border-border/70 bg-muted/60 px-3 py-1 text-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
		className
	)}
	{...rest}
/>
