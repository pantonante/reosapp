<script lang="ts">
	import { Command, Dialog as DialogPrimitive } from 'bits-ui';
	import { papers, threads } from '$lib/stores.svelte';
	import type { Paper } from '$lib/types';
	import { renderTitleHtml } from '$lib/utils/render-title';
	import { cn } from '$lib/utils/cn';

	let {
		open = $bindable(false),
		query = $bindable(''),
		threadSlug,
		onPick,
		onCancel
	}: {
		open?: boolean;
		query?: string;
		/** Papers from this thread rank first. */
		threadSlug: string;
		onPick: (paper: Paper) => void;
		onCancel: () => void;
	} = $props();

	const MAX_RESULTS = 50;

	const results = $derived.by(() => {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		const matches = papers.items.filter((p) => {
			if (!terms.length) return true;
			const hay = `${p.title} ${p.authors.join(' ')} ${p.arxivId}`.toLowerCase();
			return terms.every((t) => hay.includes(t));
		});
		const local = (p: Paper) => (p.threadId === threadSlug ? 0 : 1);
		return matches.sort((a, b) => local(a) - local(b)).slice(0, MAX_RESULTS);
	});

	function threadLabel(p: Paper): string {
		if (!p.threadId || p.threadId === 'inbox') return 'Inbox';
		return threads.get(p.threadId)?.title ?? p.threadId;
	}

	function pick(p: Paper) {
		open = false;
		onPick(p);
	}
</script>

<DialogPrimitive.Root
	bind:open
	onOpenChange={(next) => {
		// User-initiated closes only (esc / overlay). Harmless after a pick:
		// the editor has already consumed the link range by then.
		if (!next) onCancel();
	}}
>
	<DialogPrimitive.Portal>
		<DialogPrimitive.Overlay class="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs" />
		<DialogPrimitive.Content
			class="fixed left-1/2 top-[20vh] z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border/60 bg-card shadow-2xl"
		>
			<Command.Root label="Link a paper" shouldFilter={false} class="w-full">
				<Command.Input
					bind:value={query}
					placeholder="Link a paper — search title, author, or ID…"
					class="w-full border-0 border-b border-border/60 bg-transparent px-4 py-3 text-sm focus:outline-hidden"
				/>
				<Command.List class="max-h-80 overflow-y-auto p-1">
					<Command.Empty class="px-4 py-8 text-center text-sm text-muted-foreground">
						No papers match.
					</Command.Empty>
					{#each results as p (p.id)}
						<Command.Item
							value={p.id}
							onSelect={() => pick(p)}
							class="flex cursor-pointer flex-col gap-0.5 rounded px-3 py-2 text-sm text-foreground data-selected:bg-accent/15"
						>
							<span class="paper-title line-clamp-1 font-medium">{@html renderTitleHtml(p.title)}</span>
							<span class="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
								<span class="truncate">
									{p.authors.length > 1 ? `${p.authors[0]} et al.` : (p.authors[0] ?? '')}
									{p.publishedDate ? ` · ${p.publishedDate.slice(0, 4)}` : ''}
								</span>
								<span class="shrink-0 font-mono">{p.arxivId}</span>
								<span
									class={cn(
										'ml-auto shrink-0 truncate',
										p.threadId === threadSlug && 'text-accent'
									)}
								>
									{p.threadId === threadSlug ? 'this thread' : threadLabel(p)}
								</span>
							</span>
						</Command.Item>
					{/each}
				</Command.List>
			</Command.Root>
			<div class="border-t border-border/60 px-4 py-1.5 text-[10px] text-muted-foreground">
				↩ insert link · esc cancel
			</div>
		</DialogPrimitive.Content>
	</DialogPrimitive.Portal>
</DialogPrimitive.Root>
