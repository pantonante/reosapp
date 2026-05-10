import {
	BaseDirectory,
	exists,
	mkdir,
	readDir,
	readTextFile,
	remove,
	rename,
	writeFile,
	writeTextFile
} from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import type { ChatMessage, ChatSummary, Paper, Thread } from '$lib/types';
import { loadConfig } from './config';

const INBOX_SLUG = 'inbox';

async function papersRoot(): Promise<string> {
	const cfg = await loadConfig();
	if (!cfg.papersDir) throw new Error('Papers folder not configured');
	return cfg.papersDir;
}

export function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9-_]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60) || 'thread';
}

export async function ensureRootLayout(): Promise<void> {
	const root = await papersRoot();
	const threadsDir = await join(root, 'threads');
	if (!(await exists(threadsDir))) await mkdir(threadsDir, { recursive: true });
	await ensureReosMetaDir();
	const inbox = await join(threadsDir, INBOX_SLUG);
	if (!(await exists(inbox))) {
		await mkdir(inbox, { recursive: true });
		await mkdir(await join(inbox, 'papers'), { recursive: true });
		await writeTextFile(
			await join(inbox, 'meta.json'),
			JSON.stringify(
				{
					id: 'inbox',
					title: 'Inbox',
					question: '',
					status: 'active',
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString()
				},
				null,
				2
			)
		);
	}
}

export async function threadDir(slug: string): Promise<string> {
	const root = await papersRoot();
	return join(root, 'threads', slug);
}

export async function paperDir(threadSlug: string, arxivId: string): Promise<string> {
	const tdir = await threadDir(threadSlug);
	return join(tdir, 'papers', arxivId);
}

// Shared `_reos/` meta folder at the papers root. Hosts files we want the
// Claude CLI to read across runs (vocabulary.md today, possibly more later).
// Exposed to the agent via a second `--add-dir` from chat.rs.
export async function reosMetaDir(): Promise<string> {
	return join(await papersRoot(), '_reos');
}

export async function ensureReosMetaDir(): Promise<string> {
	const dir = await reosMetaDir();
	if (!(await exists(dir))) await mkdir(dir, { recursive: true });
	return dir;
}

export async function writeVocabularyFile(content: string): Promise<void> {
	const dir = await ensureReosMetaDir();
	await writeTextFile(await join(dir, 'vocabulary.md'), content);
}

// --- Thread meta ---

type StoredThread = Omit<Thread, 'papers'>;

export async function readThreadMeta(slug: string): Promise<StoredThread | null> {
	const path = await join(await threadDir(slug), 'meta.json');
	if (!(await exists(path))) return null;
	const raw = await readTextFile(path);
	return JSON.parse(raw) as StoredThread;
}

export async function writeThreadMeta(slug: string, t: Thread): Promise<void> {
	const dir = await threadDir(slug);
	if (!(await exists(dir))) await mkdir(dir, { recursive: true });
	const papersDir = await join(dir, 'papers');
	if (!(await exists(papersDir))) await mkdir(papersDir, { recursive: true });
	const meta: StoredThread = {
		id: t.id,
		title: t.title,
		question: t.question,
		status: t.status,
		createdAt: t.createdAt,
		updatedAt: t.updatedAt
	};
	await writeTextFile(await join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

// --- Paper meta + PDF + notes ---

type StoredPaper = Omit<Paper, 'threadId' | 'pdfPath'>;

export async function readPaperMeta(threadSlug: string, arxivId: string): Promise<StoredPaper | null> {
	const path = await join(await paperDir(threadSlug, arxivId), 'meta.json');
	if (!(await exists(path))) return null;
	const raw = await readTextFile(path);
	return JSON.parse(raw) as StoredPaper;
}

export async function writePaperMeta(threadSlug: string, p: Paper): Promise<void> {
	const dir = await paperDir(threadSlug, p.arxivId);
	if (!(await exists(dir))) await mkdir(dir, { recursive: true });
	const meta: StoredPaper = {
		id: p.id,
		arxivId: p.arxivId,
		title: p.title,
		authors: p.authors,
		abstract: p.abstract,
		publishedDate: p.publishedDate,
		categories: p.categories,
		tags: p.tags,
		readingStatus: p.readingStatus,
		rating: p.rating,
		arxivUrl: p.arxivUrl,
		addedAt: p.addedAt,
		links: p.links,
		orderInThread: p.orderInThread,
		contextNote: p.contextNote
	};
	await writeTextFile(await join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

export async function writePaperPdf(
	threadSlug: string,
	arxivId: string,
	bytes: Uint8Array
): Promise<string> {
	const dir = await paperDir(threadSlug, arxivId);
	if (!(await exists(dir))) await mkdir(dir, { recursive: true });
	const pdfPath = await join(dir, 'paper.pdf');
	await writeFile(pdfPath, bytes);
	return pdfPath;
}

export async function paperPdfPath(threadSlug: string, arxivId: string): Promise<string> {
	return join(await paperDir(threadSlug, arxivId), 'paper.pdf');
}

export async function readNotes(threadSlug: string, arxivId: string): Promise<string> {
	const path = await join(await paperDir(threadSlug, arxivId), 'notes.md');
	if (!(await exists(path))) return '';
	return await readTextFile(path);
}

export async function writeNotes(
	threadSlug: string,
	arxivId: string,
	content: string
): Promise<void> {
	const dir = await paperDir(threadSlug, arxivId);
	if (!(await exists(dir))) await mkdir(dir, { recursive: true });
	await writeTextFile(await join(dir, 'notes.md'), content);
}

export async function paperSummaryPath(threadSlug: string, arxivId: string): Promise<string> {
	return join(await paperDir(threadSlug, arxivId), 'summary.md');
}

export async function readPaperSummary(
	threadSlug: string,
	arxivId: string
): Promise<string | null> {
	const path = await paperSummaryPath(threadSlug, arxivId);
	if (!(await exists(path))) return null;
	return await readTextFile(path);
}

export async function removePaperFolder(threadSlug: string, arxivId: string): Promise<void> {
	const dir = await paperDir(threadSlug, arxivId);
	if (await exists(dir)) await remove(dir, { recursive: true });
}

// Relocates a paper's folder between threads. Returns the new paper.pdf path.
// If from === to, no-op. Caller is responsible for updating DB rows / store state.
export async function movePaperFolder(
	fromSlug: string,
	toSlug: string,
	arxivId: string
): Promise<string> {
	if (fromSlug === toSlug) {
		return paperPdfPath(toSlug, arxivId);
	}
	const fromDir = await paperDir(fromSlug, arxivId);
	const toDir = await paperDir(toSlug, arxivId);
	const toThreadDir = await threadDir(toSlug);
	const toPapersDir = await join(toThreadDir, 'papers');
	if (!(await exists(toThreadDir))) await mkdir(toThreadDir, { recursive: true });
	if (!(await exists(toPapersDir))) await mkdir(toPapersDir, { recursive: true });
	if (await exists(toDir)) {
		// Destination already has a folder for this arxivId — clear it before
		// renaming, otherwise the rename will fail on most platforms.
		await remove(toDir, { recursive: true });
	}
	if (await exists(fromDir)) {
		await rename(fromDir, toDir);
	} else {
		// Source missing (e.g., paper was added but pdf write failed) — still
		// create the destination so subsequent writes have somewhere to go.
		await mkdir(toDir, { recursive: true });
	}
	return join(toDir, 'paper.pdf');
}

export async function removeThreadFolder(slug: string): Promise<void> {
	if (slug === INBOX_SLUG) return; // never remove inbox
	const dir = await threadDir(slug);
	if (await exists(dir)) await remove(dir, { recursive: true });
}

// --- Chat history ---

export async function paperChatsDir(threadSlug: string, arxivId: string): Promise<string> {
	return join(await paperDir(threadSlug, arxivId), 'chats');
}

/** Sortable timestamp-based id, e.g. 2026-05-03T15-10-50-123Z. */
export function newPaperChatId(): string {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

const CHAT_TITLE_MAX = 60;

function deriveTitle(firstMsg: ChatMessage | null): string {
	if (!firstMsg) return 'New chat';
	const text = firstMsg.content.trim().replace(/\s+/g, ' ');
	if (!text) return 'New chat';
	return text.length > CHAT_TITLE_MAX ? text.slice(0, CHAT_TITLE_MAX) + '…' : text;
}

export async function listPaperChats(
	threadSlug: string,
	arxivId: string
): Promise<ChatSummary[]> {
	const dir = await paperChatsDir(threadSlug, arxivId);
	if (!(await exists(dir))) return [];
	const entries = await readDir(dir);
	const summaries: ChatSummary[] = [];
	for (const e of entries) {
		if (!e.isFile || !e.name.endsWith('.jsonl')) continue;
		const id = e.name.slice(0, -'.jsonl'.length);
		const path = await join(dir, e.name);
		const msgs = parseJsonl(await readTextFile(path));
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

export async function readPaperChat(
	threadSlug: string,
	arxivId: string,
	chatId: string
): Promise<ChatMessage[]> {
	const path = await join(await paperChatsDir(threadSlug, arxivId), `${chatId}.jsonl`);
	if (!(await exists(path))) return [];
	return parseJsonl(await readTextFile(path));
}

export async function appendPaperChat(
	threadSlug: string,
	arxivId: string,
	chatId: string,
	msg: ChatMessage
): Promise<void> {
	const dir = await paperChatsDir(threadSlug, arxivId);
	if (!(await exists(dir))) await mkdir(dir, { recursive: true });
	const path = await join(dir, `${chatId}.jsonl`);
	const prev = (await exists(path)) ? await readTextFile(path) : '';
	await writeTextFile(path, prev + JSON.stringify(msg) + '\n');
}

// --- Thread-level chats (multi-chat, mirrors paper chats) ---

export async function threadChatsDir(threadSlug: string): Promise<string> {
	return join(await threadDir(threadSlug), 'chats');
}

export function newThreadChatId(): string {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function listThreadChats(threadSlug: string): Promise<ChatSummary[]> {
	const dir = await threadChatsDir(threadSlug);
	if (!(await exists(dir))) return [];
	const entries = await readDir(dir);
	const summaries: ChatSummary[] = [];
	for (const e of entries) {
		if (!e.isFile || !e.name.endsWith('.jsonl')) continue;
		const id = e.name.slice(0, -'.jsonl'.length);
		const path = await join(dir, e.name);
		const msgs = parseJsonl(await readTextFile(path));
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

export async function readThreadChat(
	threadSlug: string,
	chatId: string
): Promise<ChatMessage[]> {
	const path = await join(await threadChatsDir(threadSlug), `${chatId}.jsonl`);
	if (!(await exists(path))) return [];
	return parseJsonl(await readTextFile(path));
}

export async function appendThreadChat(
	threadSlug: string,
	chatId: string,
	msg: ChatMessage
): Promise<void> {
	const dir = await threadChatsDir(threadSlug);
	if (!(await exists(dir))) await mkdir(dir, { recursive: true });
	const path = await join(dir, `${chatId}.jsonl`);
	const prev = (await exists(path)) ? await readTextFile(path) : '';
	await writeTextFile(path, prev + JSON.stringify(msg) + '\n');
}

function parseJsonl(text: string): ChatMessage[] {
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

// --- Scan helpers (for cache rebuild) ---

export async function listThreadSlugs(): Promise<string[]> {
	const root = await papersRoot();
	const threadsDir = await join(root, 'threads');
	if (!(await exists(threadsDir))) return [];
	const entries = await readDir(threadsDir);
	return entries.filter((e) => e.isDirectory).map((e) => e.name);
}

export async function listPaperArxivIds(threadSlug: string): Promise<string[]> {
	const papersFolder = await join(await threadDir(threadSlug), 'papers');
	if (!(await exists(papersFolder))) return [];
	const entries = await readDir(papersFolder);
	return entries.filter((e) => e.isDirectory).map((e) => e.name);
}

export { INBOX_SLUG, BaseDirectory };
