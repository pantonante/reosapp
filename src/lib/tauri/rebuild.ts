import { db } from './db';
import {
	listPaperArxivIds,
	listThreadSlugs,
	paperPdfPath,
	readPaperMeta,
	readPaperSummary,
	readThreadMeta,
	ensureRootLayout
} from './fs';
import { exists } from '@tauri-apps/plugin-fs';
import { isMetaEmpty, parseSummaryFrontmatter } from '$lib/summary-meta';
import type { Paper, Thread } from '$lib/types';

export interface RebuildResult {
	threads: number;
	papers: number;
	durationMs: number;
}

export async function rebuildCache(): Promise<RebuildResult> {
	const start = Date.now();
	await ensureRootLayout();
	await db.wipeAll();

	let paperCount = 0;
	const threads: Thread[] = [];
	const now = new Date().toISOString();

	for (const slug of await listThreadSlugs()) {
		const tmeta = await readThreadMeta(slug);
		if (!tmeta) continue;
		const arxivIds = await listPaperArxivIds(slug);
		const papers: Paper[] = [];
		for (let i = 0; i < arxivIds.length; i++) {
			const arxivId = arxivIds[i];
			const pmeta = await readPaperMeta(slug, arxivId);
			if (!pmeta) continue;
			// Webpage-papers have no paper.pdf on disk — only record pdfPath if
			// the file actually exists, otherwise leave it empty so the UI
			// branches into the webpage code paths.
			const candidatePdf = await paperPdfPath(slug, arxivId);
			const pdfPath = (await exists(candidatePdf)) ? candidatePdf : '';
			const paper: Paper = {
				...pmeta,
				pdfPath,
				threadId: tmeta.id,
				orderInThread: pmeta.orderInThread ?? i,
				contextNote: pmeta.contextNote ?? ''
			};
			await db.addPaper(paper);
			papers.push(paper);
			paperCount++;

			// wipeAll cleared summary_meta; repopulate it from summary.md so the
			// Graph view doesn't need a separate reindex after a rebuild.
			const summary = await readPaperSummary(slug, arxivId);
			if (summary) {
				const { meta } = parseSummaryFrontmatter(summary);
				if (meta && !isMetaEmpty(meta)) {
					await db.setSummaryMeta({
						paperId: paper.id,
						topics: meta.topics,
						domains: meta.domains,
						keywords: meta.keywords,
						updatedAt: now
					});
				}
			}
		}
		threads.push({
			...tmeta,
			parentId: tmeta.parentId ?? null,
			papers: papers
				.sort((a, b) => (a.orderInThread ?? 0) - (b.orderInThread ?? 0))
				.map((p, idx) => ({
					paperId: p.id,
					contextNote: p.contextNote ?? '',
					order: p.orderInThread ?? idx
				}))
		});
	}

	// Parents before children: parentId is a FK into threads. A child whose
	// parent folder is gone becomes a root thread instead of failing the rebuild.
	const known = new Set(threads.map((t) => t.id));
	const inserted = new Set<string>();
	const pending = threads.map((t) =>
		t.parentId && !known.has(t.parentId) ? { ...t, parentId: null } : t
	);
	while (pending.length) {
		let idx = pending.findIndex((t) => !t.parentId || inserted.has(t.parentId));
		// Only reachable with a parentId cycle on disk; break it at a root.
		if (idx === -1) {
			idx = 0;
			pending[0] = { ...pending[0], parentId: null };
		}
		const [t] = pending.splice(idx, 1);
		await db.addThread(t);
		inserted.add(t.id);
	}
	const threadCount = inserted.size;

	const durationMs = Date.now() - start;
	await db.setMeta('builtAt', new Date().toISOString());
	await db.setMeta('threads', String(threadCount));
	await db.setMeta('papers', String(paperCount));
	return { threads: threadCount, papers: paperCount, durationMs };
}
