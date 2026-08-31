import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { Paper } from './types';

const UA = 'ReOS-Desktop/1.0 (research paper manager)';

export type RxivServer = 'biorxiv' | 'medrxiv';

export interface BiorxivRef {
	server: RxivServer;
	/** Full DOI, e.g. `10.1101/2026.01.01.697284`. */
	doi: string;
	/** Version from an explicit `vN` in the input, if any. */
	version: number | null;
}

// On a biorxiv.org/medrxiv.org URL the DOI sits under /content/ and may carry a
// version marker and a rendering suffix (.full, .full.pdf, .abstract, …).
const HOSTED_DOI_RE =
	/\/content\/(10\.\d{4,9}\/[^\s/?#]+?)(?:v(\d+))?(?:\.(?:full|abstract|short)(?:\.pdf)?(?:\+html)?)?$/i;

// Bare DOIs are only claimed when the suffix has bioRxiv's dated shape
// (YYYY.MM.DD.NNNNNN) — anything else is too ambiguous to route here.
const DATED_DOI_RE = /(10\.\d{4,9}\/\d{4}\.\d{2}\.\d{2}\.\d+)(?:v(\d+))?/;

/**
 * Recognizes bioRxiv/medRxiv content URLs (with or without scheme/www) and
 * bare dated DOIs (optionally `doi:`- or doi.org-prefixed). Returns null for
 * everything else so generic inputs keep flowing to the web-import path.
 */
export function extractBiorxivRef(raw: string): BiorxivRef | null {
	const trimmed = raw.trim();
	const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const url = new URL(candidate);
		const host = url.hostname.match(/^(?:www\.)?(bio|med)rxiv\.org$/i);
		if (host) {
			const m = url.pathname.match(HOSTED_DOI_RE);
			if (!m) return null;
			return {
				server: host[1].toLowerCase() === 'med' ? 'medrxiv' : 'biorxiv',
				doi: m[1],
				version: m[2] ? parseInt(m[2], 10) : null
			};
		}
	} catch {
		// not a URL — fall through to the bare-DOI check
	}
	if (!/^(?:doi:\s*)?(?:(?:https?:\/\/)?(?:www\.|dx\.)?doi\.org\/)?10\.\d{4,9}\//i.test(trimmed))
		return null;
	const m = trimmed.match(DATED_DOI_RE);
	if (!m) return null;
	return { server: 'biorxiv', doi: m[1], version: m[2] ? parseInt(m[2], 10) : null };
}

/**
 * Filesystem-safe paper ID (the DOI itself contains a slash). The suffix is
 * unique within a server, so `biorxiv-2026.01.01.697284` is collision-free.
 */
export function biorxivPaperId(ref: BiorxivRef): string {
	const suffix = ref.doi.split('/')[1] ?? ref.doi;
	return `${ref.server}-${suffix.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
}

export function biorxivServerLabel(server: RxivServer): string {
	return server === 'medrxiv' ? 'medRxiv' : 'bioRxiv';
}

interface RxivMeta {
	title: string;
	authors: string[];
	abstract: string;
	publishedDate: string;
	categories: string[];
	version: number | null;
}

async function get(url: string): Promise<Response> {
	return tauriFetch(url, {
		method: 'GET',
		headers: { 'User-Agent': UA, Accept: '*/*' }
	});
}

function contentUrl(ref: BiorxivRef, version: number | null): string {
	return `https://www.${ref.server}.org/content/${ref.doi}${version ? `v${version}` : ''}`;
}

export async function fetchBiorxivPaper(ref: BiorxivRef): Promise<Paper> {
	const meta = (await fetchFromApi(ref)) ?? (await fetchFromHtml(ref));
	if (!meta) throw new Error(`Paper ${ref.doi} not found on ${biorxivServerLabel(ref.server)}.`);
	const version = ref.version ?? meta.version;
	const arxivId = biorxivPaperId(ref);

	return {
		id: `p${Date.now()}`,
		arxivId,
		title: meta.title,
		authors: meta.authors,
		abstract: meta.abstract,
		publishedDate: meta.publishedDate,
		categories: meta.categories,
		tags: [],
		readingStatus: 'unread',
		rating: null,
		pdfPath: `papers/${arxivId}.pdf`,
		arxivUrl: contentUrl(ref, version),
		addedAt: new Date().toISOString(),
		links: []
	};
}

/** Takes the versioned content URL produced by `fetchBiorxivPaper`. */
export async function downloadBiorxivPdf(paperContentUrl: string): Promise<Uint8Array> {
	const res = await get(`${paperContentUrl}.full.pdf`);
	if (!res.ok) throw new Error(`Failed to download PDF: ${res.status}`);
	const buf = await res.arrayBuffer();
	if (buf.byteLength < 1024) throw new Error('Downloaded PDF appears empty.');
	return new Uint8Array(buf);
}

async function fetchFromApi(ref: BiorxivRef): Promise<RxivMeta | null> {
	try {
		const res = await get(
			`https://api.biorxiv.org/details/${ref.server}/${encodeURI(ref.doi)}`
		);
		if (!res.ok) return null;
		const json = (await res.json()) as { collection?: Record<string, unknown>[] };
		const entries = json?.collection;
		if (!Array.isArray(entries) || entries.length === 0) return null;
		// The API returns one entry per version, oldest first.
		const entry =
			(ref.version != null && entries.find((e) => Number(e.version) === ref.version)) ||
			entries[entries.length - 1];
		const title = String(entry.title ?? '').trim();
		if (!title) return null;
		// Authors come semicolon-separated as "Last, F." — flip to "F. Last".
		const authors = String(entry.authors ?? '')
			.split(';')
			.map((name) => {
				const parts = name.split(',').map((s) => s.trim()).filter(Boolean);
				return parts.length > 1 ? `${parts[1]} ${parts[0]}` : (parts[0] ?? '');
			})
			.filter(Boolean);
		return {
			title,
			authors,
			abstract: String(entry.abstract ?? '').replace(/\s+/g, ' ').trim(),
			publishedDate: String(entry.date ?? '').slice(0, 10),
			categories: entry.category ? [String(entry.category).trim()] : [],
			version: Number(entry.version) || null
		};
	} catch {
		return null;
	}
}

async function fetchFromHtml(ref: BiorxivRef): Promise<RxivMeta | null> {
	try {
		const res = await get(contentUrl(ref, ref.version));
		if (!res.ok) return null;
		const html = await res.text();
		const title = matchMeta(html, 'citation_title');
		if (!title) return null;
		const abstract = matchMeta(html, 'citation_abstract') ?? '';
		const publishedDate = (matchMeta(html, 'citation_date') ?? '').replace(/\//g, '-');
		const authors = matchAll(
			html,
			/<meta\s+name="citation_author"\s+content="([^"]+)"/g,
			(m) => {
				const parts = m[1].split(',').map((s) => s.trim());
				return parts.length > 1 ? `${parts[1]} ${parts[0]}` : parts[0];
			}
		);
		return { title, abstract, publishedDate, authors, categories: [], version: ref.version };
	} catch {
		return null;
	}
}

function matchMeta(html: string, name: string): string | null {
	const re = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 's');
	return html.match(re)?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
}

function matchAll<T>(text: string, re: RegExp, fn: (m: RegExpExecArray) => T): T[] {
	const out: T[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) out.push(fn(m));
	return out;
}
