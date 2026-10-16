// On-disk format of thread notes (`threads/<slug>/notes/<id>.md`). Pure
// helpers shared by the Tauri fs layer and the note renderer; the MCP server
// keeps a copy in mcp/src/note-format.ts — keep the two in sync.

import type { ThreadNote } from './types';

export const NOTES_DIR = 'notes';
export const NOTE_MEDIA_DIR = 'media';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const VIDEO_TYPES: Record<string, string> = {
	mp4: 'video/mp4',
	m4v: 'video/mp4',
	mov: 'video/quicktime',
	webm: 'video/webm',
	ogv: 'video/ogg'
};

const IMAGE_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	avif: 'image/avif',
	bmp: 'image/bmp'
};

export const MEDIA_EXTENSIONS = [...Object.keys(IMAGE_TYPES), ...Object.keys(VIDEO_TYPES)];

function extensionOf(path: string): string {
	const clean = path.split(/[?#]/)[0];
	const dot = clean.lastIndexOf('.');
	return dot === -1 ? '' : clean.slice(dot + 1).toLowerCase();
}

export function isVideoPath(path: string): boolean {
	return extensionOf(path) in VIDEO_TYPES;
}

export function mediaMimeType(path: string): string {
	const ext = extensionOf(path);
	return VIDEO_TYPES[ext] ?? IMAGE_TYPES[ext] ?? 'application/octet-stream';
}

/** Sortable timestamp id, matching the app's `t…`/`p…` thread and paper ids. */
export function newNoteId(): string {
	return `n${Date.now()}`;
}

/** `<timestamp>-<safe name>` so pasted files called `image.png` never collide. */
export function mediaFileName(original: string): string {
	const ext = extensionOf(original);
	const stem = (ext ? original.slice(0, -(ext.length + 1)) : original)
		.toLowerCase()
		.replace(/[^a-z0-9-_]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return `${Date.now()}-${stem || 'media'}${ext ? `.${ext}` : ''}`;
}

function parseScalar(raw: string): string {
	const v = raw.trim();
	if (v.startsWith('"')) {
		try {
			return String(JSON.parse(v));
		} catch {
			// fall through to the raw value
		}
	}
	if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
	return v;
}

/**
 * Parse a note file. Frontmatter is optional so a hand-written (or
 * agent-written) `.md` dropped into `notes/` still shows up: the title then
 * falls back to the first `# heading`, then to the file id.
 */
export function parseNote(id: string, raw: string, fallbackDate: string): ThreadNote {
	const fields: Record<string, string> = {};
	let content = raw;
	const match = raw.match(FRONTMATTER_RE);
	if (match) {
		// serializeNote leaves a blank line after the closing fence.
		content = raw.slice(match[0].length).replace(/^\r?\n/, '');
		for (const line of match[1].split(/\r?\n/)) {
			const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
			if (kv) fields[kv[1]] = parseScalar(kv[2]);
		}
	}
	const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
	return {
		id,
		title: fields.title || heading || id,
		content,
		createdAt: fields.createdAt || fallbackDate,
		updatedAt: fields.updatedAt || fields.createdAt || fallbackDate
	};
}

export function serializeNote(note: ThreadNote): string {
	return [
		'---',
		// JSON strings are valid YAML double-quoted scalars.
		`title: ${JSON.stringify(note.title)}`,
		`createdAt: ${note.createdAt}`,
		`updatedAt: ${note.updatedAt}`,
		'---',
		'',
		note.content
	].join('\n');
}

/** `media/<file>` references in a note body (for orphan cleanup on delete). */
export function mediaRefs(content: string): Set<string> {
	const refs = new Set<string>();
	for (const m of content.matchAll(/(?:^|[("'\s])(?:\.\/)?media\/([^\s)"'?#]+)/g)) {
		refs.add(decodeURIComponent(m[1]));
	}
	return refs;
}

/** One-line plain-text preview of a note body for the collapsed card. */
export function noteExcerpt(content: string, max = 180): string {
	const text = content
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^#+\s+/gm, '')
		.replace(/[*_`>$~|-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > max ? text.slice(0, max) + '…' : text;
}

// --- Paper links ---

/** `[text](paper:<arxivId>)` links a note to a paper in the library. */
export const PAPER_LINK_SCHEME = 'paper:';

/** Markdown for a paper link; `[`/`]` in the text are escaped. */
export function paperLinkMarkdown(text: string, arxivId: string): string {
	const label = text.replace(/([[\]\\])/g, '\\$1').replace(/\s+/g, ' ').trim();
	const href = `${PAPER_LINK_SCHEME}${arxivId}`;
	return `[${label}](${/[\s()<>]/.test(href) ? `<${href}>` : href})`;
}

/** Paper ids a note links to via `[text](paper:<id>)` / `[text](<paper:<id>>)`. */
export function paperRefs(content: string): Set<string> {
	const refs = new Set<string>();
	for (const m of content.matchAll(/\]\(\s*(?:<paper:([^>]+)>|paper:([^)\s]+))/g)) {
		const raw = (m[1] ?? m[2]).trim();
		try {
			refs.add(decodeURIComponent(raw));
		} catch {
			refs.add(raw);
		}
	}
	return refs;
}
