<script lang="ts">
	import { page } from '$app/state';
	import { ui } from '$lib/stores.svelte';
	import { cn } from '$lib/utils/cn';
	import { Inbox, Library, Layers, Archive, Settings, Search, Network } from 'lucide-svelte';

	type NavItem = { href: string; label: string; icon: typeof Inbox; match: (p: string) => boolean };

	const items: NavItem[] = [
		{ href: '/', label: 'Inbox', icon: Inbox, match: (p) => p === '/' },
		{ href: '/threads', label: 'Threads', icon: Layers, match: (p) => p.startsWith('/threads') },
		{ href: '/library', label: 'Library', icon: Library, match: (p) => p.startsWith('/library') },
		{ href: '/graph', label: 'Graph', icon: Network, match: (p) => p.startsWith('/graph') },
		{ href: '/archive', label: 'Archive', icon: Archive, match: (p) => p.startsWith('/archive') }
	];
</script>

<aside
	class="panel flex h-full w-12 shrink-0 flex-col items-center gap-1 px-1.5 py-2"
	data-tauri-drag-region="false"
>
	<button
		class="rail-btn"
		onclick={() => (ui.commandPaletteOpen = true)}
		title="Search (⌘K)"
		aria-label="Search"
	>
		<Search class="h-4 w-4" stroke-width={1.5} />
	</button>
	<div class="my-1 h-px w-6 bg-border/70"></div>
	{#each items as item (item.href)}
		{@const Icon = item.icon}
		{@const active = item.match(page.url.pathname)}
		<a
			href={item.href}
			title={item.label}
			aria-label={item.label}
			class={cn('rail-btn', active && 'rail-btn-active')}
		>
			<Icon class="h-4 w-4" stroke-width={1.5} />
		</a>
	{/each}
	<a
		href="/settings"
		title="Settings"
		aria-label="Settings"
		class={cn('rail-btn mt-auto', page.url.pathname === '/settings' && 'rail-btn-active')}
	>
		<Settings class="h-4 w-4" stroke-width={1.5} />
	</a>
</aside>
