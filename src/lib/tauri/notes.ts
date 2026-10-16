// Thread notes on disk: `threads/<slug>/notes/<id>.md` plus embedded media in
// `notes/media/`. Notes are read straight from the filesystem (no SQLite
// cache) — they're only ever needed one thread at a time.

import { exists, mkdir, readDir, readFile, readTextFile, remove, stat, writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import type { ThreadNote } from '$lib/types';
import {
	NOTE_MEDIA_DIR,
	NOTES_DIR,
	mediaFileName,
	mediaMimeType,
	mediaRefs,
	parseNote,
	serializeNote
} from '$lib/note-format';
import { threadDir } from './fs';

export async function notesDir(threadSlug: string): Promise<string> {
	return join(await threadDir(threadSlug), NOTES_DIR);
}

async function notePath(threadSlug: string, noteId: string): Promise<string> {
	return join(await notesDir(threadSlug), `${noteId}.md`);
}

/** Notes in creation order, so editing one never reshuffles the list. */
export async function listThreadNotes(threadSlug: string): Promise<ThreadNote[]> {
	const dir = await notesDir(threadSlug);
	if (!(await exists(dir))) return [];
	const notes: ThreadNote[] = [];
	for (const e of await readDir(dir)) {
		if (!e.isFile || !e.name.endsWith('.md')) continue;
		const path = await join(dir, e.name);
		// Hand-written notes may lack frontmatter dates; the file mtime stands in.
		const mtime = await stat(path).then((s) => s.mtime, () => null);
		const fallback = (mtime ?? new Date()).toISOString();
		try {
			notes.push(parseNote(e.name.slice(0, -'.md'.length), await readTextFile(path), fallback));
		} catch (err) {
			// Google Drive placeholders can fail mid-read; skip rather than
			// hiding every other note.
			console.warn('[reos] unreadable note', path, err);
		}
	}
	notes.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
	return notes;
}

export async function readThreadNote(
	threadSlug: string,
	noteId: string
): Promise<ThreadNote | null> {
	const path = await notePath(threadSlug, noteId);
	if (!(await exists(path))) return null;
	const mtime = await stat(path).then((s) => s.mtime, () => null);
	return parseNote(noteId, await readTextFile(path), (mtime ?? new Date()).toISOString());
}

export async function writeThreadNote(threadSlug: string, note: ThreadNote): Promise<void> {
	const dir = await notesDir(threadSlug);
	if (!(await exists(dir))) await mkdir(dir, { recursive: true });
	await writeTextFile(await notePath(threadSlug, note.id), serializeNote(note));
}

/**
 * Delete a note and any media files that only it referenced. Media shared
 * with another note in the thread is kept.
 */
export async function removeThreadNote(
	threadSlug: string,
	note: ThreadNote,
	remaining: ThreadNote[]
): Promise<void> {
	const path = await notePath(threadSlug, note.id);
	if (await exists(path)) await remove(path);
	const stillUsed = new Set(remaining.flatMap((n) => [...mediaRefs(n.content)]));
	const mediaDir = await join(await notesDir(threadSlug), NOTE_MEDIA_DIR);
	for (const ref of mediaRefs(note.content)) {
		if (stillUsed.has(ref) || ref.includes('..')) continue;
		const file = await join(mediaDir, ref);
		if (await exists(file)) await remove(file);
	}
}

/**
 * Copy an image/video into the thread's `notes/media/` folder. Returns the
 * path to embed in markdown, relative to the note file (`media/<file>`).
 */
export async function saveNoteMedia(
	threadSlug: string,
	originalName: string,
	bytes: Uint8Array
): Promise<string> {
	const dir = await join(await notesDir(threadSlug), NOTE_MEDIA_DIR);
	if (!(await exists(dir))) await mkdir(dir, { recursive: true });
	const name = mediaFileName(originalName);
	await writeFile(await join(dir, name), bytes);
	return `${NOTE_MEDIA_DIR}/${name}`;
}

/**
 * Resolve a media `src` from a rendered note to an absolute path on disk.
 * Relative paths are relative to the notes folder; absolute paths are used
 * as-is. Returns null for anything the webview can load by itself (http(s),
 * data:, blob:).
 */
export async function resolveNoteMediaPath(
	threadSlug: string,
	src: string
): Promise<string | null> {
	if (/^(https?:|data:|blob:)/i.test(src)) return null;
	const decoded = decodeURIComponent(src.replace(/^file:\/\//i, ''));
	if (decoded.startsWith('/')) return decoded;
	return join(await notesDir(threadSlug), decoded.replace(/^\.\//, ''));
}

/** Read a local media file into a blob URL the webview can display. */
export async function loadMediaBlobUrl(path: string): Promise<string> {
	const bytes = await readFile(path);
	return URL.createObjectURL(new Blob([bytes], { type: mediaMimeType(path) }));
}
