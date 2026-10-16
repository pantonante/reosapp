<script lang="ts">
	import { tick } from 'svelte';
	import { open as openDialog } from '@tauri-apps/plugin-dialog';
	import { readFile } from '@tauri-apps/plugin-fs';
	import PaperLinkPicker from '$lib/components/PaperLinkPicker.svelte';
	import { MEDIA_EXTENSIONS, paperLinkMarkdown } from '$lib/note-format';
	import type { Paper } from '$lib/types';
	import { saveNoteMedia } from '$lib/tauri/notes';
	import { cn } from '$lib/utils/cn';

	let {
		content = $bindable(),
		threadSlug,
		onchange,
		onbusy
	}: {
		content: string;
		threadSlug: string;
		/** Fired after every user edit (typing or inserted media). */
		onchange: () => void;
		/** Number of media files currently being copied, and the last error. */
		onbusy?: (copying: number, error: string | null) => void;
	} = $props();

	let textarea = $state<HTMLTextAreaElement | null>(null);
	let dragOver = $state(false);
	let copying = 0;

	export function focus() {
		textarea?.focus();
	}

	// --- Paper links: `[[` or the toolbar button opens a picker ---

	let pickerOpen = $state(false);
	let pickerQuery = $state('');
	// Text range the chosen link replaces: the typed `[[`, or the selection.
	let linkRange: { start: number; end: number; label: string | null } | null = null;

	/** Link the selection (or insert a titled link at the caret) to a paper. */
	export function linkPaper() {
		const { start, end } = caret();
		const selected = content.slice(start, end).trim();
		linkRange = { start, end, label: selected || null };
		pickerQuery = '';
		pickerOpen = true;
	}

	function onInput(e: Event) {
		onchange();
		const pos = textarea?.selectionStart ?? 0;
		if ((e as InputEvent).data === '[' && content.slice(pos - 2, pos) === '[[') {
			linkRange = { start: pos - 2, end: pos, label: null };
			pickerQuery = '';
			pickerOpen = true;
		}
	}

	function onPickPaper(paper: Paper) {
		const range = linkRange;
		linkRange = null;
		if (!range) return;
		const link = paperLinkMarkdown(range.label ?? paper.title, paper.arxivId);
		content = content.slice(0, range.start) + link + content.slice(range.end);
		const pos = range.start + link.length;
		onchange();
		void tick().then(() => {
			textarea?.focus();
			textarea?.setSelectionRange(pos, pos);
		});
	}

	function onCancelPick() {
		linkRange = null;
		void tick().then(() => textarea?.focus());
	}

	/** Open the file picker and embed the chosen images/videos at the caret. */
	export async function pickMedia() {
		const picked = await openDialog({
			multiple: true,
			filters: [{ name: 'Images & videos', extensions: MEDIA_EXTENSIONS }]
		});
		if (!picked) return;
		const paths = Array.isArray(picked) ? picked : [picked];
		await addMedia(paths.map((p) => ({ name: p.split('/').pop() ?? p, read: () => readFile(p) })));
	}

	const MIME_EXT: Record<string, string> = {
		'video/mp4': 'mp4',
		'video/quicktime': 'mov',
		'video/webm': 'webm',
		'image/jpeg': 'jpg',
		'image/svg+xml': 'svg'
	};

	function isMedia(name: string, type: string): boolean {
		if (type.startsWith('image/') || type.startsWith('video/')) return true;
		const ext = name.split('.').pop()?.toLowerCase() ?? '';
		return MEDIA_EXTENSIONS.includes(ext);
	}

	function nameFor(file: File): string {
		if (file.name && file.name.includes('.')) return file.name;
		const ext = MIME_EXT[file.type] ?? file.type.split('/')[1] ?? 'bin';
		return `pasted.${ext}`;
	}

	/** Image syntax for both: NoteMarkdown renders video files as a player. */
	function snippet(rel: string, name: string): string {
		const alt = name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
		return `![${alt}](${rel})`;
	}

	function caret() {
		return {
			start: textarea?.selectionStart ?? content.length,
			end: textarea?.selectionEnd ?? content.length
		};
	}

	/** Insert at the caret (or replace the selection), on its own line. */
	function insertAt(text: string, at: { start: number; end: number }) {
		const before = content.slice(0, at.start);
		const after = content.slice(at.end);
		const lead = before && !before.endsWith('\n') ? '\n' : '';
		const trail = after.startsWith('\n') ? '' : '\n';
		content = before + lead + text + trail + after;
		const pos = (before + lead + text + trail).length;
		onchange();
		void tick().then(() => {
			textarea?.focus();
			textarea?.setSelectionRange(pos, pos);
		});
	}

	async function addMedia(items: { name: string; read: () => Promise<Uint8Array> }[]) {
		if (!items.length) return;
		const at = caret();
		const slug = threadSlug;
		copying += items.length;
		let error: string | null = null;
		onbusy?.(copying, null);
		const snippets: string[] = [];
		for (const item of items) {
			try {
				const rel = await saveNoteMedia(slug, item.name, await item.read());
				snippets.push(snippet(rel, item.name));
			} catch (err) {
				error = `Couldn't save ${item.name}: ${err instanceof Error ? err.message : String(err)}`;
			} finally {
				copying -= 1;
				onbusy?.(copying, error);
			}
		}
		if (snippets.length) insertAt(snippets.join('\n\n'), at);
	}

	function addFiles(files: File[]) {
		return addMedia(
			files
				.filter((f) => isMedia(f.name, f.type))
				.map((f) => ({ name: nameFor(f), read: async () => new Uint8Array(await f.arrayBuffer()) }))
		);
	}

	function onPaste(e: ClipboardEvent) {
		const files = [...(e.clipboardData?.files ?? [])];
		if (!files.some((f) => isMedia(f.name, f.type))) return;
		e.preventDefault();
		void addFiles(files);
	}

	function onDragOver(e: DragEvent) {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
		dragOver = true;
	}

	function onDrop(e: DragEvent) {
		dragOver = false;
		const files = [...(e.dataTransfer?.files ?? [])];
		if (!files.length) return;
		e.preventDefault();
		void addFiles(files);
	}
</script>

<textarea
	bind:this={textarea}
	bind:value={content}
	class={cn(
		'block h-full w-full resize-none bg-transparent font-mono text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none',
		dragOver && 'rounded-md bg-accent/5 ring-2 ring-accent/40'
	)}
	placeholder="Write in markdown. Type [[ to link a paper; paste or drop images and videos to embed them."
	spellcheck="true"
	oninput={onInput}
	onpaste={onPaste}
	ondragover={onDragOver}
	ondragleave={() => (dragOver = false)}
	ondrop={onDrop}
></textarea>

<PaperLinkPicker
	bind:open={pickerOpen}
	bind:query={pickerQuery}
	{threadSlug}
	onPick={onPickPaper}
	onCancel={onCancelPick}
/>
