<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils/cn';
	import { X } from 'lucide-svelte';
	import type { Snippet } from 'svelte';

	type Props = {
		open?: boolean;
		title?: string;
		description?: string;
		class?: string;
		children?: Snippet;
		onOpenChange?: (open: boolean) => void;
	};

	let {
		open = $bindable(false),
		title,
		description,
		class: className = '',
		children,
		onOpenChange
	}: Props = $props();
</script>

<DialogPrimitive.Root bind:open onOpenChange={onOpenChange}>
	<DialogPrimitive.Portal>
		<DialogPrimitive.Overlay
			class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
		/>
		<DialogPrimitive.Content
			class={cn(
				'panel fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 p-6 duration-200',
				className
			)}
		>
			{#if title || description}
				<div class="flex flex-col space-y-1.5 text-left">
					{#if title}
						<DialogPrimitive.Title class="text-lg font-semibold leading-none tracking-tight">
							{title}
						</DialogPrimitive.Title>
					{/if}
					{#if description}
						<DialogPrimitive.Description class="text-sm text-muted-foreground">
							{description}
						</DialogPrimitive.Description>
					{/if}
				</div>
			{/if}

			{@render children?.()}

			<DialogPrimitive.Close
				class="absolute right-4 top-4 rounded-sm text-muted-foreground opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
			>
				<X class="h-4 w-4" />
				<span class="sr-only">Close</span>
			</DialogPrimitive.Close>
		</DialogPrimitive.Content>
	</DialogPrimitive.Portal>
</DialogPrimitive.Root>
