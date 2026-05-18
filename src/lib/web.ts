// Helpers for treating an arbitrary webpage as a `Paper`. The DB and disk
// layout key papers by `arxivId`, so webpages reuse that slot with a stable,
// filesystem-safe `web-…` ID derived from the URL.

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

/**
 * Returns `null` if the input does not look like an http(s) URL. Otherwise
 * returns a canonical form: lowercase host, no trailing slash, no hash, with
 * tracking query params stripped. Used both for dedup and for hashing.
 */
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
	// Drop trailing slash on the path portion (but keep "https://host/" minimal).
	if (out.endsWith('/') && url.pathname !== '/') out = out.slice(0, -1);
	return out;
}

async function sha256Hex(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function slugifyForId(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
}

/**
 * Derives a stable, filesystem-safe ID from a (normalized) URL. Shape:
 *   web-{host-and-last-path-segment}-{6 hex}
 * The hex suffix guarantees uniqueness even when two URLs slugify the same.
 */
export async function webIdFromUrl(normalizedUrl: string): Promise<string> {
	const u = new URL(normalizedUrl);
	const host = u.hostname.replace(/^www\./, '');
	const lastSeg = u.pathname.split('/').filter(Boolean).pop() ?? '';
	const slug = slugifyForId(lastSeg ? `${host}-${lastSeg}` : host);
	const hash = (await sha256Hex(normalizedUrl)).slice(0, 6);
	return `web-${slug || 'page'}-${hash}`;
}

/** Convenience: normalize + derive ID in one call. Returns null for bad URLs. */
export async function prepareWebSource(
	raw: string
): Promise<{ webId: string; normalizedUrl: string } | null> {
	const normalizedUrl = normalizeUrl(raw);
	if (!normalizedUrl) return null;
	const webId = await webIdFromUrl(normalizedUrl);
	return { webId, normalizedUrl };
}

export function isWebpaperId(arxivId: string): boolean {
	return arxivId.startsWith('web-');
}
