<script lang="ts">
	import { papers, ui } from '$lib/stores.svelte';
	import PaperCard from '$lib/components/PaperCard.svelte';
	import { Button, Input, Badge } from '$lib/components/ui';
	import { goto } from '$app/navigation';
	import { LayoutGrid, Table2 } from 'lucide-svelte';
	import type { ReadingStatus } from '$lib/types';

	let view = $state<'card' | 'table'>('card');
	let search = $state('');
	let statusFilter = $state<ReadingStatus | 'all'>('all');
	let categoryFilter = $state<string>('all');
	let sortBy = $state<'added' | 'published' | 'title' | 'rating'>('added');

	const allCategories = $derived(
		Array.from(new Set(papers.items.flatMap((p) => p.categories))).sort()
	);

	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		let list = papers.items.filter((p) => {
			if (statusFilter !== 'all' && p.readingStatus !== statusFilter) return false;
			if (categoryFilter !== 'all' && !p.categories.includes(categoryFilter)) return false;
			if (q) {
				const hay = `${p.title} ${p.authors.join(' ')} ${p.arxivId}`.toLowerCase();
				if (!hay.includes(q)) return false;
			}
			return true;
		});
		list = [...list];
		switch (sortBy) {
			case 'published':
				list.sort((a, b) => (a.publishedDate > b.publishedDate ? -1 : 1));
				break;
			case 'title':
				list.sort((a, b) => a.title.localeCompare(b.title));
				break;
			case 'rating':
				list.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
				break;
			default:
				list.sort((a, b) => (a.addedAt > b.addedAt ? -1 : 1));
		}
		return list;
	});

	function open(id: string) {
		ui.openPaper(id);
		goto(`/paper/${id}`);
	}
</script>

<div class="space-y-6 p-8">
	<header class="flex items-end justify-between">
		<div>
			<h1 class="font-mono text-2xl font-light tracking-tight">Library</h1>
			<p class="mt-1 text-sm text-muted-foreground">{filtered.length} of {papers.items.length} papers</p>
		</div>
		<div class="flex gap-1 rounded-md border border-border/60 p-0.5">
			<Button
				variant={view === 'card' ? 'secondary' : 'ghost'}
				size="icon"
				onclick={() => (view = 'card')}
			>
				<LayoutGrid class="h-4 w-4" />
			</Button>
			<Button
				variant={view === 'table' ? 'secondary' : 'ghost'}
				size="icon"
				onclick={() => (view = 'table')}
			>
				<Table2 class="h-4 w-4" />
			</Button>
		</div>
	</header>

	<div class="flex flex-wrap items-center gap-2">
		<Input
			bind:value={search}
			placeholder="Search title, authors, arxiv ID…"
			class="max-w-xs"
		/>
		<select
			class="h-9 rounded-md border border-input bg-background px-3 text-sm"
			bind:value={statusFilter}
		>
			<option value="all">All statuses</option>
			<option value="unread">Unread</option>
			<option value="reading">Reading</option>
			<option value="read">Read</option>
			<option value="archived">Archived</option>
		</select>
		<select
			class="h-9 rounded-md border border-input bg-background px-3 text-sm"
			bind:value={categoryFilter}
		>
			<option value="all">All categories</option>
			{#each allCategories as cat (cat)}
				<option value={cat}>{cat}</option>
			{/each}
		</select>
		<select
			class="ml-auto h-9 rounded-md border border-input bg-background px-3 text-sm"
			bind:value={sortBy}
		>
			<option value="added">Recently added</option>
			<option value="published">Published date</option>
			<option value="title">Title</option>
			<option value="rating">Rating</option>
		</select>
	</div>

	{#if view === 'card'}
		<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
			{#each filtered as p (p.id)}
				<PaperCard paper={p} compact onclick={() => open(p.id)} />
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
						<th class="px-3 py-2 text-left font-medium">Status</th>
						<th class="px-3 py-2 text-left font-medium">Rating</th>
					</tr>
				</thead>
				<tbody>
					{#each filtered as p (p.id)}
						<tr
							class="cursor-pointer border-b border-border/40 hover:bg-accent/5"
							onclick={() => open(p.id)}
						>
							<td class="px-3 py-2">
								<div class="font-medium">{p.title}</div>
								<div class="font-mono text-[10px] text-muted-foreground">{p.arxivId}</div>
							</td>
							<td class="px-3 py-2 text-xs text-muted-foreground">
								{p.authors.slice(0, 2).join(', ')}{p.authors.length > 2 ? ' et al.' : ''}
							</td>
							<td class="px-3 py-2 text-xs text-muted-foreground">{p.publishedDate?.slice(0, 10) ?? ''}</td>
							<td class="px-3 py-2">
								<Badge variant="outline">{p.readingStatus}</Badge>
							</td>
							<td class="px-3 py-2 text-xs text-amber-500">
								{p.rating ? '★'.repeat(p.rating) : '—'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
