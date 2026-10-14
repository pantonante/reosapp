import type { Paper, Thread, ReosConfig, SummaryMeta } from './types';
import { db } from './tauri/db';
import {
	writePaperMeta,
	writeThreadMeta,
	removePaperFolder,
	removeThreadFolder,
	movePaperFolder,
	INBOX_SLUG
} from './tauri/fs';
import { loadConfig, saveConfig as persistConfig } from './tauri/config';

// --- Papers store ---

function createPapersStore() {
	let items = $state<Paper[]>([]);
	let loaded = $state(false);

	return {
		get items() {
			return items;
		},
		set items(v: Paper[]) {
			items = v;
		},
		get loaded() {
			return loaded;
		},
		async load() {
			if (loaded) return;
			items = await db.getAllPapers();
			loaded = true;
		},
		async reload() {
			items = await db.getAllPapers();
			loaded = true;
		},
		get(id: string) {
			return items.find((i) => i.id === id || i.arxivId === id);
		},
		async add(p: Paper) {
			const slug = p.threadId ?? INBOX_SLUG;
			items = [{ ...p, threadId: slug }, ...items.filter((x) => x.id !== p.id)];
			await writePaperMeta(slug, { ...p, threadId: slug });
			await db.addPaper({ ...p, threadId: slug });
		},
		async update(id: string, patch: Partial<Paper>) {
			const current = items.find((i) => i.id === id);
			if (!current) return;
			const next = { ...current, ...patch };
			items = items.map((i) => (i.id === id ? next : i));
			const slug = next.threadId ?? INBOX_SLUG;
			await writePaperMeta(slug, next);
			await db.updatePaper(id, next);
		},
		async remove(id: string) {
			const current = items.find((i) => i.id === id);
			items = items.filter((i) => i.id !== id);
			ui.closePaper(id);
			if (summaryMeta.has(id)) {
				await summaryMeta.remove(id);
			}
			if (current) {
				await removePaperFolder(current.threadId ?? INBOX_SLUG, current.arxivId);
			}
			await db.removePaper(id);
			// The DB cascade drops thread_papers rows; mirror it in memory so the
			// next threads.update doesn't re-insert a dangling paperId.
			threads.forgetPaper(id);
		},
		// Moves a paper between threads (or to/from inbox). Handles disk relocation,
		// thread membership on both sides, and the paper's own threadId/pdfPath.
		// Disk first so DB never references a missing folder; not transactional.
		// Invariant: a paper belongs to at most one thread. Strips stray membership
		// from any thread other than the destination as a defensive guard.
		async move(id: string, toThreadId: string) {
			const current = items.find((i) => i.id === id);
			if (!current) return;
			const fromSlug = current.threadId ?? INBOX_SLUG;
			const toSlug = toThreadId || INBOX_SLUG;
			if (fromSlug === toSlug) return;
			const candidatePdfPath = await movePaperFolder(fromSlug, toSlug, current.arxivId);
			// Webpage-papers have no `paper.pdf` on disk — keep pdfPath empty
			// rather than pointing at a nonexistent file in the new thread.
			const newPdfPath = current.pdfPath ? candidatePdfPath : '';
			for (const t of threads.items) {
				if (t.id === toSlug) continue;
				if (t.papers.some((p) => p.paperId === id)) {
					await threads.update(t.id, {
						papers: t.papers.filter((p) => p.paperId !== id)
					});
				}
			}
			if (toSlug !== INBOX_SLUG) {
				const dest = threads.get(toSlug);
				if (dest && !dest.papers.some((p) => p.paperId === id)) {
					await threads.update(toSlug, {
						papers: [
							...dest.papers,
							{ paperId: id, contextNote: '', order: dest.papers.length }
						]
					});
				}
			}
			await this.update(id, { threadId: toSlug, pdfPath: newPdfPath });
		}
	};
}

// --- Threads store ---

// The "inbox" thread is an internal bucket for un-threaded papers; it must
// never appear in the user-visible threads list, the threads page, or as a tab.
const INBOX_THREAD_ID = 'inbox';

function createThreadsStore() {
	let items = $state<Thread[]>([]);
	let loaded = $state(false);

	function descendantIds(rootId: string): string[] {
		const out: string[] = [];
		const stack = [rootId];
		while (stack.length) {
			const id = stack.pop()!;
			for (const t of items) {
				if (t.parentId === id) {
					out.push(t.id);
					stack.push(t.id);
				}
			}
		}
		return out;
	}

	return {
		get items() {
			return items.filter((t) => t.id !== INBOX_THREAD_ID);
		},
		set items(v: Thread[]) {
			items = v;
		},
		/** In-memory only: drop a deleted paper from every thread's membership. */
		forgetPaper(paperId: string) {
			items = items.map((t) =>
				t.papers.some((tp) => tp.paperId === paperId)
					? { ...t, papers: t.papers.filter((tp) => tp.paperId !== paperId) }
					: t
			);
		},
		get loaded() {
			return loaded;
		},
		async load() {
			if (loaded) return;
			items = await db.getAllThreads();
			loaded = true;
		},
		async reload() {
			items = await db.getAllThreads();
			loaded = true;
		},
		get(id: string) {
			return items.find((i) => i.id === id);
		},
		async add(t: Thread) {
			items = [t, ...items.filter((x) => x.id !== t.id)];
			await writeThreadMeta(t.id, t);
			await db.addThread(t);
		},
		async update(id: string, patch: Partial<Thread>) {
			const current = items.find((i) => i.id === id);
			if (!current) return;
			if ('parentId' in patch) {
				const newParent = patch.parentId ?? null;
				if (id === INBOX_THREAD_ID && newParent !== null) {
					throw new Error('Inbox cannot be a sub-thread');
				}
				if (newParent === id) {
					throw new Error('A thread cannot be its own parent');
				}
				if (newParent) {
					// Walk ancestors of the proposed parent. If we hit this thread,
					// it would create a cycle.
					let cursor: string | null | undefined = newParent;
					const visited = new Set<string>();
					while (cursor) {
						if (cursor === id) {
							throw new Error('Cannot move a thread under one of its descendants');
						}
						if (visited.has(cursor)) break; // safety: existing data is well-formed
						visited.add(cursor);
						const node = items.find((t) => t.id === cursor);
						cursor = node?.parentId ?? null;
					}
				}
			}
			const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
			items = items.map((i) => (i.id === id ? next : i));
			await writeThreadMeta(id, next);
			await db.updateThread(id, next);
		},
		async remove(id: string) {
			// Cascade: delete deepest descendants first so each removeThreadFolder
			// sees an empty subtree on disk.
			const subtree = [...descendantIds(id), id];
			for (const tid of subtree) {
				const t = items.find((i) => i.id === tid);
				if (t) {
					const paperIds = t.papers.map((tp) => tp.paperId);
					for (const pid of paperIds) {
						await papers.move(pid, INBOX_SLUG);
					}
				}
				ui.closeThread(tid);
				items = items.filter((i) => i.id !== tid);
				await removeThreadFolder(tid);
				await db.removeThread(tid);
			}
		},
		descendantIds
	};
}

export const papers = createPapersStore();
export const threads = createThreadsStore();

/** Direct children of a thread (or roots when parentId is null). Excludes inbox. */
export function threadChildren(parentId: string | null): Thread[] {
	return threads.items.filter((t) => (t.parentId ?? null) === parentId);
}

/** Ancestors of a thread, ordered root → ... → immediate parent. Empty for roots. */
export function threadAncestors(id: string): Thread[] {
	const chain: Thread[] = [];
	let cursor: string | null | undefined = threads.get(id)?.parentId ?? null;
	const visited = new Set<string>();
	while (cursor) {
		if (visited.has(cursor)) break;
		visited.add(cursor);
		const t = threads.get(cursor);
		if (!t) break;
		chain.unshift(t);
		cursor = t.parentId ?? null;
	}
	return chain;
}

// --- Summary metadata store ---

function createSummaryMetaStore() {
	let items = $state<SummaryMeta[]>([]);
	let loaded = $state(false);
	let byId = new Map<string, SummaryMeta>();

	function rebuildIndex() {
		byId = new Map(items.map((m) => [m.paperId, m]));
	}

	return {
		get items() {
			return items;
		},
		get loaded() {
			return loaded;
		},
		async load() {
			if (loaded) return;
			items = await db.getAllSummaryMeta();
			rebuildIndex();
			loaded = true;
		},
		async reload() {
			items = await db.getAllSummaryMeta();
			rebuildIndex();
			loaded = true;
		},
		get(paperId: string): SummaryMeta | undefined {
			return byId.get(paperId);
		},
		has(paperId: string): boolean {
			return byId.has(paperId);
		},
		async set(meta: SummaryMeta) {
			await db.setSummaryMeta(meta);
			items = [...items.filter((m) => m.paperId !== meta.paperId), meta];
			rebuildIndex();
		},
		async remove(paperId: string) {
			await db.removeSummaryMeta(paperId);
			items = items.filter((m) => m.paperId !== paperId);
			rebuildIndex();
		}
	};
}

export const summaryMeta = createSummaryMetaStore();

// --- Config store ---

function createConfigStore() {
	let value = $state<ReosConfig>({ papersDir: null });
	let loaded = $state(false);

	return {
		get value() {
			return value;
		},
		get loaded() {
			return loaded;
		},
		async load() {
			value = await loadConfig();
			loaded = true;
		},
		async update(patch: Partial<ReosConfig>) {
			value = { ...value, ...patch };
			await persistConfig(value);
		}
	};
}

export const config = createConfigStore();

// --- UI state ---

function readLocal<T>(key: string, fallback: T): T {
	if (typeof localStorage === 'undefined') return fallback;
	const raw = localStorage.getItem(key);
	if (raw == null) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function writeLocal(key: string, value: unknown) {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(key, JSON.stringify(value));
}

// `temporary` mirrors VSCode's "preview" tabs: a single-click open lands in the
// one temporary tab (reusing/overriding it), while cmd-clicks and double-clicks
// produce permanent tabs. Absent/false means a permanent tab. There is at most
// one temporary tab at any time.
export type TabRef =
	| { kind: 'paper'; id: string; temporary?: boolean }
	| { kind: 'thread'; id: string; temporary?: boolean }
	| { kind: 'paper-chat'; id: string; temporary?: boolean }
	| { kind: 'thread-chat'; id: string; temporary?: boolean };

export type MainView = 'pdf' | 'summary' | 'chat';

export const ui = (() => {
	let commandPaletteOpen = $state(false);
	let quickOpenOpen = $state(false);
	let addPaperOpen = $state(false);
	let newThreadOpen = $state(false);
	let newThreadParentId = $state<string | null>(null);
	let bulkSummaryOpen = $state(false);
	let addPaperTargetThreadId = $state<string | null>(null);
	let sidebarCollapsed = $state(readLocal('reos:sidebarCollapsed', false));
	let pdfFullscreen = $state(false);
	let activePaperId = $state<string | null>(null);
	let activeThreadId = $state<string | null>(null);
	// Per-paper sub-view memory (pdf/summary/chat). In-memory only — resets on reload.
	let paperView = $state<Record<string, MainView>>({});
	// Tracks the tab matching the current route, set by the layout effect.
	// Used to know which tab to replace on a plain (non-cmd) click.
	let activeTab = $state<TabRef | null>(null);

	// Migrate legacy split-list storage into a unified tabOrder.
	let tabOrder = $state<TabRef[]>(readLocal<TabRef[]>('reos:tabOrder', []));
	if (tabOrder.length === 0) {
		const legacyPapers = readLocal<string[]>('reos:openPapers', []);
		const legacyThreads = readLocal<string[]>('reos:openThreads', []);
		if (legacyPapers.length || legacyThreads.length) {
			tabOrder = [
				...legacyPapers.map((id) => ({ kind: 'paper' as const, id })),
				...legacyThreads.map((id) => ({ kind: 'thread' as const, id }))
			];
			writeLocal('reos:tabOrder', tabOrder);
		}
	}
	// The inbox thread is sidebar-only — strip any stale tab that references it.
	const cleaned = tabOrder.filter(
		(t) =>
			!(
				(t.kind === 'thread' || t.kind === 'thread-chat') &&
				t.id === INBOX_THREAD_ID
			)
	);
	if (cleaned.length !== tabOrder.length) {
		tabOrder = cleaned;
		writeLocal('reos:tabOrder', tabOrder);
	}

	let threadsCompact = $state(readLocal('reos:threadsCompact', false));
	let lastPath = $state<string>(readLocal<string>('reos:lastPath', '/'));

	function persistTabs() {
		writeLocal('reos:tabOrder', tabOrder);
	}

	// Materialize a tab for `ref`, honoring the temporary-tab (preview) model:
	//  - if the item is already open, leave its tab and temporary state alone;
	//  - a `newTab` open (cmd/ctrl-click) appends a fresh permanent tab;
	//  - a plain open reuses the existing temporary tab if one exists (overriding
	//    its content in place), otherwise appends a new temporary tab.
	function placeTab(ref: TabRef, opts?: { newTab?: boolean }) {
		const existing = tabOrder.some((t) => t.kind === ref.kind && t.id === ref.id);
		if (existing) return;
		if (opts?.newTab) {
			tabOrder = [...tabOrder, { ...ref, temporary: false }];
			persistTabs();
			return;
		}
		const tempIdx = tabOrder.findIndex((t) => t.temporary);
		const next = { ...ref, temporary: true };
		if (tempIdx !== -1) {
			tabOrder = tabOrder.map((t, i) => (i === tempIdx ? next : t));
		} else {
			tabOrder = [...tabOrder, next];
		}
		persistTabs();
	}

	function paperIds(): string[] {
		return tabOrder.filter((t) => t.kind === 'paper').map((t) => t.id);
	}
	function threadIds(): string[] {
		return tabOrder.filter((t) => t.kind === 'thread').map((t) => t.id);
	}

	return {
		get commandPaletteOpen() {
			return commandPaletteOpen;
		},
		set commandPaletteOpen(v) {
			commandPaletteOpen = v;
		},
		get quickOpenOpen() {
			return quickOpenOpen;
		},
		set quickOpenOpen(v) {
			quickOpenOpen = v;
		},
		get newThreadOpen() {
			return newThreadOpen;
		},
		set newThreadOpen(v) {
			newThreadOpen = v;
			if (!v) newThreadParentId = null;
		},
		get newThreadParentId() {
			return newThreadParentId;
		},
		set newThreadParentId(v) {
			newThreadParentId = v;
		},
		get addPaperOpen() {
			return addPaperOpen;
		},
		set addPaperOpen(v) {
			addPaperOpen = v;
			// Clear the target thread on every close — bits-ui only fires
			// onOpenChange for user-initiated closes, so a successful import
			// (which sets addPaperOpen = false directly) would otherwise leave
			// the thread target sticky for the next "Add paper" from Inbox.
			if (!v) addPaperTargetThreadId = null;
		},
		get bulkSummaryOpen() {
			return bulkSummaryOpen;
		},
		set bulkSummaryOpen(v) {
			bulkSummaryOpen = v;
		},
		get addPaperTargetThreadId() {
			return addPaperTargetThreadId;
		},
		set addPaperTargetThreadId(v) {
			addPaperTargetThreadId = v;
		},
		get sidebarCollapsed() {
			return sidebarCollapsed;
		},
		set sidebarCollapsed(v) {
			sidebarCollapsed = v;
			writeLocal('reos:sidebarCollapsed', v);
		},
		get pdfFullscreen() {
			return pdfFullscreen;
		},
		set pdfFullscreen(v) {
			pdfFullscreen = v;
		},
		get activePaperId() {
			return activePaperId;
		},
		set activePaperId(v) {
			activePaperId = v;
		},
		get activeThreadId() {
			return activeThreadId;
		},
		set activeThreadId(v) {
			activeThreadId = v;
		},
		get activeTab() {
			return activeTab;
		},
		set activeTab(v) {
			activeTab = v;
		},
		get openPaperIds() {
			return paperIds();
		},
		get openThreadIds() {
			return threadIds();
		},
		get openTabs() {
			return tabOrder;
		},
		get threadsCompact() {
			return threadsCompact;
		},
		set threadsCompact(v) {
			threadsCompact = v;
			writeLocal('reos:threadsCompact', v);
		},
		get lastPath() {
			return lastPath;
		},
		set lastPath(v: string) {
			lastPath = v;
			writeLocal('reos:lastPath', v);
		},
		getPaperView(id: string): MainView {
			return paperView[id] ?? 'pdf';
		},
		setPaperView(id: string, v: MainView) {
			paperView = { ...paperView, [id]: v };
		},
		openPaper(id: string, opts?: { newTab?: boolean }) {
			placeTab({ kind: 'paper', id }, opts);
			activePaperId = id;
		},
		closePaper(id: string): string | null {
			const idx = tabOrder.findIndex((t) => t.kind === 'paper' && t.id === id);
			if (idx === -1) return null;
			// Drop the paper tab and any chat tab attached to it.
			tabOrder = tabOrder.filter(
				(t, i) => i !== idx && !(t.kind === 'paper-chat' && t.id === id)
			);
			persistTabs();
			if (activePaperId === id) {
				const remaining = paperIds();
				const next = remaining[Math.min(idx, remaining.length - 1)] ?? null;
				activePaperId = next;
				return next;
			}
			return activePaperId;
		},
		closeOtherPapers(id: string) {
			tabOrder = tabOrder.filter(
				(t) =>
					(t.kind !== 'paper' || t.id === id) &&
					(t.kind !== 'paper-chat' || t.id === id)
			);
			activePaperId = id;
			persistTabs();
		},
		closeAllPapers() {
			tabOrder = tabOrder.filter((t) => t.kind !== 'paper' && t.kind !== 'paper-chat');
			activePaperId = null;
			persistTabs();
		},
		openPaperChat(id: string) {
			// Chats are opened deliberately, so they always get a permanent tab.
			placeTab({ kind: 'paper-chat', id }, { newTab: true });
		},
		closePaperChat(id: string): string | null {
			const idx = tabOrder.findIndex((t) => t.kind === 'paper-chat' && t.id === id);
			if (idx === -1) return null;
			tabOrder = tabOrder.filter((_, i) => i !== idx);
			persistTabs();
			return activePaperId;
		},
		openThread(id: string, opts?: { newTab?: boolean }) {
			if (id === INBOX_THREAD_ID) {
				// Inbox is sidebar-only; don't materialize it as a tab.
				activeThreadId = id;
				return;
			}
			placeTab({ kind: 'thread', id }, opts);
			activeThreadId = id;
		},
		closeThread(id: string): string | null {
			const idx = tabOrder.findIndex((t) => t.kind === 'thread' && t.id === id);
			if (idx === -1) return null;
			// Drop the thread tab and any chat tab attached to it.
			tabOrder = tabOrder.filter(
				(t, i) => i !== idx && !(t.kind === 'thread-chat' && t.id === id)
			);
			persistTabs();
			if (activeThreadId === id) {
				const remaining = threadIds();
				const next = remaining[Math.min(idx, remaining.length - 1)] ?? null;
				activeThreadId = next;
				return next;
			}
			return activeThreadId;
		},
		closeAllThreads() {
			tabOrder = tabOrder.filter((t) => t.kind !== 'thread' && t.kind !== 'thread-chat');
			activeThreadId = null;
			persistTabs();
		},
		openThreadChat(id: string) {
			if (id === INBOX_THREAD_ID) return;
			// Chats are opened deliberately, so they always get a permanent tab.
			placeTab({ kind: 'thread-chat', id }, { newTab: true });
		},
		closeThreadChat(id: string): string | null {
			const idx = tabOrder.findIndex((t) => t.kind === 'thread-chat' && t.id === id);
			if (idx === -1) return null;
			tabOrder = tabOrder.filter((_, i) => i !== idx);
			persistTabs();
			return activeThreadId;
		},
		moveTab(from: TabRef, to: TabRef, position: 'before' | 'after') {
			const fromIdx = tabOrder.findIndex((t) => t.kind === from.kind && t.id === from.id);
			if (fromIdx === -1) return;
			const next = tabOrder.slice();
			const [moved] = next.splice(fromIdx, 1);
			let toIdx = next.findIndex((t) => t.kind === to.kind && t.id === to.id);
			if (toIdx === -1) return;
			if (position === 'after') toIdx += 1;
			next.splice(toIdx, 0, moved);
			tabOrder = next;
			persistTabs();
		},
		// Promote a temporary (preview) tab to a permanent one. Triggered by
		// double-clicking the tab; subsequent plain opens then create a new
		// temporary tab instead of overriding this one.
		pinTab(ref: TabRef) {
			let changed = false;
			tabOrder = tabOrder.map((t) => {
				if (t.kind === ref.kind && t.id === ref.id && t.temporary) {
					changed = true;
					return { ...t, temporary: false };
				}
				return t;
			});
			if (changed) persistTabs();
		},
		closeOtherTabs(tab: TabRef) {
			tabOrder = tabOrder.filter((t) => t.kind === tab.kind && t.id === tab.id);
			activePaperId =
				tab.kind === 'paper' || tab.kind === 'paper-chat' ? tab.id : null;
			activeThreadId =
				tab.kind === 'thread' || tab.kind === 'thread-chat' ? tab.id : null;
			persistTabs();
		},
		closeTabsToRight(tab: TabRef) {
			const idx = tabOrder.findIndex((t) => t.kind === tab.kind && t.id === tab.id);
			if (idx === -1) return;
			const removed = tabOrder.slice(idx + 1);
			tabOrder = tabOrder.slice(0, idx + 1);
			persistTabs();
			if (
				activePaperId &&
				removed.some((t) => t.kind === 'paper' && t.id === activePaperId)
			) {
				activePaperId = tab.kind === 'paper' ? tab.id : (paperIds().at(-1) ?? null);
			}
			if (
				activeThreadId &&
				removed.some((t) => t.kind === 'thread' && t.id === activeThreadId)
			) {
				activeThreadId = tab.kind === 'thread' ? tab.id : (threadIds().at(-1) ?? null);
			}
		}
	};
})();
