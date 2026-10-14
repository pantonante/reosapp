<script lang="ts">
	import 'katex/dist/katex.min.css';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { papers, threads, ui, type TabRef } from '$lib/stores.svelte';
	import { cn } from '$lib/utils/cn';
	import { renderTitleHtml } from '$lib/utils/render-title';
	import { X, Layers, MessageSquare } from 'lucide-svelte';

	type Tab =
		| { kind: 'paper'; id: string; title: string; status: string; temporary: boolean }
		| { kind: 'thread'; id: string; title: string; temporary: boolean }
		| { kind: 'paper-chat'; id: string; title: string; temporary: boolean }
		| { kind: 'thread-chat'; id: string; title: string; temporary: boolean };

	const tabs = $derived.by<Tab[]>(() => {
		const out: Tab[] = [];
		for (const ref of ui.openTabs) {
			const temporary = ref.temporary ?? false;
			if (ref.kind === 'paper') {
				const p = papers.get(ref.id);
				if (p)
					out.push({ kind: 'paper', id: ref.id, title: p.title, status: p.readingStatus, temporary });
			} else if (ref.kind === 'thread') {
				const t = threads.get(ref.id);
				if (t) out.push({ kind: 'thread', id: ref.id, title: t.title, temporary });
			} else if (ref.kind === 'paper-chat') {
				const p = papers.get(ref.id);
				if (p) out.push({ kind: 'paper-chat', id: ref.id, title: p.title, temporary });
			} else if (ref.kind === 'thread-chat') {
				const t = threads.get(ref.id);
				if (t) out.push({ kind: 'thread-chat', id: ref.id, title: t.title, temporary });
			}
		}
		return out;
	});

	function tabPath(tab: Tab): string {
		switch (tab.kind) {
			case 'paper':
				return `/paper/${tab.id}`;
			case 'thread':
				return `/threads/${tab.id}`;
			case 'paper-chat':
				return `/paper/${tab.id}/chat`;
			case 'thread-chat':
				return `/threads/${tab.id}/chat`;
		}
	}

	function isActive(tab: Tab): boolean {
		return page.url.pathname === tabPath(tab);
	}

	function activate(tab: Tab) {
		// Guard: if the tab is no longer open (e.g. close handler bubbled here
		// with a stale reference), don't navigate — that would re-add it via
		// the [id] page's openPaper effect.
		if (!ui.openTabs.some((t) => t.kind === tab.kind && t.id === tab.id)) return;
		if (tab.kind === 'paper' || tab.kind === 'paper-chat') ui.activePaperId = tab.id;
		else ui.activeThreadId = tab.id;
		goto(tabPath(tab));
	}

	function close(tab: Tab, e: MouseEvent) {
		e.stopPropagation();
		const wasActive = isActive(tab);
		// Closing a paper/thread also drops its attached chat tab.
		const removed = (t: Tab) =>
			t.id === tab.id &&
			(t.kind === tab.kind ||
				(tab.kind === 'paper' && t.kind === 'paper-chat') ||
				(tab.kind === 'thread' && t.kind === 'thread-chat'));
		// Fall back to the tab on the left, else the one on the right, else the inbox.
		const idx = indexOfTab(tab);
		const next =
			tabs.slice(0, idx).findLast((t) => !removed(t)) ??
			tabs.slice(idx + 1).find((t) => !removed(t)) ??
			null;
		switch (tab.kind) {
			case 'paper':
				ui.closePaper(tab.id);
				break;
			case 'thread':
				ui.closeThread(tab.id);
				break;
			case 'paper-chat':
				ui.closePaperChat(tab.id);
				break;
			case 'thread-chat':
				ui.closeThreadChat(tab.id);
				break;
		}
		if (wasActive) {
			if (next) activate(next);
			else goto('/');
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

	function handleKey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
			const active = tabs.find((t) => isActive(t));
			if (!active) return;
			e.preventDefault();
			close(active, new MouseEvent('click'));
		}
	}
</script>

<svelte:window
	onclick={closeMenu}
	onkeydown={(e) => {
		if (e.key === 'Escape') closeMenu();
		handleKey(e);
	}}
/>

{#if tabs.length > 0}
	<div
		class="no-scrollbar flex h-10 items-center gap-1 overflow-x-auto border-b border-border/60 px-2"
		onwheel={(e) => {
			if (e.deltaY === 0) return;
			const el = e.currentTarget;
			if (el.scrollWidth <= el.clientWidth) return;
			el.scrollLeft += e.deltaY;
			e.preventDefault();
		}}
	>
		{#each tabs as tab, i (tab.kind + tab.id)}
			{#if i > 0}
				<span class="h-3.5 w-px shrink-0 bg-border/50" aria-hidden="true"></span>
			{/if}
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
					'group relative flex h-7 cursor-pointer select-none items-center gap-2 rounded-[8px] border border-transparent px-2.5 text-xs transition-colors',
					active
						? 'border-border/70 bg-secondary text-foreground'
						: 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
					tab.temporary && 'italic',
					draggingKey === key && 'opacity-40'
				)}
				style="-webkit-user-drag: element;"
				onclick={() => activate(tab)}
				ondblclick={() => ui.pinTab({ kind: tab.kind, id: tab.id })}
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
				{:else if tab.kind === 'thread'}
					<Layers class="h-3 w-3" />
				{:else}
					<MessageSquare class="h-3 w-3" />
				{/if}
				<span class="tab-title max-w-[16ch] truncate" title={tab.kind === 'paper-chat' || tab.kind === 'thread-chat' ? `Chat: ${tab.title}` : tab.title}>{#if tab.kind === 'paper-chat' || tab.kind === 'thread-chat'}<span class="text-muted-foreground">Chat: </span>{/if}{@html renderTitleHtml(tab.title)}</span>
				<button
					type="button"
					class="rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-foreground/10 group-hover:opacity-100"
					onclick={(e) => {
						e.stopPropagation();
						e.preventDefault();
						close(tab, e);
					}}
					onpointerdown={(e) => e.stopPropagation()}
					onmousedown={(e) => e.stopPropagation()}
					aria-label="Close tab"
				>
					<X class="h-3 w-3" />
				</button>
				{#if showAfter}
					<span class="pointer-events-none absolute -right-px top-0 z-10 h-full w-0.5 bg-accent"></span>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	/* KaTeX defaults to 1.21em and adds a small inline-block which can push the
	   tab a couple of pixels taller. Pin it to the tab's text size and let it
	   sit on the text baseline. */
	.tab-title :global(.katex) {
		font-size: 1em;
		line-height: 1;
	}
	.tab-title :global(.katex-html) {
		white-space: nowrap;
	}
</style>

{#if menu}
	{@const m = menu}
	<div
		role="menu"
		tabindex="-1"
		class="panel fixed z-50 min-w-[180px] overflow-hidden py-1 text-xs text-popover-foreground"
		style="left: {m.x}px; top: {m.y}px;"
		onclick={(e) => e.stopPropagation()}
		oncontextmenu={(e) => e.preventDefault()}
		onkeydown={(e) => e.stopPropagation()}
	>
		<button
			type="button"
			class="block w-full px-3 py-1.5 text-left hover:bg-secondary disabled:opacity-40 disabled:hover:bg-transparent"
			onclick={() => {
				close(m.tab, new MouseEvent('click'));
				closeMenu();
			}}
		>
			Close
		</button>
		<button
			type="button"
			class="block w-full px-3 py-1.5 text-left hover:bg-secondary disabled:opacity-40 disabled:hover:bg-transparent"
			disabled={!hasOthers(m.tab)}
			onclick={() => doCloseOthers(m.tab)}
		>
			Close all other
		</button>
		<button
			type="button"
			class="block w-full px-3 py-1.5 text-left hover:bg-secondary disabled:opacity-40 disabled:hover:bg-transparent"
			disabled={!hasRight(m.tab)}
			onclick={() => doCloseToRight(m.tab)}
		>
			Close to the right
		</button>
	</div>
{/if}
