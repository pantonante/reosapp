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
			if (current) {
				await removePaperFolder(current.threadId ?? INBOX_SLUG, current.arxivId);
			}
			await db.removePaper(id);
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
			const newPdfPath = await movePaperFolder(fromSlug, toSlug, current.arxivId);
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

	return {
		get items() {
			return items.filter((t) => t.id !== INBOX_THREAD_ID);
		},
		set items(v: Thread[]) {
			items = v;
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
			const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
			items = items.map((i) => (i.id === id ? next : i));
			await writeThreadMeta(id, next);
			await db.updateThread(id, next);
		},
		async remove(id: string) {
			const thread = items.find((i) => i.id === id);
			// Move every paper out to inbox first; otherwise removeThreadFolder
			// would also delete the papers' PDFs/notes/chat that live inside.
			if (thread) {
				const paperIds = thread.papers.map((tp) => tp.paperId);
				for (const pid of paperIds) {
					await papers.move(pid, INBOX_SLUG);
				}
			}
			items = items.filter((i) => i.id !== id);
			await removeThreadFolder(id);
			await db.removeThread(id);
		}
	};
}

export const papers = createPapersStore();
export const threads = createThreadsStore();

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

export type TabRef = { kind: 'paper' | 'thread'; id: string };

export const ui = (() => {
	let commandPaletteOpen = $state(false);
	let quickOpenOpen = $state(false);
	let addPaperOpen = $state(false);
	let newThreadOpen = $state(false);
	let addPaperTargetThreadId = $state<string | null>(null);
	let sidebarCollapsed = $state(readLocal('reos:sidebarCollapsed', false));
	let pdfFullscreen = $state(false);
	let activePaperId = $state<string | null>(null);
	let activeThreadId = $state<string | null>(null);

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
	const cleaned = tabOrder.filter((t) => !(t.kind === 'thread' && t.id === INBOX_THREAD_ID));
	if (cleaned.length !== tabOrder.length) {
		tabOrder = cleaned;
		writeLocal('reos:tabOrder', tabOrder);
	}

	let threadsCompact = $state(readLocal('reos:threadsCompact', false));

	function persistTabs() {
		writeLocal('reos:tabOrder', tabOrder);
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
		},
		get addPaperOpen() {
			return addPaperOpen;
		},
		set addPaperOpen(v) {
			addPaperOpen = v;
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
		openPaper(id: string) {
			if (!tabOrder.some((t) => t.kind === 'paper' && t.id === id)) {
				tabOrder = [...tabOrder, { kind: 'paper', id }];
				persistTabs();
			}
			activePaperId = id;
		},
		closePaper(id: string): string | null {
			const idx = tabOrder.findIndex((t) => t.kind === 'paper' && t.id === id);
			if (idx === -1) return null;
			tabOrder = tabOrder.filter((_, i) => i !== idx);
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
			tabOrder = tabOrder.filter((t) => t.kind !== 'paper' || t.id === id);
			activePaperId = id;
			persistTabs();
		},
		closeAllPapers() {
			tabOrder = tabOrder.filter((t) => t.kind !== 'paper');
			activePaperId = null;
			persistTabs();
		},
		openThread(id: string) {
			if (id === INBOX_THREAD_ID) {
				// Inbox is sidebar-only; don't materialize it as a tab.
				activeThreadId = id;
				return;
			}
			if (!tabOrder.some((t) => t.kind === 'thread' && t.id === id)) {
				tabOrder = [...tabOrder, { kind: 'thread', id }];
				persistTabs();
			}
			activeThreadId = id;
		},
		closeThread(id: string): string | null {
			const idx = tabOrder.findIndex((t) => t.kind === 'thread' && t.id === id);
			if (idx === -1) return null;
			tabOrder = tabOrder.filter((_, i) => i !== idx);
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
			tabOrder = tabOrder.filter((t) => t.kind !== 'thread');
			activeThreadId = null;
			persistTabs();
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
		closeOtherTabs(tab: TabRef) {
			tabOrder = tabOrder.filter((t) => t.kind === tab.kind && t.id === tab.id);
			activePaperId = tab.kind === 'paper' ? tab.id : null;
			activeThreadId = tab.kind === 'thread' ? tab.id : null;
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
