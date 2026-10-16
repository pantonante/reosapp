<script lang="ts">
	import { goto } from '$app/navigation';
	import { MessageSquare, Plus } from 'lucide-svelte';
	import { Button, Input } from '$lib/components/ui';
	import { ui } from '$lib/stores.svelte';
	import { listThreadChats } from '$lib/tauri/fs';
	import type { ChatSummary } from '$lib/types';

	let { threadSlug }: { threadSlug: string } = $props();

	let chats = $state<ChatSummary[]>([]);
	let loaded = $state(false);
	let error = $state<string | null>(null);
	let search = $state('');

	$effect(() => {
		const slug = threadSlug;
		loaded = false;
		listThreadChats(slug).then(
			(list) => {
				if (slug !== threadSlug) return;
				chats = list;
				error = null;
				loaded = true;
			},
			(err) => {
				error = err instanceof Error ? err.message : String(err);
				loaded = true;
			}
		);
	});

	const visible = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return q ? chats.filter((c) => c.title.toLowerCase().includes(q)) : chats;
	});

	function open(query: string) {
		ui.openThreadChat(threadSlug);
		goto(`/threads/${threadSlug}/chat?${query}`);
	}

	function formatDate(iso: string): string {
		const d = new Date(iso);
		return isNaN(d.getTime())
			? ''
			: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}
</script>

<section class="space-y-6" aria-label="Chats">
	<div class="flex flex-wrap items-center gap-2">
		<Input bind:value={search} placeholder="Filter chats…" class="max-w-xs" />
		<Button class="sm:ml-auto" onclick={() => open('new')}>
			<Plus class="h-4 w-4" />
			New chat
		</Button>
	</div>
	{#if error}
		<p class="text-xs text-destructive">Couldn't read chats: {error}</p>
	{/if}
	{#if loaded && chats.length === 0}
		<div class="rounded-md border border-dashed border-border/60 px-4 py-8 text-center text-xs text-muted-foreground">
			No chats yet. Start one to ask Claude about this thread's papers and notes.
		</div>
	{:else if loaded && visible.length === 0}
		<p class="text-xs text-muted-foreground">No chats match "{search}".</p>
	{/if}
	<div class="space-y-1.5">
		{#each visible as c (c.id)}
			<button
				type="button"
				class="flex w-full items-center gap-2 rounded-md border border-border/60 bg-card px-3 py-2 text-left transition-colors hover:border-border hover:bg-secondary/40"
				onclick={() => open(`c=${encodeURIComponent(c.id)}`)}
			>
				<MessageSquare class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				<span class="min-w-0 flex-1 truncate text-sm font-medium">{c.title}</span>
				<span class="shrink-0 text-[11px] text-muted-foreground">
					{c.messageCount} message{c.messageCount === 1 ? '' : 's'}
				</span>
				<span class="w-24 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
					{formatDate(c.updatedAt)}
				</span>
			</button>
		{/each}
	</div>
</section>
