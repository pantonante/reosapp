<script lang="ts">
	import { untrack } from 'svelte';
	import { papers, summaryMeta } from '$lib/stores.svelte';
	import PaperCard from '$lib/components/PaperCard.svelte';
	import { goto } from '$app/navigation';
	import { Badge, Button } from '$lib/components/ui';
	import { Plus, Sparkles, Trash2 } from 'lucide-svelte';
	import { ui } from '$lib/stores.svelte';
	import { ask } from '@tauri-apps/plugin-dialog';
	import { renderTitleHtml } from '$lib/utils/render-title';
	import { cn } from '$lib/utils/cn';
	import type { Paper } from '$lib/types';

	type ViewMode = 'grid' | 'list';
	const VIEW_KEY = 'reos:inboxViewMode';
	let viewMode = $state<ViewMode>('grid');

	$effect(() => {
		try {
			const stored = localStorage.getItem(VIEW_KEY);
			if (stored === 'grid' || stored === 'list') untrack(() => (viewMode = stored));
		} catch {
			// storage unavailable; keep the default
		}
	});

	function setViewMode(mode: ViewMode) {
		viewMode = mode;
		try {
			localStorage.setItem(VIEW_KEY, mode);
		} catch {
			// ignore
		}
	}

	const summarized = $derived(new Set(summaryMeta.items.map((m) => m.paperId)));

	const unfiled = $derived(
		[...papers.items.filter((p) => !p.threadId || p.threadId === 'inbox')].sort((a, b) =>
			a.addedAt > b.addedAt ? -1 : 1
		)
	);
	const reading = $derived(unfiled.filter((p) => p.readingStatus === 'reading'));
	const unread = $derived(unfiled.filter((p) => p.readingStatus === 'unread'));

	function open(id: string, e?: MouseEvent) {
		const newTab = !!(e && (e.metaKey || e.ctrlKey));
		ui.openPaper(id, { newTab });
		goto(`/paper/${id}`);
	}

	// Middle click: open the paper in a new background tab and stay here.
	function openInBackground(id: string) {
		ui.openPaper(id, { newTab: true, background: true });
	}

	async function deletePaper(id: string) {
		const p = papers.get(id);
		if (!p) return;
		const ok = await ask(
			`Permanently delete "${p.title}"?\n\nThis will:\n• Remove the paper from your library and from any threads it belongs to\n• Delete the PDF file and the paper's folder from disk\n• Delete all notes, annotations, and chats attached to this paper\n• Delete its cached summary\n\nThis cannot be undone.`,
			{ title: 'Delete paper', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Cancel' }
		);
		if (!ok) return;
		await papers.remove(id);
	}
</script>

<div class="space-y-10 p-6 sm:p-8">
	<header class="flex flex-wrap items-end justify-between gap-3">
		<div class="min-w-0">
			<h1 class="font-mono text-2xl font-light tracking-tight">Inbox</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				Papers not in any thread · {unfiled.length} unfiled · {reading.length} reading · {unread.length} unread
			</p>
		</div>
		<div class="flex items-center gap-2">
			<div class="flex items-center rounded-md border border-input bg-background p-0.5" role="group" aria-label="View">
				{#each [['grid', 'Grid'], ['list', 'List']] as [mode, label] (mode)}
					<button
						type="button"
						aria-pressed={viewMode === mode}
						class={cn(
							'h-7 rounded px-3 text-xs font-medium transition-colors',
							viewMode === mode
								? 'bg-secondary text-foreground'
								: 'text-muted-foreground hover:text-foreground'
						)}
						onclick={() => setViewMode(mode as ViewMode)}
					>
						{label}
					</button>
				{/each}
			</div>
			<Button onclick={() => (ui.addPaperOpen = true)}>
				<Plus class="h-4 w-4" />
				Add paper
			</Button>
		</div>
	</header>

	{#if reading.length > 0}
		<section>
			<h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				Currently reading
			</h2>
			{@render paperList(reading)}
		</section>
	{/if}

	{#if unfiled.length > 0}
		<section>
			<div class="mb-3 flex items-baseline justify-between">
				<h2 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					Unfiled
					<span class="ml-2 font-mono text-[10px] text-muted-foreground/80">{unfiled.length}</span>
				</h2>
				<span class="text-[11px] text-muted-foreground/70">
					Open a paper and use the right sidebar to move it into a thread.
				</span>
			</div>
			{@render paperList(unfiled)}
		</section>
	{:else}
		<div class="flex flex-col items-center justify-center rounded-[12px] border border-dashed border-border/60 py-20 text-center text-sm text-muted-foreground">
			<p>{papers.items.length === 0 ? 'No papers yet.' : 'No unfiled papers — every paper is in a thread.'}</p>
			<Button class="mt-4" onclick={() => (ui.addPaperOpen = true)}>
				<Plus class="h-4 w-4" />
				{papers.items.length === 0 ? 'Add your first paper' : 'Add paper'}
			</Button>
		</div>
	{/if}
</div>

{#snippet paperList(items: Paper[])}
	{#if viewMode === 'grid'}
		<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each items as p (p.id)}
				<div class="group relative">
					<PaperCard
						paper={p}
						onclick={(e) => open(p.id, e)}
						onmiddleclick={() => openInBackground(p.id)}
					/>
					<button
						class="absolute right-2 top-2 rounded p-1 opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100"
						onclick={() => deletePaper(p.id)}
						aria-label="Delete paper"
						title="Delete paper"
					>
						<Trash2 class="h-3.5 w-3.5" />
					</button>
				</div>
			{/each}
		</div>
	{:else}
		<div class="overflow-x-auto rounded-md border border-border/60">
			<table class="w-full text-sm">
				<thead class="border-b border-border/60 bg-muted/30 text-xs text-muted-foreground">
					<tr>
						<th class="px-3 py-2 text-left font-medium">Title</th>
						<th class="px-3 py-2 text-left font-medium">Authors</th>
						<th class="px-3 py-2 text-left font-medium">Published</th>
						<th class="px-3 py-2 text-left font-medium">Added</th>
						<th class="px-3 py-2 text-left font-medium">Status</th>
						<th class="px-3 py-2 text-left font-medium">Rating</th>
						<th class="w-8 px-2 py-2"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each items as p (p.id)}
						<tr
							class="group cursor-pointer border-b border-border/40 last:border-b-0 hover:bg-accent/5"
							onclick={(e) => open(p.id, e)}
							onmouseup={(e) => e.button === 1 && openInBackground(p.id)}
						>
							<td class="px-3 py-2">
								<div class="paper-title line-clamp-2 font-medium">{@html renderTitleHtml(p.title)}</div>
								<div class="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
									{p.arxivId}
									{#if summarized.has(p.id)}
										<span title="Summary generated" class="inline-flex text-muted-foreground/60">
											<Sparkles class="h-2.5 w-2.5" aria-label="Summary generated" />
										</span>
									{/if}
								</div>
							</td>
							<td class="px-3 py-2 text-xs text-muted-foreground">
								{p.authors.slice(0, 2).join(', ')}{p.authors.length > 2 ? ' et al.' : ''}
							</td>
							<td class="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
								{p.publishedDate?.slice(0, 10) || '—'}
							</td>
							<td class="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
								{p.addedAt.slice(0, 10)}
							</td>
							<td class="px-3 py-2">
								<Badge variant="outline">{p.readingStatus}</Badge>
							</td>
							<td class="whitespace-nowrap px-3 py-2 text-xs text-amber-500">
								{p.rating ? '★'.repeat(p.rating) : '—'}
							</td>
							<td class="px-2 py-2">
								<button
									class="rounded p-1 opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
									onclick={(e) => {
										e.stopPropagation();
										deletePaper(p.id);
									}}
									aria-label="Delete paper"
									title="Delete paper"
								>
									<Trash2 class="h-3 w-3" />
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
{/snippet}
