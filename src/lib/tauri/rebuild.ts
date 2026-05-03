import { db } from './db';
import {
	listPaperArxivIds,
	listThreadSlugs,
	paperPdfPath,
	readPaperMeta,
	readThreadMeta,
	ensureRootLayout
} from './fs';
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

	let threadCount = 0;
	let paperCount = 0;

	for (const slug of await listThreadSlugs()) {
		const tmeta = await readThreadMeta(slug);
		if (!tmeta) continue;
		const arxivIds = await listPaperArxivIds(slug);
		const papers: Paper[] = [];
		for (let i = 0; i < arxivIds.length; i++) {
			const arxivId = arxivIds[i];
			const pmeta = await readPaperMeta(slug, arxivId);
			if (!pmeta) continue;
			const pdfPath = await paperPdfPath(slug, arxivId);
			const paper: Paper = {
				id: pmeta.id,
				arxivId: pmeta.arxivId,
				title: pmeta.title,
				authors: pmeta.authors,
				abstract: pmeta.abstract,
				publishedDate: pmeta.publishedDate,
				categories: pmeta.categories,
				tags: pmeta.tags,
				readingStatus: pmeta.readingStatus,
				rating: pmeta.rating,
				arxivUrl: pmeta.arxivUrl,
				addedAt: pmeta.addedAt,
				links: pmeta.links,
				pdfPath,
				threadId: tmeta.id,
				orderInThread: pmeta.orderInThread ?? i,
				contextNote: pmeta.contextNote ?? ''
			};
			await db.addPaper(paper);
			papers.push(paper);
			paperCount++;
		}
		const thread: Thread = {
			id: tmeta.id,
			title: tmeta.title,
			question: tmeta.question,
			status: tmeta.status,
			papers: papers
				.sort((a, b) => (a.orderInThread ?? 0) - (b.orderInThread ?? 0))
				.map((p, idx) => ({
					paperId: p.id,
					contextNote: p.contextNote ?? '',
					order: p.orderInThread ?? idx
				})),
			createdAt: tmeta.createdAt,
			updatedAt: tmeta.updatedAt
		};
		await db.addThread(thread);
		threadCount++;
	}

	const durationMs = Date.now() - start;
	await db.setMeta('builtAt', new Date().toISOString());
	await db.setMeta('threads', String(threadCount));
	await db.setMeta('papers', String(paperCount));
	return { threads: threadCount, papers: paperCount, durationMs };
}
