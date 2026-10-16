<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { join } from '@tauri-apps/api/path';
	import { ask } from '@tauri-apps/plugin-dialog';
	import { Check, Copy, Eye, FileSymlink, FolderOpen, ImagePlus, Loader2, PencilLine, Trash2 } from 'lucide-svelte';
	import NoteEditor from '$lib/components/NoteEditor.svelte';
	import NoteMarkdown from '$lib/components/NoteMarkdown.svelte';
	import { ui } from '$lib/stores.svelte';
	import { notesSync } from '$lib/stores/notes.svelte';
	import {
		listThreadNotes,
		notesDir,
		readThreadNote,
		removeThreadNote,
		writeThreadNote
	} from '$lib/tauri/notes';
	import { revealInFinder } from '$lib/tauri/shell';
	import type { ThreadNote } from '$lib/types';
	import { cn } from '$lib/utils/cn';

	let {
		threadSlug,
		noteId,
		startInEdit = false
	}: { threadSlug: string; noteId: string; startInEdit?: boolean } = $props();

	const SAVE_DELAY_MS = 700;

	let note = $state<ThreadNote | null>(null);
	let loaded = $state(false);
	let mode = $state<'preview' | 'edit'>(untrack(() => (startInEdit ? 'edit' : 'preview')));
	let title = $state('');
	let content = $state('');
	let dirty = $state(false);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let copying = $state(0);
	let mediaError = $state<string | null>(null);
	let editor = $state<NoteEditor | null>(null);
	let titleInput = $state<HTMLInputElement | null>(null);
	let focusedOnce = false;
	let saveTimer: ReturnType<typeof setTimeout> | null = null;

	async function load() {
		const fresh = await readThreadNote(threadSlug, noteId);
		loaded = true;
		// Never clobber unsaved typing with the disk copy.
		if (dirty || saving) return;
		note = fresh;
		if (!fresh) return;
		title = fresh.title;
		content = fresh.content;
		ui.openNote(threadSlug, noteId, fresh.title);
		ui.setNoteTitle(threadSlug, noteId, fresh.title);
		if (!focusedOnce && mode === 'edit') {
			focusedOnce = true;
			await tick();
			// A fresh note starts at its title; anything else at the body.
			if (!fresh.content.trim() && fresh.title === 'Untitled note') titleInput?.select();
			else editor?.focus();
		}
	}

	// Initial load, plus a re-read whenever the MCP server writes to the library.
	$effect(() => {
		void notesSync.revision;
		untrack(() => void load());
	});

	function schedule() {
		dirty = true;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => void flush(), SAVE_DELAY_MS);
	}

	async function flush() {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		if (!dirty || !note) return;
		dirty = false;
		saving = true;
		const next: ThreadNote = {
			...note,
			title: title.trim() || 'Untitled note',
			content,
			updatedAt: new Date().toISOString()
		};
		try {
			await writeThreadNote(threadSlug, next);
			note = next;
			saveError = null;
			ui.setNoteTitle(threadSlug, noteId, next.title);
		} catch (err) {
			dirty = true;
			saveError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	onDestroy(() => {
		void flush();
	});

	async function setMode(next: 'preview' | 'edit') {
		if (next === mode) return;
		if (next === 'preview') await flush();
		mode = next;
		if (next === 'edit') {
			await tick();
			editor?.focus();
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
			e.preventDefault();
			void setMode(mode === 'edit' ? 'preview' : 'edit');
		} else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
			e.preventDefault();
			void flush();
		}
	}

	// Same idea as the paper page's copy-reference: enough for Claude to find
	// the note with the MCP get_note / update_note tools.
	let refCopyState = $state<'idle' | 'copied' | 'failed'>('idle');
	let refCopyReset: ReturnType<typeof setTimeout> | undefined;
	const noteRef = $derived(`${noteId} in thread ${threadSlug} ("${note?.title ?? ''}")`);

	async function copyNoteRef() {
		try {
			await navigator.clipboard.writeText(noteRef);
			refCopyState = 'copied';
		} catch {
			refCopyState = 'failed';
		}
		if (refCopyReset) clearTimeout(refCopyReset);
		refCopyReset = setTimeout(() => (refCopyState = 'idle'), 1800);
	}

	async function reveal() {
		await flush();
		await revealInFinder(await join(await notesDir(threadSlug), `${noteId}.md`));
	}

	async function deleteNote() {
		if (!note) return;
		const ok = await ask(
			`Delete the note "${note.title}"? Images and videos only this note uses are deleted too. This cannot be undone.`,
			{ title: 'Delete note', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Cancel' }
		);
		if (!ok) return;
		if (saveTimer) clearTimeout(saveTimer);
		dirty = false;
		const remaining = (await listThreadNotes(threadSlug)).filter((n) => n.id !== noteId);
		await removeThreadNote(threadSlug, note, remaining);
		ui.closeNote(threadSlug, noteId);
		goto(`/threads/${threadSlug}`);
	}

	const status = $derived(
		saveError
			? 'Not saved'
			: saving
				? 'Saving…'
				: dirty
					? 'Edited'
					: note
						? `Saved · ${note.updatedAt.slice(0, 10)}`
						: ''
	);

	const MODES = [
		{ value: 'preview', label: 'Preview', icon: Eye },
		{ value: 'edit', label: 'Edit', icon: PencilLine }
	] as const;
</script>

<svelte:window onkeydown={onKeydown} />

{#if loaded && !note}
	<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
		Note not found.
	</div>
{:else}
	<div class="flex h-full flex-col">
		<div class="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-card px-2">
			<div
				class="inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-background/40 p-0.5"
				role="tablist"
				aria-label="Note mode"
			>
				{#each MODES as m (m.value)}
					<button
						type="button"
						role="tab"
						aria-selected={mode === m.value}
						aria-label={m.label}
						title="{m.label} (⌘E)"
						class={cn(
							'inline-flex items-center rounded px-2 py-1 transition-colors',
							mode === m.value
								? 'bg-accent/15 text-accent'
								: 'text-muted-foreground hover:text-foreground'
						)}
						onclick={() => void setMode(m.value)}
					>
						<m.icon class="h-3.5 w-3.5" />
					</button>
				{/each}
			</div>

			<div class="flex min-w-0 items-center gap-0.5">
				{#if copying > 0}
					<span class="flex items-center gap-1 px-2 text-[11px] text-muted-foreground">
						<Loader2 class="h-3 w-3 animate-spin" /> Copying media…
					</span>
				{/if}
				<span
					class={cn('truncate px-2 text-[11px]', saveError ? 'text-destructive' : 'text-muted-foreground')}
					title={saveError ?? undefined}
					aria-live="polite"
				>
					{status}
				</span>
				{#if mode === 'edit'}
					<button
						class="inline-flex items-center rounded px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						onclick={() => editor?.linkPaper()}
						title="Link a paper (or type [[ in the editor)"
						aria-label="Link a paper"
					>
						<FileSymlink class="h-3.5 w-3.5" />
					</button>
					<button
						class="inline-flex items-center rounded px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						onclick={() => void editor?.pickMedia()}
						title="Insert image or video (or paste / drop into the editor)"
						aria-label="Insert image or video"
					>
						<ImagePlus class="h-3.5 w-3.5" />
					</button>
				{/if}
				<button
					class={cn(
						'inline-flex items-center rounded px-2 py-1 transition-colors hover:bg-muted hover:text-foreground',
						refCopyState === 'failed' ? 'text-destructive' : 'text-muted-foreground'
					)}
					onclick={() => void copyNoteRef()}
					title={refCopyState === 'failed' ? 'Could not copy the reference' : `Copy reference: ${noteRef}`}
					aria-label="Copy reference"
				>
					{#if refCopyState === 'copied'}
						<Check class="h-3.5 w-3.5" />
					{:else}
						<Copy class="h-3.5 w-3.5" />
					{/if}
				</button>
				<button
					class="inline-flex items-center rounded px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					onclick={() => void reveal()}
					title="Reveal in Finder"
					aria-label="Reveal in Finder"
				>
					<FolderOpen class="h-3.5 w-3.5" />
				</button>
				<button
					class="inline-flex items-center rounded px-2 py-1 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
					onclick={() => void deleteNote()}
					title="Delete note"
					aria-label="Delete note"
				>
					<Trash2 class="h-3.5 w-3.5" />
				</button>
			</div>
		</div>

		{#if mediaError}
			<p class="shrink-0 border-b border-border/60 px-4 py-1.5 text-xs text-destructive">{mediaError}</p>
		{/if}

		{#if note}
			{#if mode === 'edit'}
				<div class="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-6 py-6 sm:px-10">
					<input
						class="w-full shrink-0 bg-transparent font-mono text-2xl font-light tracking-tight text-foreground placeholder:text-muted-foreground/60 focus:outline-hidden"
						placeholder="Note title"
						bind:this={titleInput}
						bind:value={title}
						oninput={schedule}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								editor?.focus();
							}
						}}
					/>
					<div class="mt-4 min-h-0 flex-1">
						<NoteEditor
							bind:this={editor}
							bind:content
							{threadSlug}
							onchange={schedule}
							onbusy={(n, err) => {
								copying = n;
								mediaError = err;
							}}
						/>
					</div>
				</div>
			{:else}
				<div class="min-h-0 flex-1 overflow-y-auto">
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<article
						class="mx-auto w-full max-w-3xl px-6 py-8 sm:px-10"
						ondblclick={() => void setMode('edit')}
					>
						<h1 class="font-mono text-2xl font-light tracking-tight text-foreground">{note.title}</h1>
						<p class="mt-1 text-[11px] text-muted-foreground">
							created {note.createdAt.slice(0, 10)} · edited {note.updatedAt.slice(0, 10)}
						</p>
						<div class="mt-6">
							{#if content.trim()}
								<NoteMarkdown {content} {threadSlug} />
							{:else}
								<p class="text-sm text-muted-foreground">
									Empty note. Switch to edit mode (⌘E) or double-click to start writing.
								</p>
							{/if}
						</div>
					</article>
				</div>
			{/if}
		{/if}
	</div>
{/if}
