<script lang="ts">
	import { NotebookPen, Pencil, Trash2 } from 'lucide-svelte';
	import { isVideoPath, noteExcerpt } from '$lib/note-format';
	import { loadMediaBlobUrl, resolveNoteMediaPath } from '$lib/tauri/notes';
	import type { ThreadNote } from '$lib/types';
	import { cn } from '$lib/utils/cn';

	let {
		note,
		threadSlug,
		layout,
		onOpen,
		onEdit,
		onDelete
	}: {
		note: ThreadNote;
		threadSlug: string;
		layout: 'list' | 'grid';
		onOpen: (e: MouseEvent) => void;
		onEdit: (e: MouseEvent) => void;
		onDelete: () => void;
	} = $props();

	const updated = $derived(note.updatedAt.slice(0, 10));
	const excerpt = $derived(noteExcerpt(note.content, layout === 'grid' ? 320 : 180));

	// --- Grid thumbnail: the note's first embedded image ---

	const firstImage = $derived.by(() => {
		const re = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)|<img\b[^>]*\bsrc=["']([^"']+)["']/g;
		for (const m of note.content.matchAll(re)) {
			const src = m[1] ?? m[2];
			if (src && !isVideoPath(src)) return src;
		}
		return null;
	});

	let thumbUrl = $state<string | null>(null);

	$effect(() => {
		const src = firstImage;
		const slug = threadSlug;
		if (layout !== 'grid' || !src) {
			thumbUrl = null;
			return;
		}
		let cancelled = false;
		let blobUrl: string | null = null;
		void (async () => {
			try {
				const path = await resolveNoteMediaPath(slug, src);
				if (!path) {
					if (!cancelled) thumbUrl = src;
					return;
				}
				blobUrl = await loadMediaBlobUrl(path);
				if (cancelled) URL.revokeObjectURL(blobUrl);
				else thumbUrl = blobUrl;
			} catch {
				if (!cancelled) thumbUrl = null;
			}
		})();
		return () => {
			cancelled = true;
			if (blobUrl) URL.revokeObjectURL(blobUrl);
		};
	});
</script>

{#snippet actions(overlay: boolean)}
	<div
		class={cn(
			'flex shrink-0 items-center rounded-md opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
			overlay && 'absolute right-1.5 top-1.5',
			overlay && thumbUrl && 'bg-card/90 shadow-xs'
		)}
	>
		<button
			type="button"
			class="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
			onclick={onEdit}
			aria-label="Edit note"
			title="Edit"
		>
			<Pencil class="h-3 w-3" />
		</button>
		<button
			type="button"
			class="rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
			onclick={onDelete}
			aria-label="Delete note"
			title="Delete"
		>
			<Trash2 class="h-3 w-3" />
		</button>
	</div>
{/snippet}

{#if layout === 'grid'}
	<article
		class="group relative h-full rounded-md border border-border/60 bg-card transition-colors hover:border-border hover:bg-secondary/40"
	>
		<button
			type="button"
			class="flex h-full w-full flex-col overflow-hidden rounded-md text-left"
			onclick={onOpen}
		>
			{#if thumbUrl}
				<img
					src={thumbUrl}
					alt=""
					class="h-32 w-full shrink-0 border-b border-border/60 object-cover"
					onerror={() => (thumbUrl = null)}
				/>
			{/if}
			<span class="flex flex-1 flex-col gap-1 p-3">
				<span class="line-clamp-2 pr-12 text-sm font-medium leading-snug">{note.title}</span>
				{#if excerpt}
					<span class={cn('text-xs text-muted-foreground', thumbUrl ? 'line-clamp-2' : 'line-clamp-5')}>
						{excerpt}
					</span>
				{/if}
				<span class="mt-auto pt-1 font-mono text-[10px] text-muted-foreground">{updated}</span>
			</span>
		</button>
		{@render actions(true)}
	</article>
{:else}
	<article
		class="group flex items-center gap-2 rounded-md border border-border/60 bg-card px-3 py-2 transition-colors hover:border-border hover:bg-secondary/40"
	>
		<button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" onclick={onOpen}>
			<NotebookPen class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			<span class="min-w-0 flex-1">
				<span class="block truncate text-sm font-medium">{note.title}</span>
				{#if excerpt}
					<span class="block truncate text-xs text-muted-foreground">{excerpt}</span>
				{/if}
			</span>
		</button>
		<span class="shrink-0 font-mono text-[10px] text-muted-foreground">{updated}</span>
		{@render actions(false)}
	</article>
{/if}
