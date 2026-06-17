<script lang="ts">
	import { goto } from '$app/navigation';
	import { threads, ui } from '$lib/stores.svelte';
	import { Button, Dialog, Input, Textarea } from '$lib/components/ui';
	import { X } from 'lucide-svelte';
	import type { Thread } from '$lib/types';

	let title = $state('');
	let question = $state('');

	const parent = $derived(ui.newThreadParentId ? threads.get(ui.newThreadParentId) : null);

	function reset() {
		title = '';
		question = '';
	}

	async function create() {
		const t: Thread = {
			id: `t${Date.now()}`,
			title: title.trim() || 'Untitled thread',
			question: question.trim(),
			status: 'active',
			papers: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			parentId: ui.newThreadParentId ?? null
		};
		await threads.add(t);
		reset();
		ui.newThreadOpen = false;
		ui.openThread(t.id, { newTab: true });
		goto(`/threads/${t.id}`);
	}
</script>

<Dialog
	bind:open={ui.newThreadOpen}
	title="New thread"
	description="Group papers around a research question."
	onOpenChange={(open) => {
		if (!open) reset();
	}}
>
	<div class="space-y-3">
		{#if parent}
			<div class="flex items-center justify-between rounded-md border border-border/60 bg-secondary/30 px-2.5 py-1.5 text-xs">
				<span class="truncate text-muted-foreground">
					Sub-thread of <span class="text-foreground">{parent.title}</span>
				</span>
				<button
					type="button"
					class="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
					onclick={() => (ui.newThreadParentId = null)}
					aria-label="Make root thread"
					title="Make root thread"
				>
					<X class="h-3 w-3" />
				</button>
			</div>
		{/if}
		<div>
			<label for="nt-title" class="text-xs text-muted-foreground">Title</label>
			<Input id="nt-title" bind:value={title} placeholder="Linear attention scaling" />
		</div>
		<div>
			<label for="nt-question" class="text-xs text-muted-foreground">Question (optional)</label>
			<Textarea
				id="nt-question"
				bind:value={question}
				placeholder="What is the practical ceiling for linear-attention transformers?"
				rows={3}
			/>
		</div>
		<div class="flex justify-end gap-2 pt-2">
			<Button variant="ghost" onclick={() => (ui.newThreadOpen = false)}>Cancel</Button>
			<Button onclick={create}>Create</Button>
		</div>
	</div>
</Dialog>
