import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { Paper } from './types';

const UA = 'ReOS-Desktop/1.0 (research paper manager)';

export function extractArxivId(raw: string): string | null {
	const match = raw.trim().match(/(\d{4}\.\d{4,5})(v\d+)?/);
	return match ? match[1] : null;
}

interface ArxivMeta {
	title: string;
	authors: string[];
	abstract: string;
	publishedDate: string;
	categories: string[];
}

async function get(url: string): Promise<Response> {
	return tauriFetch(url, {
		method: 'GET',
		headers: { 'User-Agent': UA, Accept: '*/*' }
	});
}

export async function fetchArxivPaper(arxivId: string): Promise<Paper> {
	const meta = (await fetchFromApi(arxivId)) ?? (await fetchFromHtml(arxivId));
	if (!meta) throw new Error(`Paper ${arxivId} not found on Arxiv.`);

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
		arxivUrl: `https://arxiv.org/abs/${arxivId}`,
		addedAt: new Date().toISOString(),
		links: []
	};
}

export async function downloadArxivPdf(arxivId: string): Promise<Uint8Array> {
	const res = await get(`https://arxiv.org/pdf/${encodeURIComponent(arxivId)}.pdf`);
	if (!res.ok) throw new Error(`Failed to download PDF: ${res.status}`);
	const buf = await res.arrayBuffer();
	if (buf.byteLength < 1024) throw new Error('Downloaded PDF appears empty.');
	return new Uint8Array(buf);
}

async function fetchFromApi(arxivId: string): Promise<ArxivMeta | null> {
	try {
		const res = await get(
			`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`
		);
		if (!res.ok) return null;
		const text = await res.text();
		if (text.includes('Rate exceeded')) return null;
		return parseAtomEntry(text);
	} catch {
		return null;
	}
}

async function fetchFromHtml(arxivId: string): Promise<ArxivMeta | null> {
	try {
		const res = await get(`https://arxiv.org/abs/${encodeURIComponent(arxivId)}`);
		if (!res.ok) return null;
		return parseAbstractHtml(await res.text());
	} catch {
		return null;
	}
}

function parseAtomEntry(xml: string): ArxivMeta | null {
	const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
	if (!entry) return null;
	const title = textOf(entry, 'title')?.replace(/\s+/g, ' ').trim() ?? '';
	if (!title || title.toLowerCase().includes('error')) return null;
	const abstract = textOf(entry, 'summary')?.replace(/\s+/g, ' ').trim() ?? '';
	const publishedDate = textOf(entry, 'published')?.slice(0, 10) ?? '';
	const authors = matchAll(entry, /<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g, (m) =>
		m[1].trim()
	);
	const categories = matchAll(entry, /<category\s+term="([^"]+)"/g, (m) => m[1]);
	return { title, abstract, publishedDate, authors, categories };
}

function parseAbstractHtml(html: string): ArxivMeta | null {
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
	const subjects = html.match(/Subjects:.*?<\/td>/s)?.[0] ?? '';
	const categories = matchAll(subjects, /\(([a-z-]+\.[A-Z]+)\)/g, (m) => m[1]);
	return { title, abstract, publishedDate, authors, categories };
}

function textOf(body: string, tag: string): string | null {
	const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
	return body.match(re)?.[1] ?? null;
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
