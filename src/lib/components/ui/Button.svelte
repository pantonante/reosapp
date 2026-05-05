<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	export const buttonVariants = tv({
		base: 'group/btn relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-sm font-medium ring-offset-background transition-[background,box-shadow,transform,border-color,color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:translate-y-px',
		variants: {
			variant: {
				default:
					'bg-primary text-primary-foreground shadow-[inset_0_1px_0_0_hsl(var(--primary-foreground)/0.18),0_1px_2px_0_hsl(var(--shadow-color)/calc(var(--shadow-opacity)*0.8))] hover:bg-primary/90 hover:shadow-[inset_0_1px_0_0_hsl(var(--primary-foreground)/0.22),0_3px_8px_-2px_hsl(var(--shadow-color)/var(--shadow-opacity))]',
				destructive:
					'bg-destructive text-destructive-foreground shadow-[inset_0_1px_0_0_rgb(255_255_255/0.16),0_1px_2px_0_hsl(var(--shadow-color)/calc(var(--shadow-opacity)*0.8))] hover:bg-destructive/90 hover:shadow-[inset_0_1px_0_0_rgb(255_255_255/0.2),0_3px_8px_-2px_hsl(var(--shadow-color)/var(--shadow-opacity))]',
				outline:
					'border border-border/70 bg-transparent hover:border-border hover:bg-secondary hover:text-foreground',
				secondary:
					'border border-border/60 bg-secondary text-secondary-foreground shadow-[inset_0_1px_0_0_hsl(var(--panel-highlight)/0.4)] hover:border-border hover:bg-secondary/85',
				subtle:
					'border border-border/60 bg-secondary/50 text-foreground shadow-[inset_0_1px_0_0_hsl(var(--panel-highlight)/0.35)] hover:border-border hover:bg-secondary',
				ghost:
					'text-muted-foreground hover:bg-secondary hover:text-foreground hover:shadow-[inset_0_1px_0_0_hsl(var(--panel-highlight)/0.35)]',
				link: 'text-accent underline-offset-4 hover:underline'
			},
			size: {
				default: 'h-9 px-4 py-2',
				sm: 'h-8 rounded-[8px] px-3 text-xs',
				lg: 'h-10 rounded-[12px] px-8',
				icon: 'h-9 w-9'
			}
		},
		defaultVariants: { variant: 'default', size: 'default' }
	});

	export type ButtonVariants = VariantProps<typeof buttonVariants>;
</script>

<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes, HTMLAnchorAttributes } from 'svelte/elements';

	type Props = {
		variant?: ButtonVariants['variant'];
		size?: ButtonVariants['size'];
		class?: string;
		children?: Snippet;
		href?: string;
	} & Omit<HTMLButtonAttributes & HTMLAnchorAttributes, 'class'>;

	let {
		variant = 'default',
		size = 'default',
		class: className = '',
		children,
		href,
		...rest
	}: Props = $props();
</script>

{#if href}
	<a {href} class={cn(buttonVariants({ variant, size }), className)} {...rest}>
		{@render children?.()}
	</a>
{:else}
	<button class={cn(buttonVariants({ variant, size }), className)} {...rest}>
		{@render children?.()}
	</button>
{/if}
