<script lang="ts">
	import { page } from '$app/state';
	import { ui } from '$lib/stores.svelte';
	import { cn } from '$lib/utils/cn';
	import { Inbox, Library, Layers, Archive, Settings, Search, ChevronLeft, ChevronRight } from 'lucide-svelte';

	type NavItem = { href: string; label: string; icon: typeof Inbox; match: (p: string) => boolean };

	const items: NavItem[] = [
		{ href: '/', label: 'Inbox', icon: Inbox, match: (p) => p === '/' },
		{ href: '/threads', label: 'Threads', icon: Layers, match: (p) => p.startsWith('/threads') },
		{ href: '/library', label: 'Library', icon: Library, match: (p) => p.startsWith('/library') },
		{ href: '/archive', label: 'Archive', icon: Archive, match: (p) => p.startsWith('/archive') }
	];
</script>

<aside
	class={cn(
		'flex h-full shrink-0 flex-col border-r border-border/60 bg-card transition-[width] duration-150',
		ui.sidebarCollapsed ? 'w-14' : 'w-52'
	)}
>
	<button
		class={cn(
			'mx-2 mt-2 flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent/10 hover:text-foreground',
			ui.sidebarCollapsed && 'justify-center'
		)}
		onclick={() => (ui.commandPaletteOpen = true)}
		title={ui.sidebarCollapsed ? 'Search (⌘K)' : undefined}
	>
		<Search class="h-3.5 w-3.5" />
		{#if !ui.sidebarCollapsed}
			<span class="flex-1 text-left">Search</span>
			<kbd class="rounded border border-border/60 px-1 font-mono text-[10px]">⌘K</kbd>
		{/if}
	</button>

	<nav class="mt-2 flex flex-1 flex-col gap-0.5 px-2">
		{#each items as item (item.href)}
			{@const Icon = item.icon}
			{@const active = item.match(page.url.pathname)}
			<a
				href={item.href}
				class={cn(
					'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
					active
						? 'bg-accent/15 text-accent'
						: 'text-muted-foreground hover:bg-accent/10 hover:text-foreground',
					ui.sidebarCollapsed && 'justify-center'
				)}
				title={ui.sidebarCollapsed ? item.label : undefined}
			>
				<Icon class="h-4 w-4" />
				{#if !ui.sidebarCollapsed}
					<span>{item.label}</span>
				{/if}
			</a>
		{/each}
	</nav>

	<div
		class={cn(
			'mt-auto flex items-center border-t border-border/60 px-2 py-2',
			ui.sidebarCollapsed ? 'flex-col gap-1' : 'gap-1'
		)}
	>
		<a
			href="/settings"
			class={cn(
				'flex flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
				page.url.pathname === '/settings'
					? 'bg-accent/15 text-accent'
					: 'text-muted-foreground hover:bg-accent/10 hover:text-foreground',
				ui.sidebarCollapsed && 'flex-none justify-center'
			)}
			title={ui.sidebarCollapsed ? 'Settings' : undefined}
		>
			<Settings class="h-4 w-4" />
			{#if !ui.sidebarCollapsed}
				<span>Settings</span>
			{/if}
		</a>
		<button
			class="rounded-md p-1.5 text-muted-foreground hover:bg-accent/10 hover:text-foreground"
			onclick={() => (ui.sidebarCollapsed = !ui.sidebarCollapsed)}
			aria-label={ui.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
		>
			{#if ui.sidebarCollapsed}
				<ChevronRight class="h-4 w-4" />
			{:else}
				<ChevronLeft class="h-4 w-4" />
			{/if}
		</button>
	</div>
</aside>
