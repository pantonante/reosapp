// Paper-source parsing and remote metadata/PDF fetching for add_paper.
// Ports of ../../src/lib/arxiv.ts, ../../src/lib/biorxiv.ts and
// ../../src/lib/web.ts using Node's global fetch — keep the ID derivations in
// sync with the app, since they double as on-disk folder names and dedup keys.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UA = 'ReOS-MCP/1.0 (research paper manager)';
const FETCH_TIMEOUT_MS = 60_000;

export interface FetchedMeta {
	title: string;
	authors: string[];
	abstract: string;
	publishedDate: string;
	categories: string[];
}

export type PaperSource =
	| { kind: 'arxiv'; arxivId: string }
	| { kind: 'biorxiv'; ref: BiorxivRef; arxivId: string }
	| { kind: 'web'; normalizedUrl: string; arxivId: string }
	| { kind: 'local'; path: string };

/**
 * Same routing as AddPaperModal.importFromInput: AlphaXiv → arXiv, bioRxiv/
 * medRxiv links and dated DOIs → bioRxiv, arXiv hosts or bare IDs → arXiv,
 * any other http(s) URL → webpage. Local `.pdf` paths are the MCP's stand-in
 * for the app's drag-and-drop. Null when nothing matches.
 */
export function parseSource(raw: string): PaperSource | null {
	const local = localPdfPath(raw);
	if (local) return { kind: 'local', path: local };
	const input = canonicalizeArxivInput(raw.trim());
	const ref = extractBiorxivRef(input);
	if (ref) return { kind: 'biorxiv', ref, arxivId: biorxivPaperId(ref) };
	// Bare DOIs go through doi.org (the arXiv regex would otherwise match digit
	// runs inside DOIs like 10.1145/3292500.3330701).
	const doi = /^(?:doi:\s*)?10\./i.test(input) ? normalizeDoi(input) : null;
	if (doi) {
		const normalizedUrl = normalizeUrl(`https://doi.org/${doi}`)!;
		return { kind: 'web', normalizedUrl, arxivId: webIdFromUrl(normalizedUrl) };
	}
	const normalizedUrl = looksLikeUrl(input) ? normalizeUrl(input) : null;
	const isArxivHost = normalizedUrl
		? /(^|\.)arxiv\.org$/i.test(new URL(normalizedUrl).hostname)
		: false;
	const arxivId = extractArxivId(input);
	if (arxivId && (isArxivHost || !normalizedUrl)) return { kind: 'arxiv', arxivId };
	if (normalizedUrl) return { kind: 'web', normalizedUrl, arxivId: webIdFromUrl(normalizedUrl) };
	return null;
}

// The app's prepareWebSource accepts scheme-less input and lets new URL()
// decide; a bare arXiv ID like "2301.08243" parses as a hostname there but is
// claimed by the arXiv branch first. Require a dot-separated host with a
// letter TLD so "2301.08243" never reaches the web branch here either.
function looksLikeUrl(input: string): boolean {
	return /^https?:\/\//i.test(input) || /^[\w-]+(\.[\w-]+)*\.[a-z]{2,}(\/|$)/i.test(input);
}

async function get(url: string): Promise<Response> {
	return fetch(url, {
		headers: { 'User-Agent': UA, Accept: '*/*' },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
}

function isPdf(bytes: Uint8Array): boolean {
	// "%PDF-" — paywalls and bot checks answer PDF URLs with HTML and a 200.
	return (
		bytes.byteLength >= 1024 &&
		bytes[0] === 0x25 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x44 &&
		bytes[3] === 0x46 &&
		bytes[4] === 0x2d
	);
}

export async function downloadPdf(url: string): Promise<Uint8Array> {
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
	} catch (err) {
		throw new Error(`Could not fetch ${url}: ${err instanceof Error ? err.message : err}`);
	}
	if (!res.ok) throw new Error(`Failed to download PDF from ${url}: HTTP ${res.status}`);
	const buf = new Uint8Array(await res.arrayBuffer());
	if (!isPdf(buf)) {
		throw new Error(
			`${url} did not return a PDF (got ${res.headers.get('content-type') ?? 'unknown content'} — ` +
				`likely a paywall, login, or bot check).`
		);
	}
	return buf;
}

// --- Local PDFs ---

function expandPath(raw: string): string | null {
	const t = raw.trim();
	if (t.startsWith('file://')) return fileURLToPath(t);
	if (t.startsWith('~/')) return resolve(homedir(), t.slice(2));
	if (t.startsWith('/')) return t;
	return null;
}

function localPdfPath(raw: string): string | null {
	return /\.pdf$/i.test(raw.trim()) ? expandPath(raw) : null;
}

/** Reads a local PDF given as an absolute, ~/-relative, or file:// path. */
export async function readLocalPdf(raw: string): Promise<Uint8Array> {
	const path = expandPath(raw);
	if (!path) throw new Error(`PDF path must be absolute (or start with ~/): '${raw}'.`);
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await readFile(path));
	} catch (err) {
		throw new Error(`Could not read ${path}: ${err instanceof Error ? err.message : err}`);
	}
	if (!isPdf(bytes)) throw new Error(`${path} is not a PDF file.`);
	return bytes;
}

/** Content-addressed id, so re-adding the same file dedups. */
export function localPaperId(bytes: Uint8Array): string {
	return `local-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;
}

export function localTitleFromPath(path: string): string {
	return basename(path).replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || 'Untitled PDF';
}

// --- arXiv (mirror src/lib/arxiv.ts) ---

export function canonicalizeArxivInput(raw: string): string {
	const trimmed = raw.trim();
	const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		const url = new URL(candidate);
		if (!/^(?:www\.)?alphaxiv\.(?:org|com)$/i.test(url.hostname)) return trimmed;
		url.protocol = 'https:';
		url.hostname = 'arxiv.org';
		url.port = '';
		return url.toString();
	} catch {
		return trimmed;
	}
}

export function extractArxivId(raw: string): string | null {
	const match = raw.trim().match(/(\d{4}\.\d{4,5})(v\d+)?/);
	return match ? match[1] : null;
}

export async function fetchArxivMeta(arxivId: string): Promise<FetchedMeta> {
	const meta = (await arxivFromApi(arxivId)) ?? (await arxivFromHtml(arxivId));
	if (!meta) throw new Error(`Paper ${arxivId} not found on arXiv.`);
	return meta;
}

export function downloadArxivPdf(arxivId: string): Promise<Uint8Array> {
	return downloadPdf(`https://arxiv.org/pdf/${encodeURIComponent(arxivId)}.pdf`);
}

async function arxivFromApi(arxivId: string): Promise<FetchedMeta | null> {
	try {
		const res = await get(
			`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`
		);
		if (!res.ok) return null;
		const xml = await res.text();
		if (xml.includes('Rate exceeded')) return null;
		const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
		if (!entry) return null;
		const title = textOf(entry, 'title')?.replace(/\s+/g, ' ').trim() ?? '';
		if (!title || title.toLowerCase().includes('error')) return null;
		return {
			title,
			abstract: textOf(entry, 'summary')?.replace(/\s+/g, ' ').trim() ?? '',
			publishedDate: textOf(entry, 'published')?.slice(0, 10) ?? '',
			authors: matchAll(entry, /<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g, (m) =>
				m[1].trim()
			),
			categories: matchAll(entry, /<category\s+term="([^"]+)"/g, (m) => m[1])
		};
	} catch {
		return null;
	}
}

async function arxivFromHtml(arxivId: string): Promise<FetchedMeta | null> {
	try {
		const res = await get(`https://arxiv.org/abs/${encodeURIComponent(arxivId)}`);
		if (!res.ok) return null;
		const html = await res.text();
		const meta = citationMeta(html);
		if (!meta) return null;
		const subjects = html.match(/Subjects:.*?<\/td>/s)?.[0] ?? '';
		meta.categories = matchAll(subjects, /\(([a-z-]+\.[A-Z]+)\)/g, (m) => m[1]);
		return meta;
	} catch {
		return null;
	}
}

// --- bioRxiv / medRxiv (mirror src/lib/biorxiv.ts) ---

export type RxivServer = 'biorxiv' | 'medrxiv';

export interface BiorxivRef {
	server: RxivServer;
	doi: string;
	version: number | null;
}

const HOSTED_DOI_RE =
	/\/content\/(10\.\d{4,9}\/[^\s/?#]+?)(?:v(\d+))?(?:\.(?:full|abstract|short)(?:\.pdf)?(?:\+html)?)?$/i;
const DATED_DOI_RE = /(10\.\d{4,9}\/\d{4}\.\d{2}\.\d{2}\.\d+)(?:v(\d+))?/;

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

export function biorxivPaperId(ref: BiorxivRef): string {
	const suffix = ref.doi.split('/')[1] ?? ref.doi;
	return `${ref.server}-${suffix.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
}

function biorxivContentUrl(ref: BiorxivRef, version: number | null): string {
	return `https://www.${ref.server}.org/content/${ref.doi}${version ? `v${version}` : ''}`;
}

/** Metadata plus the versioned content URL (stored as arxivUrl, PDF lives at `.full.pdf`). */
export async function fetchBiorxivMeta(
	ref: BiorxivRef
): Promise<FetchedMeta & { contentUrl: string }> {
	const meta = (await biorxivFromApi(ref)) ?? (await biorxivFromHtml(ref));
	const label = ref.server === 'medrxiv' ? 'medRxiv' : 'bioRxiv';
	if (!meta) throw new Error(`Paper ${ref.doi} not found on ${label}.`);
	const { version, ...rest } = meta;
	return { ...rest, contentUrl: biorxivContentUrl(ref, ref.version ?? version) };
}

export function downloadBiorxivPdf(contentUrl: string): Promise<Uint8Array> {
	return downloadPdf(`${contentUrl}.full.pdf`);
}

async function biorxivFromApi(
	ref: BiorxivRef
): Promise<(FetchedMeta & { version: number | null }) | null> {
	try {
		const res = await get(`https://api.biorxiv.org/details/${ref.server}/${encodeURI(ref.doi)}`);
		if (!res.ok) return null;
		const json = (await res.json()) as { collection?: Record<string, unknown>[] };
		const entries = json?.collection;
		if (!Array.isArray(entries) || entries.length === 0) return null;
		const entry =
			(ref.version != null && entries.find((e) => Number(e.version) === ref.version)) ||
			entries[entries.length - 1];
		const title = String(entry.title ?? '').trim();
		if (!title) return null;
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

async function biorxivFromHtml(
	ref: BiorxivRef
): Promise<(FetchedMeta & { version: number | null }) | null> {
	try {
		const res = await get(biorxivContentUrl(ref, ref.version));
		if (!res.ok) return null;
		const meta = citationMeta(await res.text());
		return meta ? { ...meta, version: ref.version } : null;
	} catch {
		return null;
	}
}

// --- Webpages (mirror src/lib/web.ts) ---

const TRACKING_PARAMS = new Set([
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_term',
	'utm_content',
	'utm_id',
	'fbclid',
	'gclid',
	'mc_cid',
	'mc_eid',
	'ref',
	'ref_src',
	'igshid'
]);

export function normalizeUrl(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	url.hostname = url.hostname.toLowerCase();
	url.hash = '';
	const cleanedParams = new URLSearchParams();
	for (const [k, v] of url.searchParams) {
		if (!TRACKING_PARAMS.has(k.toLowerCase())) cleanedParams.append(k, v);
	}
	url.search = cleanedParams.toString();
	let out = url.toString();
	if (out.endsWith('/') && url.pathname !== '/') out = out.slice(0, -1);
	return out;
}

function slugifyForId(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
}

export function webIdFromUrl(normalizedUrl: string): string {
	const u = new URL(normalizedUrl);
	const host = u.hostname.replace(/^www\./, '');
	const lastSeg = u.pathname.split('/').filter(Boolean).pop() ?? '';
	const slug = slugifyForId(lastSeg ? `${host}-${lastSeg}` : host);
	const hash = createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 6);
	return `web-${slug || 'page'}-${hash}`;
}

export interface WebSource {
	meta: Partial<FetchedMeta>;
	pdf: Uint8Array | null;
	pdfUrl: string | null;
	/** Why each PDF candidate failed — surfaced so the caller knows to supply one. */
	failures: string[];
}

/**
 * Metadata plus a best-effort PDF for a non-arXiv URL. PDF candidates, in
 * order: the URL itself (direct PDF links), the page's citation_pdf_url, then
 * OpenAlex's open-access locations for the page's DOI. Publisher pages that
 * block bots still resolve through OpenAlex when an OA copy exists elsewhere.
 * Never throws.
 */
export async function fetchWebSource(
	normalizedUrl: string,
	opts: { findPdf: boolean }
): Promise<WebSource> {
	const failures: string[] = [];
	const candidates: string[] = [];
	let meta: Partial<FetchedMeta> = {};
	// og:/<title> tags are a last resort — on bot-check pages they describe the
	// challenge ("Checking your browser"), not the paper.
	let generic: Partial<FetchedMeta> = {};
	let doi = doiFromUrl(normalizedUrl);
	try {
		const res = await get(normalizedUrl);
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (res.ok && isPdf(bytes)) {
			return { meta, pdf: opts.findPdf ? bytes : null, pdfUrl: normalizedUrl, failures };
		}
		if (res.ok) {
			const html = new TextDecoder().decode(bytes);
			meta = citationMeta(html) ?? {};
			generic = genericMeta(html);
			const cited = matchMeta(html, 'citation_pdf_url');
			if (cited) candidates.push(new URL(decodeEntities(cited), res.url).toString());
			doi ??= normalizeDoi(matchMeta(html, 'citation_doi') ?? matchMeta(html, 'dc.identifier') ?? '');
		} else {
			failures.push(`${normalizedUrl}: HTTP ${res.status}`);
		}
	} catch (err) {
		failures.push(`${normalizedUrl}: ${errMsg(err)}`);
	}
	// PMC often serves bots a challenge page with no metadata; Europe PMC's API
	// still yields the DOI, metadata, and full-text links.
	const pmcid = pmcidFromUrl(normalizedUrl);
	if (pmcid) {
		const record = await fetchEuropePmc(pmcid);
		if (record) {
			doi ??= record.doi;
			meta = fillMissing(meta, record.meta);
			candidates.push(...record.pdfUrls);
		}
	}
	if (doi) {
		const work = await fetchOpenAlexWork(doi);
		if (work) {
			candidates.push(...work.pdfUrls);
			meta = fillMissing(meta, work.meta);
		}
	}
	meta = fillMissing(meta, generic);
	if (meta.publishedDate) meta.publishedDate = normalizeDate(meta.publishedDate);
	if (!opts.findPdf) return { meta, pdf: null, pdfUrl: null, failures: [] };
	if (!candidates.length && !doi) failures.push('the page exposes no PDF link or DOI');
	for (const url of new Set(candidates)) {
		try {
			return { meta, pdf: await downloadPdf(url), pdfUrl: url, failures };
		} catch (err) {
			failures.push(errMsg(err));
		}
	}
	if (doi && !candidates.length) failures.push(`OpenAlex lists no open-access PDF for DOI ${doi}`);
	return { meta, pdf: null, pdfUrl: null, failures };
}

function genericMeta(html: string): Partial<FetchedMeta> {
	const title =
		matchProperty(html, 'og:title') ??
		html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
	const abstract = matchProperty(html, 'og:description') ?? matchMeta(html, 'description') ?? '';
	return { title: title ? decodeEntities(title) : undefined, abstract: decodeEntities(abstract) };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Coerce the many citation-date shapes ("2017 Aug 29", "2012-12", "1998") to YYYY-MM-DD. */
function normalizeDate(raw: string): string {
	const t = raw.trim().replace(/\//g, '-');
	const iso = t.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
	const pad = (n: string | number) => String(n).padStart(2, '0');
	if (iso && !/^\d{4}\s+[a-z]/i.test(t)) {
		return `${iso[1]}-${pad(iso[2] ?? 1)}-${pad(iso[3] ?? 1)}`;
	}
	const named = t.match(/^(\d{4})\s+([a-z]{3})[a-z]*\.?(?:\s+(\d{1,2}))?/i);
	if (named) {
		const month = MONTHS.indexOf(named[2].toLowerCase()) + 1;
		if (month) return `${named[1]}-${pad(month)}-${pad(named[3] ?? 1)}`;
	}
	return t;
}

function fillMissing(
	meta: Partial<FetchedMeta>,
	fallback: Partial<FetchedMeta>
): Partial<FetchedMeta> {
	const out = { ...meta };
	for (const key of ['title', 'abstract', 'publishedDate'] as const) {
		if (!out[key] && fallback[key]) out[key] = fallback[key];
	}
	if (!out.authors?.length && fallback.authors?.length) out.authors = fallback.authors;
	return out;
}

// --- PubMed Central (via Europe PMC) ---

function pmcidFromUrl(normalizedUrl: string): string | null {
	const u = new URL(normalizedUrl);
	if (!/(^|\.)(ncbi\.nlm\.nih\.gov|europepmc\.org)$/i.test(u.hostname)) return null;
	return u.pathname.match(/PMC\d+/i)?.[0].toUpperCase() ?? null;
}

async function fetchEuropePmc(
	pmcid: string
): Promise<{ doi: string | null; meta: Partial<FetchedMeta>; pdfUrls: string[] } | null> {
	try {
		const res = await get(
			`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=PMCID:${pmcid}&resultType=core&format=json`
		);
		if (!res.ok) return null;
		const json = (await res.json()) as {
			resultList?: {
				result?: {
					doi?: string;
					title?: string;
					authorString?: string;
					abstractText?: string;
					firstPublicationDate?: string;
					fullTextUrlList?: { fullTextUrl?: { documentStyle?: string; url?: string }[] };
				}[];
			};
		};
		const r = json.resultList?.result?.[0];
		if (!r) return null;
		return {
			doi: r.doi ? normalizeDoi(r.doi) : null,
			meta: {
				title: r.title?.replace(/\.$/, ''),
				authors: (r.authorString ?? '')
					.replace(/\.$/, '')
					.split(',')
					.map((a) => a.trim())
					.filter(Boolean),
				abstract: decodeEntities((r.abstractText ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
				publishedDate: r.firstPublicationDate ?? ''
			},
			pdfUrls: (r.fullTextUrlList?.fullTextUrl ?? [])
				.filter((u) => u.documentStyle === 'pdf' && u.url)
				.map((u) => u.url!)
		};
	} catch {
		return null;
	}
}

// --- DOIs / OpenAlex ---

const DOI_RE = /^10\.\d{4,9}\/\S+$/;

export function normalizeDoi(raw: string): string | null {
	const t = raw
		.trim()
		.replace(/^doi:\s*/i, '')
		.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '');
	return DOI_RE.test(t) ? t : null;
}

function doiFromUrl(normalizedUrl: string): string | null {
	const u = new URL(normalizedUrl);
	if (!/^(?:dx\.)?doi\.org$/i.test(u.hostname)) return null;
	return normalizeDoi(decodeURIComponent(u.pathname.slice(1)));
}

async function fetchOpenAlexWork(
	doi: string
): Promise<{ meta: Partial<FetchedMeta>; pdfUrls: string[] } | null> {
	try {
		const res = await get(`https://api.openalex.org/works/https://doi.org/${encodeURI(doi)}`);
		if (!res.ok) return null;
		const w = (await res.json()) as {
			display_name?: string;
			publication_date?: string;
			authorships?: { author?: { display_name?: string } }[];
			abstract_inverted_index?: Record<string, number[]> | null;
			best_oa_location?: { pdf_url?: string | null } | null;
			oa_locations?: { pdf_url?: string | null }[];
		};
		const pdfUrls = [w.best_oa_location, ...(w.oa_locations ?? [])]
			.map((l) => l?.pdf_url)
			.filter((u): u is string => !!u);
		return {
			pdfUrls,
			meta: {
				title: w.display_name ? decodeEntities(w.display_name) : undefined,
				authors: (w.authorships ?? [])
					.map((a) => a.author?.display_name ?? '')
					.filter(Boolean),
				publishedDate: w.publication_date ?? '',
				abstract: invertedAbstract(w.abstract_inverted_index)
			}
		};
	} catch {
		return null;
	}
}

function invertedAbstract(index: Record<string, number[]> | null | undefined): string {
	if (!index) return '';
	const words: string[] = [];
	for (const [word, positions] of Object.entries(index)) {
		for (const p of positions) words[p] = word;
	}
	return words.filter(Boolean).join(' ');
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// --- HTML helpers ---

function citationMeta(html: string): FetchedMeta | null {
	const title = matchMeta(html, 'citation_title');
	if (!title) return null;
	return {
		title: decodeEntities(title),
		abstract: decodeEntities(matchMeta(html, 'citation_abstract') ?? ''),
		publishedDate: (
			matchMeta(html, 'citation_date') ??
			matchMeta(html, 'citation_publication_date') ??
			matchMeta(html, 'citation_online_date') ??
			''
		).replace(/\//g, '-'),
		authors: matchAll(html, /<meta\s+name="citation_author"\s+content="([^"]+)"/g, (m) => {
			const parts = m[1].split(',').map((s) => s.trim());
			return decodeEntities(parts.length > 1 ? `${parts[1]} ${parts[0]}` : parts[0]);
		}),
		categories: []
	};
}

function textOf(body: string, tag: string): string | null {
	const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
	return body.match(re)?.[1] ?? null;
}

function matchMeta(html: string, name: string): string | null {
	const re = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 's');
	return html.match(re)?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
}

function matchProperty(html: string, property: string): string | null {
	const re = new RegExp(`<meta\\s+property="${property}"\\s+content="([^"]*)"`, 's');
	return html.match(re)?.[1]?.replace(/\s+/g, ' ').trim() || null;
}

function matchAll<T>(text: string, re: RegExp, fn: (m: RegExpExecArray) => T): T[] {
	const out: T[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) out.push(fn(m));
	return out;
}

function decodeEntities(s: string): string {
	return s
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}
