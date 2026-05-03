import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

const BASE = 'https://export.arxiv.org/api/query?id_list=';

export async function fetchArxivXml(arxivId: string): Promise<string> {
	const res = await tauriFetch(`${BASE}${encodeURIComponent(arxivId)}`, {
		method: 'GET',
		headers: { Accept: 'application/atom+xml' }
	});
	if (!res.ok) throw new Error(`Arxiv API returned ${res.status}`);
	return await res.text();
}

export async function downloadArxivPdf(arxivId: string): Promise<Uint8Array> {
	const url = `https://arxiv.org/pdf/${encodeURIComponent(arxivId)}.pdf`;
	const res = await tauriFetch(url, { method: 'GET' });
	if (!res.ok) throw new Error(`Failed to download PDF: ${res.status}`);
	const buf = await res.arrayBuffer();
	return new Uint8Array(buf);
}
