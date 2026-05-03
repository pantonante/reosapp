<script lang="ts">
	import { goto } from '$app/navigation';
	import { threads, ui } from '$lib/stores.svelte';
	import { Button, Dialog, Input, Textarea } from '$lib/components/ui';
	import type { Thread } from '$lib/types';

	let title = $state('');
	let question = $state('');

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
			updatedAt: new Date().toISOString()
		};
		await threads.add(t);
		reset();
		ui.newThreadOpen = false;
		ui.openThread(t.id);
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
