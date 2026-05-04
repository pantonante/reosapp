<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import type { HTMLTextareaAttributes } from 'svelte/elements';

	type Props = { class?: string; value?: string } & Omit<HTMLTextareaAttributes, 'class'>;
	let { class: className = '', value = $bindable(''), ...rest }: Props = $props();
</script>

<textarea
	bind:value
	class={cn(
		'flex min-h-[80px] w-full rounded-[10px] border border-border/70 bg-muted/60 px-3 py-2 text-sm placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
		className
	)}
	{...rest}
></textarea>
