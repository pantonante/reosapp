// Write layer for the two mutating tools (create_thread, add_paper). Kept
// apart from store.ts so the read path stays provably read-only. Layout and
// meta.json shapes mirror writeThreadMeta/writePaperMeta in
// ../../src/lib/tauri/fs.ts.
//
// The app reads from a SQLite cache, not the disk, so every write here ends
// with touchExternalChanges(): the app polls _reos/external-changes.json and
// pulls new threads/papers into its cache (src/lib/tauri/external-sync.ts).

import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	INBOX_SLUG,
	listPaperIds,
	paperDir,
	readPaperMeta,
	reosMetaDir,
	threadDir
} from './store.js';
import type { StoredPaper, StoredThread } from './types.js';

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

function freshId(prefix: 't' | 'p'): string {
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
