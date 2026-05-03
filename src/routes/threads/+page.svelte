<script lang="ts">
	import { threads, ui } from '$lib/stores.svelte';
	import { Button, Card, Input, Dialog, Textarea } from '$lib/components/ui';
	import { goto } from '$app/navigation';
	import { Plus, LayoutGrid, Rows3 } from 'lucide-svelte';
	import type { Thread, ThreadStatus } from '$lib/types';

	let createOpen = $state(false);
	let newTitle = $state('');
	let newQuestion = $state('');

	const cols: { status: ThreadStatus; label: string }[] = [
		{ status: 'active', label: 'Active' },
		{ status: 'paused', label: 'Paused' },
		{ status: 'concluded', label: 'Concluded' }
	];

	function byStatus(status: ThreadStatus): Thread[] {
		return threads.items.filter((t) => t.status === status);
	}

	async function createThread() {
		const t: Thread = {
			id: `t${Date.now()}`,
			title: newTitle.trim() || 'Untitled thread',
			question: newQuestion.trim(),
			status: 'active',
			papers: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		};
		await threads.add(t);
		newTitle = '';
		newQuestion = '';
		createOpen = false;
		ui.openThread(t.id);
		goto(`/threads/${t.id}`);
	}

	function open(t: Thread) {
		ui.openThread(t.id);
		goto(`/threads/${t.id}`);
	}
</script>

<div class="space-y-6 p-8">
	<header class="flex items-end justify-between">
		<div>
			<h1 class="font-mono text-2xl font-light tracking-tight">Threads</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				{threads.items.length} threads
			</p>
		</div>
		<div class="flex items-center gap-2">
			<div class="flex gap-1 rounded-md border border-border/60 p-0.5">
				<Button
					variant={!ui.threadsCompact ? 'secondary' : 'ghost'}
					size="icon"
					onclick={() => (ui.threadsCompact = false)}
					aria-label="Kanban view"
				>
					<LayoutGrid class="h-4 w-4" />
				</Button>
				<Button
					variant={ui.threadsCompact ? 'secondary' : 'ghost'}
					size="icon"
					onclick={() => (ui.threadsCompact = true)}
					aria-label="Compact view"
				>
					<Rows3 class="h-4 w-4" />
				</Button>
			</div>
			<Button onclick={() => (createOpen = true)}>
				<Plus class="h-4 w-4" />
				New thread
			</Button>
		</div>
	</header>

	{#if ui.threadsCompact}
		<div class="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
			{#each threads.items as t (t.id)}
				<button
					class="rounded-md border border-border/60 bg-card p-2 text-left transition-colors hover:border-border hover:bg-card/80"
					onclick={() => open(t)}
				>
					<div class="flex items-center gap-2">
						<span class="h-1.5 w-1.5 rounded-full {t.status === 'active' ? 'bg-accent' : t.status === 'paused' ? 'bg-yellow-500' : 'bg-muted-foreground/60'}"></span>
						<span class="line-clamp-1 text-xs font-medium">{t.title}</span>
					</div>
					<div class="mt-1 text-[10px] text-muted-foreground">{t.papers.length} papers</div>
				</button>
			{/each}
		</div>
	{:else}
		<div class="grid gap-6 lg:grid-cols-3">
			{#each cols as col (col.status)}
				<div>
					<h3 class="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
						<span class="h-1.5 w-1.5 rounded-full {col.status === 'active' ? 'bg-accent' : col.status === 'paused' ? 'bg-yellow-500' : 'bg-muted-foreground/60'}"></span>
						{col.label}
						<span class="ml-auto font-mono text-[10px] text-muted-foreground/80">
							{byStatus(col.status).length}
						</span>
					</h3>
					<div class="space-y-2">
						{#each byStatus(col.status) as t (t.id)}
							<Card class="cursor-pointer p-3 transition-colors hover:border-border hover:bg-card/80">
								<button class="w-full text-left" onclick={() => open(t)}>
									<div class="line-clamp-2 text-sm font-medium">{t.title}</div>
									{#if t.question}
										<div class="mt-1 line-clamp-2 text-xs text-muted-foreground">{t.question}</div>
									{/if}
									<div class="mt-2 text-[10px] text-muted-foreground">{t.papers.length} papers</div>
								</button>
							</Card>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	{/if}

	{#if threads.items.length === 0}
		<div class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 py-20 text-center text-sm text-muted-foreground">
			<p>No threads yet.</p>
			<Button class="mt-4" onclick={() => (createOpen = true)}>
				<Plus class="h-4 w-4" />
				Create your first thread
			</Button>
		</div>
	{/if}
</div>

<Dialog bind:open={createOpen} title="New thread" description="Group papers around a research question.">
	<div class="space-y-3">
		<div>
			<label for="t-title" class="text-xs text-muted-foreground">Title</label>
			<Input id="t-title" bind:value={newTitle} placeholder="Linear attention scaling" />
		</div>
		<div>
			<label for="t-question" class="text-xs text-muted-foreground">Question (optional)</label>
			<Textarea
				id="t-question"
				bind:value={newQuestion}
				placeholder="What is the practical ceiling for linear-attention transformers?"
				rows={3}
			/>
		</div>
		<div class="flex justify-end gap-2 pt-2">
			<Button variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
			<Button onclick={createThread}>Create</Button>
		</div>
	</div>
</Dialog>
