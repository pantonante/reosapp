// Write layer for the mutating tools (create_thread, add_paper, create_note,
// update_note). Kept apart from store.ts so the read path stays provably
// read-only. Layout and meta.json shapes mirror writeThreadMeta/writePaperMeta
// in ../../src/lib/tauri/fs.ts; note files mirror ../../src/lib/tauri/notes.ts.
//
// The app reads from a SQLite cache, not the disk, so every write here ends
// with touchExternalChanges(): the app polls _reos/external-changes.json and
// pulls new threads/papers into its cache (src/lib/tauri/external-sync.ts)
// and re-reads the open thread's notes.

import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
	MEDIA_EXTENSIONS,
	NOTE_MEDIA_DIR,
	mediaFileName,
	serializeNote
} from './note-format.js';
import {
	INBOX_SLUG,
	listPaperIds,
	paperDir,
	readPaperMeta,
	reosMetaDir,
	threadDir,
	threadNotesDir
} from './store.js';
import type { StoredPaper, StoredThread, ThreadNote } from './types.js';

/** Expected, caller-fixable failures (bad media path, …). */
export class MutateInputError extends Error {}

export const EXTERNAL_CHANGES_FILE = 'external-changes.json';

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, JSON.stringify(value, null, 2));
}

/** Bump the marker the app watches to know its cache is stale. */
export async function touchExternalChanges(): Promise<void> {
	const dir = await reosMetaDir();
	await mkdir(dir, { recursive: true });
	await writeJson(join(dir, EXTERNAL_CHANGES_FILE), {
		updatedAt: new Date().toISOString(),
		source: 'reos-mcp-server'
	});
}

/** Mirror of ensureRootLayout's inbox bootstrap, for libraries never opened in the app. */
export async function ensureInbox(): Promise<void> {
	const dir = await threadDir(INBOX_SLUG);
	if (await exists(join(dir, 'meta.json'))) return;
	await mkdir(join(dir, 'papers'), { recursive: true });
	const now = new Date().toISOString();
	const meta: StoredThread = {
		id: INBOX_SLUG,
		title: 'Inbox',
		question: '',
		status: 'active',
		createdAt: now,
		updatedAt: now,
		parentId: null
	};
	await writeJson(join(dir, 'meta.json'), meta);
}

// Timestamp ids (`t…`/`p…`) match the app's own. Kept strictly increasing
// within this process so back-to-back creates in one millisecond can't collide.
let lastStamp = 0;

function freshId(prefix: 't' | 'p' | 'n'): string {
	lastStamp = Math.max(Date.now(), lastStamp + 1);
	return `${prefix}${lastStamp}`;
}

export async function createThread(input: {
	title: string;
	question: string;
	parentId: string | null;
}): Promise<StoredThread> {
	let id = freshId('t');
	while (await exists(await threadDir(id))) id = freshId('t');
	const now = new Date().toISOString();
	const meta: StoredThread = {
		id,
		title: input.title,
		question: input.question,
		status: 'active',
		createdAt: now,
		updatedAt: now,
		parentId: input.parentId
	};
	const dir = await threadDir(id);
	await mkdir(join(dir, 'papers'), { recursive: true });
	await writeJson(join(dir, 'meta.json'), meta);
	await touchExternalChanges();
	return meta;
}

/** Next orderInThread slot: one past the highest recorded order (or the paper count). */
async function nextOrder(threadSlug: string): Promise<number> {
	const ids = await listPaperIds(threadSlug);
	let max = ids.length - 1;
	for (const id of ids) {
		const order = (await readPaperMeta(threadSlug, id))?.orderInThread;
		if (typeof order === 'number' && order > max) max = order;
	}
	return max + 1;
}

export interface NewPaper {
	arxivId: string;
	title: string;
	authors: string[];
	abstract: string;
	publishedDate: string;
	categories: string[];
	tags: string[];
	arxivUrl: string;
	sourceUrl?: string;
	contextNote?: string;
}

/**
 * Persist a new paper into `threadSlug`. The PDF is written before meta.json
 * so a failed import never leaves a folder the app would pick up; on any
 * error the half-written folder is removed.
 */
export async function writeNewPaper(
	threadSlug: string,
	paper: NewPaper,
	pdf: Uint8Array | null
): Promise<{ meta: StoredPaper; pdfPath: string | null }> {
	if (threadSlug === INBOX_SLUG) await ensureInbox();
	const dir = await paperDir(threadSlug, paper.arxivId);
	if (await exists(dir)) {
		throw new Error(`A folder for ${paper.arxivId} already exists in thread '${threadSlug}'.`);
	}
	const id = freshId('p');
	const meta: StoredPaper = {
		id,
		arxivId: paper.arxivId,
		title: paper.title,
		authors: paper.authors,
		abstract: paper.abstract,
		publishedDate: paper.publishedDate,
		categories: paper.categories,
		tags: paper.tags,
		readingStatus: 'unread',
		rating: null,
		arxivUrl: paper.arxivUrl,
		addedAt: new Date().toISOString(),
		links: [],
		sourceUrl: paper.sourceUrl,
		orderInThread: threadSlug === INBOX_SLUG ? undefined : await nextOrder(threadSlug),
		contextNote: paper.contextNote || undefined
	};
	let pdfPath: string | null = null;
	try {
		await mkdir(dir, { recursive: true });
		if (pdf) {
			pdfPath = join(dir, 'paper.pdf');
			await writeFile(pdfPath, pdf);
		}
		await writeJson(join(dir, 'meta.json'), meta);
	} catch (err) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
		throw err;
	}
	await touchExternalChanges();
	return { meta, pdfPath };
}

/**
 * File an existing paper into another thread (the app's papers.move): moves
 * the whole folder — PDF, notes, highlights, chats — and updates its
 * order/context note.
 */
export async function movePaper(
	fromSlug: string,
	toSlug: string,
	arxivId: string,
	contextNote: string | undefined
): Promise<StoredPaper> {
	const fromDir = await paperDir(fromSlug, arxivId);
	const toDir = await paperDir(toSlug, arxivId);
	if (await exists(toDir)) {
		throw new Error(`Thread '${toSlug}' already has a folder for ${arxivId}.`);
	}
	const current = await readPaperMeta(fromSlug, arxivId);
	if (!current) throw new Error(`Paper ${arxivId} has no meta.json in thread '${fromSlug}'.`);
	const orderInThread = await nextOrder(toSlug);
	await mkdir(join(await threadDir(toSlug), 'papers'), { recursive: true });
	await rename(fromDir, toDir);
	const next: StoredPaper = {
		...current,
		orderInThread,
		contextNote: contextNote || current.contextNote
	};
	await writeJson(join(toDir, 'meta.json'), next);
	await touchExternalChanges();
	return next;
}

/** Add a PDF to a paper saved without one (webpage papers, failed discovery). */
export async function attachPdf(
	threadSlug: string,
	arxivId: string,
	pdf: Uint8Array
): Promise<string> {
	const pdfPath = join(await paperDir(threadSlug, arxivId), 'paper.pdf');
	if (await exists(pdfPath)) throw new Error(`${arxivId} already has a PDF at ${pdfPath}.`);
	await writeFile(pdfPath, pdf);
	await touchExternalChanges();
	return pdfPath;
}

// --- Thread notes ---

const MD_IMAGE_RE = /(!\[[^\]]*\]\(\s*)(<[^>]+>|[^)\s]+)((?:\s+"[^"]*")?\s*\))/g;
const HTML_SRC_RE = /(\bsrc=)(["'])([^"']+)\2/g;

/** An absolute local path (`/…`, `~/…`, `file://…`) — the only refs we import. */
function localPath(ref: string): string | null {
	let p = ref.trim();
	if (p.startsWith('<') && p.endsWith('>')) p = p.slice(1, -1);
	if (/^file:\/\//i.test(p)) p = p.replace(/^file:\/\//i, '');
	else if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
	else if (!p.startsWith('/')) return null;
	try {
		return decodeURIComponent(p);
	} catch {
		return p;
	}
}

/**
 * Copy every image/video the markdown references by absolute local path into
 * the thread's notes/media/ folder and rewrite the reference to the relative
 * `media/<file>` form the app renders. URLs and existing media/ refs are left
 * untouched.
 */
async function importLocalMedia(
	threadSlug: string,
	content: string
): Promise<{ content: string; imported: string[] }> {
	const sources = new Set<string>();
	for (const m of content.matchAll(MD_IMAGE_RE)) {
		const p = localPath(m[2]);
		if (p) sources.add(p);
	}
	for (const m of content.matchAll(HTML_SRC_RE)) {
		const p = localPath(m[3]);
		if (p) sources.add(p);
	}
	if (!sources.size) return { content, imported: [] };

	const mediaDir = join(await threadNotesDir(threadSlug), NOTE_MEDIA_DIR);
	await mkdir(mediaDir, { recursive: true });
	const rewritten = new Map<string, string>();
	for (const src of sources) {
		const ext = src.split('.').pop()?.toLowerCase() ?? '';
		if (!MEDIA_EXTENSIONS.includes(ext)) {
			throw new MutateInputError(
				`'${src}' is not a supported image/video (${MEDIA_EXTENSIONS.join(', ')}).`
			);
		}
		let info;
		try {
			info = await stat(src);
		} catch {
			throw new MutateInputError(`Media file not found: ${src}`);
		}
		if (!info.isFile()) throw new MutateInputError(`Not a file: ${src}`);
		let name = mediaFileName(basename(src));
		for (let i = 1; await exists(join(mediaDir, name)); i++) {
			name = `${i}-${mediaFileName(basename(src))}`;
		}
		await copyFile(src, join(mediaDir, name));
		rewritten.set(src, `${NOTE_MEDIA_DIR}/${name}`);
	}

	const swap = (ref: string) => {
		const p = localPath(ref);
		return (p && rewritten.get(p)) ?? ref;
	};
	const next = content
		.replace(MD_IMAGE_RE, (_all, pre: string, ref: string, post: string) => pre + swap(ref) + post)
		.replace(HTML_SRC_RE, (_all, pre: string, q: string, ref: string) => `${pre}${q}${swap(ref)}${q}`);
	return { content: next, imported: [...rewritten.values()] };
}

async function writeNoteFile(threadSlug: string, note: ThreadNote): Promise<string> {
	const dir = await threadNotesDir(threadSlug);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${note.id}.md`);
	await writeFile(path, serializeNote(note));
	return path;
}

export interface NoteWriteResult {
	note: ThreadNote;
	path: string;
	/** `media/<file>` refs copied in from local paths. */
	imported: string[];
}

export async function createNote(
	threadSlug: string,
	input: { title: string; content: string }
): Promise<NoteWriteResult> {
	let id = freshId('n');
	while (await exists(join(await threadNotesDir(threadSlug), `${id}.md`))) id = freshId('n');
	const { content, imported } = await importLocalMedia(threadSlug, input.content);
	const now = new Date().toISOString();
	const note: ThreadNote = { id, title: input.title, content, createdAt: now, updatedAt: now };
	const path = await writeNoteFile(threadSlug, note);
	await touchExternalChanges();
	return { note, path, imported };
}

export async function updateNote(
	threadSlug: string,
	current: ThreadNote,
	patch: { title?: string; content?: string; mode: 'replace' | 'append' }
): Promise<NoteWriteResult> {
	let body = current.content;
	let imported: string[] = [];
	if (patch.content !== undefined) {
		const res = await importLocalMedia(threadSlug, patch.content);
		imported = res.imported;
		body =
			patch.mode === 'append'
				? `${current.content.replace(/\s+$/, '')}${current.content.trim() ? '\n\n' : ''}${res.content}`
				: res.content;
	}
	const note: ThreadNote = {
		...current,
		title: patch.title ?? current.title,
		content: body,
		updatedAt: new Date().toISOString()
	};
	const path = await writeNoteFile(threadSlug, note);
	await touchExternalChanges();
	return { note, path, imported };
}
