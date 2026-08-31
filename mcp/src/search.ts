// Reference resolution (thread/paper by id or title substring) and the
// live-scan paper search with simple field-weighted ranking.

import {
	listThreadSlugs,
	readThreadMeta,
	scanLibrary,
	type LibraryPaper
} from './store.js';
import type { ReadingStatus, StoredThread } from './types.js';

/** Raised when a ref doesn't resolve; message lists candidates when ambiguous. */
export class ResolveError extends Error {}

export interface ResolvedThread {
	slug: string;
	meta: StoredThread | null;
}

/** Resolve a thread by slug (exact) or case-insensitive title substring. */
export async function resolveThread(ref: string): Promise<ResolvedThread> {
	const slugs = await listThreadSlugs();
	const needle = ref.trim().toLowerCase();

	const exact = slugs.find((s) => s.toLowerCase() === needle);
	if (exact) return { slug: exact, meta: await readThreadMeta(exact) };

	const threads = await Promise.all(
		slugs.map(async (slug) => ({ slug, meta: await readThreadMeta(slug) }))
	);
	const matches = threads.filter((t) => t.meta?.title.toLowerCase().includes(needle));
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		const list = matches.map((t) => `  ${t.slug} — ${t.meta?.title}`).join('\n');
		throw new ResolveError(
			`Thread reference '${ref}' is ambiguous. Candidates:\n${list}\nUse the slug.`
		);
	}
	const known = threads
		.map((t) => `  ${t.slug} — ${t.meta?.title ?? '(no meta.json)'}`)
		.join('\n');
	throw new ResolveError(
		`No thread matches '${ref}' (by slug or title). Known threads:\n${known}`
	);
}

/** Resolve a paper by arxivId (exact) or title substring, optionally within a thread. */
export async function resolvePaper(ref: string, threadRef?: string): Promise<LibraryPaper> {
	let pool = await scanLibrary();
	if (threadRef) {
		const { slug } = await resolveThread(threadRef);
		pool = pool.filter((p) => p.threadSlug === slug);
	}
	const needle = ref.trim().toLowerCase();

	const exact = pool.filter((p) => p.meta.arxivId.toLowerCase() === needle);
	if (exact.length === 1) return exact[0];

	const byTitle = pool.filter((p) => p.meta.title.toLowerCase().includes(needle));
	if (byTitle.length === 1) return byTitle[0];
	if (byTitle.length > 1) {
		const list = byTitle
			.map((p) => `  ${p.meta.arxivId} — ${p.meta.title} (thread: ${p.threadSlug})`)
			.join('\n');
		throw new ResolveError(
			`Paper reference '${ref}' is ambiguous. Candidates:\n${list}\nUse the arxivId.`
		);
	}
	throw new ResolveError(
		`No paper matches '${ref}'${threadRef ? ` in thread '${threadRef}'` : ''} ` +
			`(by arxivId or title substring). Try search_papers to find it.`
	);
}

// --- Search ---

export interface SearchParams {
	query?: string;
	threadSlug?: string;
	status?: ReadingStatus;
	tags?: string[];
	limit: number;
	offset: number;
}

export interface SearchHit {
	paper: LibraryPaper;
	matched: string[];
}

export interface SearchResult {
	total: number;
	hits: SearchHit[];
}

/** All lowercase tag-like terms attached to a paper (meta tags + frontmatter). */
function tagUniverse(p: LibraryPaper): string[] {
	return [
		...p.meta.tags,
		...(p.frontmatter?.topics ?? []),
		...(p.frontmatter?.domains ?? []),
		...(p.frontmatter?.keywords ?? [])
	].map((t) => t.toLowerCase());
}

const FIELD_WEIGHTS: Array<{ field: string; weight: number; get: (p: LibraryPaper) => string }> = [
	{ field: 'title', weight: 3, get: (p) => p.meta.title },
	{ field: 'tags', weight: 2, get: (p) => tagUniverse(p).join(' ') },
	{ field: 'categories', weight: 2, get: (p) => p.meta.categories.join(' ') },
	{ field: 'abstract', weight: 1, get: (p) => p.meta.abstract },
	{ field: 'authors', weight: 1, get: (p) => p.meta.authors.join(' ') }
];

/** Every whitespace-separated query term must match at least one field (AND). */
function scorePaper(p: LibraryPaper, terms: string[]): { score: number; matched: string[] } {
	let score = 0;
	const matched = new Set<string>();
	for (const term of terms) {
		let termScore = 0;
		for (const { field, weight, get } of FIELD_WEIGHTS) {
			if (get(p).toLowerCase().includes(term)) {
				termScore += weight;
				matched.add(field);
			}
		}
		if (termScore === 0) return { score: 0, matched: [] };
		score += termScore;
	}
	return { score, matched: [...matched] };
}

export async function searchPapers(params: SearchParams): Promise<SearchResult> {
	let pool = await scanLibrary();
	if (params.threadSlug) pool = pool.filter((p) => p.threadSlug === params.threadSlug);
	if (params.status) pool = pool.filter((p) => p.meta.readingStatus === params.status);
	if (params.tags?.length) {
		const wanted = params.tags.map((t) => t.toLowerCase());
		pool = pool.filter((p) => {
			const universe = tagUniverse(p);
			return wanted.every((t) => universe.some((u) => u.includes(t)));
		});
	}

	const terms = (params.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
	let hits: Array<SearchHit & { score: number }>;
	if (terms.length) {
		hits = pool
			.map((paper) => ({ paper, ...scorePaper(paper, terms) }))
			.filter((h) => h.score > 0);
		hits.sort(
			(a, b) => b.score - a.score || (a.paper.meta.addedAt < b.paper.meta.addedAt ? 1 : -1)
		);
	} else {
		hits = pool.map((paper) => ({ paper, matched: [], score: 0 }));
		hits.sort((a, b) => (a.paper.meta.addedAt < b.paper.meta.addedAt ? 1 : -1));
	}

	return {
		total: hits.length,
		hits: hits.slice(params.offset, params.offset + params.limit)
	};
}
