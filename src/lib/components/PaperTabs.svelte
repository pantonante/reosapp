<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { papers, threads, ui, type TabRef } from '$lib/stores.svelte';
	import { cn } from '$lib/utils/cn';
	import { X, Layers } from 'lucide-svelte';

	type Tab =
		| { kind: 'paper'; id: string; title: string; status: string }
		| { kind: 'thread'; id: string; title: string };

	const tabs = $derived.by<Tab[]>(() => {
		const out: Tab[] = [];
		for (const ref of ui.openTabs) {
			if (ref.kind === 'paper') {
				const p = papers.get(ref.id);
				if (p) out.push({ kind: 'paper', id: ref.id, title: p.title, status: p.readingStatus });
			} else {
				const t = threads.get(ref.id);
				if (t) out.push({ kind: 'thread', id: ref.id, title: t.title });
			}
		}
		return out;
	});

	function isActive(tab: Tab): boolean {
		if (tab.kind === 'paper') return page.url.pathname === `/paper/${tab.id}`;
		return page.url.pathname === `/threads/${tab.id}`;
	}

	function activate(tab: Tab) {
		if (tab.kind === 'paper') {
			ui.activePaperId = tab.id;
			goto(`/paper/${tab.id}`);
		} else {
			ui.activeThreadId = tab.id;
			goto(`/threads/${tab.id}`);
		}
	}

	function close(tab: Tab, e: MouseEvent) {
		e.stopPropagation();
		const wasActive = isActive(tab);
		const next = tab.kind === 'paper' ? ui.closePaper(tab.id) : ui.closeThread(tab.id);
		if (wasActive) {
			if (next) {
				goto(tab.kind === 'paper' ? `/paper/${next}` : `/threads/${next}`);
			} else {
				goto('/');
			}
		}
	}

	function statusDot(status: string): string {
		switch (status) {
			case 'reading':
				return 'bg-yellow-500';
			case 'read':
				return 'bg-green-500';
			case 'archived':
				return 'bg-muted-foreground';
			default:
				return 'bg-muted-foreground/40';
		}
	}

	let draggingKey = $state<string | null>(null);
	let dropTargetKey = $state<string | null>(null);
	let dropPosition = $state<'before' | 'after'>('before');

	function tabKey(tab: Tab | TabRef): string {
		return `${tab.kind}:${tab.id}`;
	}

	function parseKey(key: string): TabRef | null {
		const [kind, ...rest] = key.split(':');
		if (kind !== 'paper' && kind !== 'thread') return null;
		return { kind, id: rest.join(':') };
	}

	function onDragStart(tab: Tab, e: DragEvent) {
		if (!e.dataTransfer) return;
		draggingKey = tabKey(tab);
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', tabKey(tab));
	}

	function onDragOver(tab: Tab, e: DragEvent) {
		if (!draggingKey) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		const target = e.currentTarget as HTMLElement;
		const rect = target.getBoundingClientRect();
		const before = e.clientX < rect.left + rect.width / 2;
		dropTargetKey = tabKey(tab);
		dropPosition = before ? 'before' : 'after';
	}

	function onDrop(tab: Tab, e: DragEvent) {
		e.preventDefault();
		const data = e.dataTransfer?.getData('text/plain') || draggingKey;
		const targetKey = tabKey(tab);
		const position = dropPosition;
		draggingKey = null;
		dropTargetKey = null;
		if (!data) return;
		const from = parseKey(data);
		const to = parseKey(targetKey);
		if (!from || !to) return;
		if (from.kind === to.kind && from.id === to.id) return;
		ui.moveTab(from, to, position);
	}

	function onDragEnd() {
		draggingKey = null;
		dropTargetKey = null;
	}

	let menu = $state<{ tab: Tab; x: number; y: number } | null>(null);

	function indexOfTab(tab: Tab): number {
		return tabs.findIndex((t) => t.kind === tab.kind && t.id === tab.id);
	}

	function hasOthers(tab: Tab): boolean {
		return tabs.some((t) => !(t.kind === tab.kind && t.id === tab.id));
	}

	function hasRight(tab: Tab): boolean {
		const idx = indexOfTab(tab);
		return idx >= 0 && idx < tabs.length - 1;
	}

	function openMenu(tab: Tab, e: MouseEvent) {
		e.preventDefault();
		menu = { tab, x: e.clientX, y: e.clientY };
	}

	function closeMenu() {
		menu = null;
	}

	function navigateAfterClose(removedActive: Tab | null) {
		if (!removedActive) return;
		const path =
			removedActive.kind === 'paper'
				? ui.activePaperId
					? `/paper/${ui.activePaperId}`
					: '/'
				: ui.activeThreadId
					? `/threads/${ui.activeThreadId}`
					: '/';
		goto(path);
	}

	function doCloseOthers(tab: Tab) {
		const activeWasRemoved = tabs.some(
			(t) => isActive(t) && !(t.kind === tab.kind && t.id === tab.id)
		);
		ui.closeOtherTabs({ kind: tab.kind, id: tab.id });
		closeMenu();
		if (activeWasRemoved) activate(tab);
	}

	function doCloseToRight(tab: Tab) {
		const idx = indexOfTab(tab);
		const removed = idx >= 0 ? tabs.slice(idx + 1) : [];
		const activeWasRemoved = removed.some((t) => isActive(t));
		ui.closeTabsToRight({ kind: tab.kind, id: tab.id });
		closeMenu();
		if (activeWasRemoved) navigateAfterClose(tab);
	}
</script>

<svelte:window
	onclick={closeMenu}
	onkeydown={(e) => {
		if (e.key === 'Escape') closeMenu();
	}}
/>

{#if tabs.length > 0}
	<div class="flex h-9 items-stretch overflow-x-auto border-b border-border/60 bg-card">
		{#each tabs as tab (tab.kind + tab.id)}
			{@const active = isActive(tab)}
			{@const key = tabKey(tab)}
			{@const showBefore = dropTargetKey === key && dropPosition === 'before' && draggingKey !== key}
			{@const showAfter = dropTargetKey === key && dropPosition === 'after' && draggingKey !== key}
			<div
				role="tab"
				tabindex="0"
				aria-selected={active}
				draggable="true"
				class={cn(
					'group relative flex cursor-pointer select-none items-center gap-2 border-r border-border/60 px-3 text-xs transition-colors',
					active
						? 'bg-background text-foreground'
						: 'text-muted-foreground hover:bg-background/50 hover:text-foreground',
					draggingKey === key && 'opacity-40'
				)}
				style="-webkit-user-drag: element;"
				onclick={() => activate(tab)}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						activate(tab);
					}
				}}
				onmouseup={(e) => {
					if (e.button === 1) close(tab, e);
				}}
				oncontextmenu={(e) => openMenu(tab, e)}
				ondragstart={(e) => onDragStart(tab, e)}
				ondragover={(e) => onDragOver(tab, e)}
				ondragleave={(e) => {
					// Only clear if we're leaving the tab entirely, not its children
					const related = e.relatedTarget as Node | null;
					if (related && (e.currentTarget as HTMLElement).contains(related)) return;
					if (dropTargetKey === key) dropTargetKey = null;
				}}
				ondrop={(e) => onDrop(tab, e)}
				ondragend={onDragEnd}
			>
				{#if showBefore}
					<span class="pointer-events-none absolute -left-px top-0 z-10 h-full w-0.5 bg-accent"></span>
				{/if}
				{#if tab.kind === 'paper'}
					<span class={cn('h-1.5 w-1.5 rounded-full', statusDot(tab.status))}></span>
				{:else}
					<Layers class="h-3 w-3" />
				{/if}
				<span class="max-w-[16ch] truncate">{tab.title}</span>
				<span
					role="button"
					tabindex="0"
					class="rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-accent/15 group-hover:opacity-100"
					onclick={(e) => close(tab, e)}
					onkeydown={(e) => {
						if (e.key === 'Enter') close(tab, e as unknown as MouseEvent);
					}}
					aria-label="Close tab"
				>
					<X class="h-3 w-3" />
				</span>
				{#if showAfter}
					<span class="pointer-events-none absolute -right-px top-0 z-10 h-full w-0.5 bg-accent"></span>
				{/if}
			</div>
		{/each}
	</div>
{/if}

{#if menu}
	{@const m = menu}
	<div
		role="menu"
		tabindex="-1"
		class="fixed z-50 min-w-[180px] overflow-hidden rounded-md border border-border/60 bg-popover py-1 text-xs text-popover-foreground shadow-lg"
		style="left: {m.x}px; top: {m.y}px;"
		onclick={(e) => e.stopPropagation()}
		oncontextmenu={(e) => e.preventDefault()}
		onkeydown={(e) => e.stopPropagation()}
	>
		<button
			type="button"
			class="block w-full px-3 py-1.5 text-left hover:bg-accent/15 disabled:opacity-40 disabled:hover:bg-transparent"
			onclick={() => {
				close(m.tab, new MouseEvent('click'));
				closeMenu();
			}}
		>
			Close
		</button>
		<button
			type="button"
			class="block w-full px-3 py-1.5 text-left hover:bg-accent/15 disabled:opacity-40 disabled:hover:bg-transparent"
			disabled={!hasOthers(m.tab)}
			onclick={() => doCloseOthers(m.tab)}
		>
			Close all other
		</button>
		<button
			type="button"
			class="block w-full px-3 py-1.5 text-left hover:bg-accent/15 disabled:opacity-40 disabled:hover:bg-transparent"
			disabled={!hasRight(m.tab)}
			onclick={() => doCloseToRight(m.tab)}
		>
			Close to the right
		</button>
	</div>
{/if}
