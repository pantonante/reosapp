<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { papers, threads } from '$lib/stores.svelte';
	import { ChevronRight } from 'lucide-svelte';

	type Crumb = { label: string; href?: string };

	const crumbs = $derived.by<Crumb[]>(() => {
		const path = page.url.pathname;
		const segs = path.split('/').filter(Boolean);

		if (segs.length === 0) return [{ label: 'Inbox' }];
		if (segs[0] === 'library') return [{ label: 'Library' }];
		if (segs[0] === 'graph') return [{ label: 'Graph' }];

		if (segs[0] === 'threads') {
			const out: Crumb[] = [{ label: 'Threads', href: '/threads' }];
			if (segs.length === 1) return [{ label: 'Threads' }];
			const t = threads.get(segs[1]);
			const title = t?.title ?? segs[1];
			if (segs.length === 2) {
				out.push({ label: title });
				return out;
			}
			out.push({ label: title, href: `/threads/${segs[1]}` });
			if (segs[2] === 'chat') out.push({ label: 'Chat' });
			else out.push({ label: segs[2] });
			return out;
		}

		if (segs[0] === 'paper' && segs[1]) {
			const p = papers.get(segs[1]);
			const title = p?.title ?? 'Paper';
			if (!p) return [{ label: 'Library', href: '/library' }, { label: title }];
			if (p.threadId && p.threadId !== 'inbox') {
				const t = threads.get(p.threadId);
				return [
					{ label: 'Threads', href: '/threads' },
					{ label: t?.title ?? p.threadId, href: `/threads/${p.threadId}` },
					{ label: title }
				];
			}
			if (p.threadId === 'inbox') {
				return [
					{ label: 'Inbox', href: '/' },
					{ label: title }
				];
			}
			return [{ label: 'Library', href: '/library' }, { label: title }];
		}

		return [{ label: segs[0] }];
	});
</script>

<nav
	class="flex h-8 flex-shrink-0 items-center gap-1.5 border-b border-border/60 px-5 font-mono text-xs"
	aria-label="Breadcrumb"
>
	{#each crumbs as c, i (i)}
		{#if i > 0}
			<ChevronRight class="h-3 w-3 text-muted-foreground/60" />
		{/if}
		{#if c.href && i < crumbs.length - 1}
			<button
				type="button"
				class="max-w-[40ch] truncate text-muted-foreground transition-colors hover:text-foreground"
				title={c.label}
				onclick={() => c.href && goto(c.href)}
			>
				{c.label}
			</button>
		{:else}
			<span
				class="max-w-[60ch] truncate uppercase tracking-wider text-foreground"
				title={c.label}
			>
				{c.label}
			</span>
		{/if}
	{/each}
</nav>
