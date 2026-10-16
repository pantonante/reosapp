// Read-only filesystem layer over the Re:OS library. Path joins and read
// semantics mirror ../../src/lib/tauri/fs.ts (same names where possible).
// STRICTLY read-only: only readFile/readdir/stat are imported — never add
// write/mkdir/rename/unlink here. The few writes the server makes live in
// mutate.ts.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { papersRoot } from './config.js';
import { NOTES_DIR, parseNote } from './note-format.js';
import { parseSummaryFrontmatter, type ParsedSummary } from './summary-meta.js';
import type {
	ChatMessage,
	ChatSummary,
	PaperHighlight,
	StoredPaper,
	StoredThread,
	SummaryFrontmatter,
	ThreadNote
} from './types.js';

export const INBOX_SLUG = 'inbox';

// --- Path joins (mirror fs.ts) ---

export async function threadDir(slug: string): Promise<string> {
	return join(await papersRoot(), 'threads', slug);
}

export async function paperDir(threadSlug: string, arxivId: string): Promise<string> {
	return join(await threadDir(threadSlug), 'papers', arxivId);
}

export async function paperPdfPath(threadSlug: string, arxivId: string): Promise<string> {
	return join(await paperDir(threadSlug, arxivId), 'paper.pdf');
}

export async function threadChatsDir(threadSlug: string): Promise<string> {
	return join(await threadDir(threadSlug), 'chats');
}

export async function paperChatsDir(threadSlug: string, arxivId: string): Promise<string> {
	return join(await paperDir(threadSlug, arxivId), 'chats');
}

export async function threadNotesDir(threadSlug: string): Promise<string> {
	return join(await threadDir(threadSlug), NOTES_DIR);
}

export async function reosMetaDir(): Promise<string> {
	return join(await papersRoot(), '_reos');
}

// --- Low-level cached reads ---
// Google Drive placeholder files can fail mid-read; any read error is treated
// as "file missing", matching the app's ''/[]/null-on-absence semantics.

const parseCache = new Map<string, { mtimeMs: number; value: unknown }>();

export async function fileExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

export async function readTextOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, 'utf-8');
	} catch {
		return null;
	}
}

/** Mtime-cached parse of a file; null when missing/unreadable/malformed. */
async function cachedParse<T>(path: string, parse: (raw: string) => T): Promise<T | null> {
	let mtimeMs: number;
	try {
		mtimeMs = (await stat(path)).mtimeMs;
	} catch {
		parseCache.delete(path);
		return null;
	}
	const hit = parseCache.get(path);
	if (hit && hit.mtimeMs === mtimeMs) return hit.value as T;
	const raw = await readTextOrNull(path);
	if (raw === null) return null;
	try {
		const value = parse(raw);
		parseCache.set(path, { mtimeMs, value });
		return value;
	} catch {
		return null;
	}
}

async function listSubdirs(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

async function listFiles(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((e) => e.isFile()).map((e) => e.name);
	} catch {
		return [];
	}
}

// --- Threads ---

export async function listThreadSlugs(): Promise<string[]> {
	return listSubdirs(join(await papersRoot(), 'threads'));
}

export async function readThreadMeta(slug: string): Promise<StoredThread | null> {
	const path = join(await threadDir(slug), 'meta.json');
	return cachedParse(path, (raw) => JSON.parse(raw) as StoredThread);
}

/** Non-meta markdown artifacts at the thread root (agent-written files). */
export async function listThreadArtifacts(slug: string): Promise<string[]> {
	const files = await listFiles(await threadDir(slug));
	return files.filter((f) => f.endsWith('.md')).sort();
}

// --- Thread notes ---

/** Notes in creation order (the app's display order). */
export async function listThreadNotes(threadSlug: string): Promise<ThreadNote[]> {
	const dir = await threadNotesDir(threadSlug);
	const notes: ThreadNote[] = [];
	for (const name of await listFiles(dir)) {
		if (!name.endsWith('.md')) continue;
		const note = await readThreadNote(threadSlug, name.slice(0, -'.md'.length));
		if (note) notes.push(note);
	}
	notes.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
	return notes;
}

export async function readThreadNote(
	threadSlug: string,
	noteId: string
): Promise<ThreadNote | null> {
	const path = join(await threadNotesDir(threadSlug), `${noteId}.md`);
	let mtime: Date;
	try {
		mtime = (await stat(path)).mtime;
	} catch {
		return null;
	}
	const raw = await readTextOrNull(path);
	return raw === null ? null : parseNote(noteId, raw, mtime.toISOString());
}

// --- Papers ---

export async function listPaperIds(threadSlug: string): Promise<string[]> {
	return listSubdirs(join(await threadDir(threadSlug), 'papers'));
}

export async function readPaperMeta(
	threadSlug: string,
	arxivId: string
): Promise<StoredPaper | null> {
	const path = join(await paperDir(threadSlug, arxivId), 'meta.json');
	return cachedParse(path, (raw) => JSON.parse(raw) as StoredPaper);
}

export async function readPaperSummary(
	threadSlug: string,
	arxivId: string
): Promise<ParsedSummary | null> {
	const path = join(await paperDir(threadSlug, arxivId), 'summary.md');
	return cachedParse(path, parseSummaryFrontmatter);
}

export async function readNotes(threadSlug: string, arxivId: string): Promise<string> {
	const path = join(await paperDir(threadSlug, arxivId), 'notes.md');
	return (await readTextOrNull(path)) ?? '';
}

export async function readPaperHighlights(
	threadSlug: string,
	arxivId: string
): Promise<PaperHighlight[]> {
	const path = join(await paperDir(threadSlug, arxivId), 'highlights.json');
	const parsed = await cachedParse(path, (raw) => JSON.parse(raw) as unknown);
	if (!Array.isArray(parsed)) return [];
	// Lighter validation than the app (fs.ts:183): we only render text + page.
	return parsed.filter((item): item is PaperHighlight => {
		if (!item || typeof item !== 'object') return false;
		const h = item as Partial<PaperHighlight>;
		return (
			typeof h.id === 'string' &&
			typeof h.text === 'string' &&
			typeof h.createdAt === 'string' &&
			Array.isArray(h.areas)
		);
	});
}

// --- Chats (mirror fs.ts:296-420) ---

const CHAT_TITLE_MAX = 60;

function deriveTitle(firstMsg: ChatMessage | null): string {
	if (!firstMsg) return 'New chat';
	const text = firstMsg.content.trim().replace(/\s+/g, ' ');
	if (!text) return 'New chat';
	return text.length > CHAT_TITLE_MAX ? text.slice(0, CHAT_TITLE_MAX) + '…' : text;
}

export function parseJsonl(text: string): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const line of text.split('\n')) {
		const trim = line.trim();
		if (!trim) continue;
		try {
			out.push(JSON.parse(trim) as ChatMessage);
		} catch {
			// skip malformed lines
		}
	}
	return out;
}

export async function listChatsIn(dir: string): Promise<ChatSummary[]> {
	const summaries: ChatSummary[] = [];
	for (const name of await listFiles(dir)) {
		if (!name.endsWith('.jsonl')) continue;
		const id = name.slice(0, -'.jsonl'.length);
		const msgs = parseJsonl((await readTextOrNull(join(dir, name))) ?? '');
		const first = msgs[0] ?? null;
		const last = msgs[msgs.length - 1] ?? null;
		summaries.push({
			id,
			title: deriveTitle(first),
			updatedAt: last?.createdAt ?? first?.createdAt ?? id,
			messageCount: msgs.length
		});
	}
	summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	return summaries;
}

export async function readChatIn(dir: string, chatId: string): Promise<ChatMessage[]> {
	return parseJsonl((await readTextOrNull(join(dir, `${chatId}.jsonl`))) ?? '');
}

export async function countChatsIn(dir: string): Promise<number> {
	return (await listFiles(dir)).filter((f) => f.endsWith('.jsonl')).length;
}

// --- Library scan (search backbone) ---

export interface LibraryPaper {
	threadSlug: string;
	meta: StoredPaper;
	frontmatter: SummaryFrontmatter | null;
}

/**
 * Live scan of every paper's meta.json + summary.md frontmatter. ~150 small
 * cached reads for a 72-paper library — tens of milliseconds; no index needed.
 */
export async function scanLibrary(): Promise<LibraryPaper[]> {
	const out: LibraryPaper[] = [];
	for (const slug of await listThreadSlugs()) {
		const ids = await listPaperIds(slug);
		const papers = await Promise.all(
			ids.map(async (arxivId) => {
				const meta = await readPaperMeta(slug, arxivId);
				if (!meta) return null;
				const summary = await readPaperSummary(slug, arxivId);
				return { threadSlug: slug, meta, frontmatter: summary?.meta ?? null };
			})
		);
		for (const p of papers) if (p) out.push(p);
	}
	return out;
}
