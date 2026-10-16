// Pulls threads/papers written to disk by something other than the app (the
// MCP server's create_thread/add_paper) into the SQLite cache. Writers bump
// `_reos/external-changes.json`; we only rescan when its stamp is newer than
// the last one we synced, so polling it is a single small file read.
//
// Additive by design: new threads, new papers, papers whose folder moved to
// another thread, and PDFs attached to papers that had none. Deletions on disk
// are left to a full "Rebuild cache". Thread notes aren't cached at all — a
// fresh stamp just tells open note views to re-read the disk.

import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import type { Paper, Thread } from '$lib/types';
import { db } from './db';
import {
	INBOX_SLUG,
	listPaperArxivIds,
	listThreadSlugs,
	paperPdfPath,
	readPaperMeta,
	readThreadMeta,
	reosMetaDir
} from './fs';

const SYNCED_KEY = 'externalSyncedAt';

async function readChangeStamp(): Promise<string | null> {
	const path = await join(await reosMetaDir(), 'external-changes.json');
	if (!(await exists(path))) return null;
	try {
		const parsed = JSON.parse(await readTextFile(path)) as { updatedAt?: unknown };
		return typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
	} catch {
		return null;
	}
}

export interface ExternalSyncResult {
	/** An external writer touched the library since the last sync. */
	stale: boolean;
	/** The cache changed and the paper/thread stores should reload. */
	changed: boolean;
}

export async function syncExternalChanges(): Promise<ExternalSyncResult> {
	const stamp = await readChangeStamp();
	if (!stamp) return { stale: false, changed: false };
	const synced = await db.getMeta(SYNCED_KEY);
	if (synced && synced >= stamp) return { stale: false, changed: false };

	const threads = new Map((await db.getAllThreads()).map((t) => [t.id, t]));
	const papersByArxiv = new Map((await db.getAllPapers()).map((p) => [p.arxivId, p]));
	// Membership edits are batched per thread and written once at the end.
	const dirty = new Set<string>();
	let changed = false;

	const newThreads: Thread[] = [];
	const slugs = await listThreadSlugs();
	for (const slug of slugs) {
		if (threads.has(slug)) continue;
		const meta = await readThreadMeta(slug);
		if (!meta) continue;
		newThreads.push({ ...meta, papers: [] });
	}
	// Parents before children so a parentId never points at a missing row.
	while (newThreads.length) {
		const idx = newThreads.findIndex((t) => !t.parentId || threads.has(t.parentId));
		const [t] = newThreads.splice(idx === -1 ? 0 : idx, 1);
		await db.addThread(t);
		threads.set(t.id, t);
		changed = true;
	}

	for (const slug of slugs) {
		const thread = threads.get(slug);
		if (!thread) continue;
		for (const arxivId of await listPaperArxivIds(slug)) {
			const existing = papersByArxiv.get(arxivId);
			const candidatePdf = await paperPdfPath(slug, arxivId);
			if (existing && (existing.threadId ?? INBOX_SLUG) === slug) {
				// Unchanged unless a PDF was attached to a webpage-style paper.
				if (existing.pdfPath || !(await exists(candidatePdf))) continue;
				await db.updatePaper(existing.id, { pdfPath: candidatePdf });
				changed = true;
				continue;
			}
			const meta = await readPaperMeta(slug, arxivId);
			if (!meta) continue;
			const pdfPath = (await exists(candidatePdf)) ? candidatePdf : '';

			if (existing) {
				// Folder moved between threads: drop the old membership.
				const from = threads.get(existing.threadId ?? INBOX_SLUG);
				if (from) {
					from.papers = from.papers.filter((tp) => tp.paperId !== existing.id);
					dirty.add(from.id);
				}
			}
			const paper: Paper = {
				...meta,
				id: existing?.id ?? meta.id,
				pdfPath,
				threadId: slug
			};
			await db.addPaper(paper);
			papersByArxiv.set(arxivId, paper);
			// Inbox has no membership rows, matching AddPaperModal.attachToThread.
			if (slug !== INBOX_SLUG && !thread.papers.some((tp) => tp.paperId === paper.id)) {
				thread.papers = [
					...thread.papers,
					{
						paperId: paper.id,
						contextNote: meta.contextNote ?? '',
						order: meta.orderInThread ?? thread.papers.length
					}
				];
				dirty.add(slug);
			}
			changed = true;
		}
	}

	for (const id of dirty) {
		const t = threads.get(id);
		if (t) await db.addThread(t);
	}
	await db.setMeta(SYNCED_KEY, stamp);
	return { stale: true, changed };
}
