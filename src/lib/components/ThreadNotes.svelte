<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { ask } from '@tauri-apps/plugin-dialog';
	import { Plus } from 'lucide-svelte';
	import ThreadNoteCard from '$lib/components/ThreadNoteCard.svelte';
	import { Button, Input } from '$lib/components/ui';
	import { cn } from '$lib/utils/cn';
	import { newNoteId } from '$lib/note-format';
	import { noteTabPath, noteTabId, ui } from '$lib/stores.svelte';
	import { notesSync } from '$lib/stores/notes.svelte';
	import { listThreadNotes, removeThreadNote, writeThreadNote } from '$lib/tauri/notes';
	import type { ThreadNote } from '$lib/types';

	let { threadSlug }: { threadSlug: string } = $props();

	let notes = $state<ThreadNote[]>([]);
	let error = $state<string | null>(null);
	let loadedSlug: string | null = null;

	let search = $state('');
	let sortBy = $state<'created' | 'updated' | 'title'>('created');

	const VIEW_KEY = 'reos:notesViewMode';
	let viewMode = $state<'grid' | 'list'>('list');
	try {
		const stored = localStorage.getItem(VIEW_KEY);
		if (stored === 'grid' || stored === 'list') viewMode = stored;
	} catch {
		// storage unavailable — keep the default
	}

	function setViewMode(mode: 'grid' | 'list') {
		viewMode = mode;
		try {
			localStorage.setItem(VIEW_KEY, mode);
		} catch {
			// best effort
		}
	}

	const visibleNotes = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const list = notes.filter((n) => !q || `${n.title}\n${n.content}`.toLowerCase().includes(q));
		if (sortBy === 'updated') list.sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
		else if (sortBy === 'title') list.sort((a, b) => a.title.localeCompare(b.title));
		return list;
	});

	async function load(slug: string) {
		try {
			const fresh = await listThreadNotes(slug);
			if (slug !== threadSlug) return;
			notes = fresh;
			error = null;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}

	$effect(() => {
		const slug = threadSlug;
		void notesSync.revision;
		untrack(() => {
			if (slug !== loadedSlug) {
				loadedSlug = slug;
				notes = [];
			}
			void load(slug);
		});
	});

	/** Same tab model as papers: plain click previews, ⌘-click pins a new tab. */
	function openNote(note: ThreadNote, e?: MouseEvent, edit = false) {
		const newTab = !!(e && (e.metaKey || e.ctrlKey));
		ui.openNote(threadSlug, note.id, note.title, { newTab });
		goto(noteTabPath(noteTabId(threadSlug, note.id)) + (edit ? '?edit' : ''));
	}

	async function createNote() {
		const now = new Date().toISOString();
		const note: ThreadNote = {
			id: newNoteId(),
			title: 'Untitled note',
			content: '',
			createdAt: now,
			updatedAt: now
		};
		await writeThreadNote(threadSlug, note);
		ui.openNote(threadSlug, note.id, note.title, { newTab: true });
		goto(noteTabPath(noteTabId(threadSlug, note.id)) + '?edit');
	}

	async function deleteNote(note: ThreadNote) {
		const ok = await ask(
			`Delete the note "${note.title}"? Images and videos only this note uses are deleted too. This cannot be undone.`,
			{ title: 'Delete note', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Cancel' }
		);
		if (!ok) return;
		const remaining = notes.filter((n) => n.id !== note.id);
		await removeThreadNote(threadSlug, note, remaining);
		ui.closeNote(threadSlug, note.id);
		notes = remaining;
	}
</script>

<section class="space-y-6" aria-label="Notes">
	<div class="flex flex-wrap items-center gap-2">
		<Input bind:value={search} placeholder="Filter notes…" class="max-w-xs" />
		<div class="flex items-center rounded-md border border-input bg-background p-0.5 sm:ml-auto">
			{#each [['grid', 'Grid'], ['list', 'List']] as const as [value, label] (value)}
				<button
					type="button"
					class={cn(
						'h-7 rounded px-3 text-xs font-medium transition-colors',
						viewMode === value
							? 'bg-secondary text-foreground'
							: 'text-muted-foreground hover:text-foreground'
					)}
					onclick={() => setViewMode(value)}
				>
					{label}
				</button>
			{/each}
		</div>
		<select
			class="h-9 rounded-md border border-input bg-background px-3 text-sm"
			bind:value={sortBy}
		>
			<option value="created">Created</option>
			<option value="updated">Recently edited</option>
			<option value="title">Title</option>
		</select>
		<Button onclick={() => void createNote()}>
			<Plus class="h-4 w-4" />
			New note
		</Button>
	</div>
	{#if error}
		<p class="text-xs text-destructive">Couldn't read notes: {error}</p>
	{/if}
	{#if notes.length === 0}
		<div class="rounded-md border border-dashed border-border/60 px-4 py-8 text-center text-xs text-muted-foreground">
			No notes yet. Write one, or ask Claude to create one through the Re:OS MCP server.
		</div>
	{:else if visibleNotes.length === 0}
		<p class="text-xs text-muted-foreground">No notes match "{search}".</p>
	{/if}
	<div class={viewMode === 'grid' ? 'grid gap-2 md:grid-cols-2 xl:grid-cols-3' : 'space-y-1.5'}>
		{#each visibleNotes as note (note.id)}
			<ThreadNoteCard
				{note}
				{threadSlug}
				layout={viewMode}
				onOpen={(e) => openNote(note, e)}
				onEdit={(e) => openNote(note, e, true)}
				onDelete={() => void deleteNote(note)}
			/>
		{/each}
	</div>
</section>
