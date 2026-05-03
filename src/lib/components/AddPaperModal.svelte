<script lang="ts">
	import { Button, Dialog, Input } from '$lib/components/ui';
	import { extractArxivId, fetchArxivPaper, downloadArxivPdf } from '$lib/arxiv';
	import { writePaperPdf } from '$lib/tauri/fs';
	import { papers, ui } from '$lib/stores.svelte';
	import { goto } from '$app/navigation';
	import { Loader2, Link2, Upload } from 'lucide-svelte';

	let raw = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let dragActive = $state(false);

	function reset() {
		raw = '';
		busy = false;
		error = null;
		dragActive = false;
	}

	async function importFromArxiv() {
		const arxivId = extractArxivId(raw);
		if (!arxivId) {
			error = 'Could not parse an Arxiv ID from that input.';
			return;
		}
		const existing = papers.items.find((p) => p.arxivId === arxivId);
		if (existing) {
			ui.addPaperOpen = false;
			goto(`/paper/${existing.id}`);
			return;
		}
		busy = true;
		error = null;
		try {
			const paper = await fetchArxivPaper(arxivId);
			const pdfBytes = await downloadArxivPdf(arxivId);
			const pdfPath = await writePaperPdf('inbox', arxivId, pdfBytes);
			await papers.add({ ...paper, pdfPath, threadId: 'inbox' });
			ui.addPaperOpen = false;
			reset();
			goto(`/paper/${paper.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			busy = false;
		}
	}

	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragActive = false;
		const file = e.dataTransfer?.files?.[0];
		if (!file) return;
		if (!file.name.toLowerCase().endsWith('.pdf')) {
			error = 'Drop a PDF file.';
			return;
		}
		busy = true;
		error = null;
		try {
			const buf = new Uint8Array(await file.arrayBuffer());
			const arxivId = extractArxivId(file.name) ?? `local-${Date.now()}`;
			const pdfPath = await writePaperPdf('inbox', arxivId, buf);
			const id = `p${Date.now()}`;
			const title = file.name.replace(/\.pdf$/i, '');
			await papers.add({
				id,
				arxivId,
				title,
				authors: [],
				abstract: '',
				publishedDate: '',
				categories: [],
				tags: [],
				readingStatus: 'unread',
				rating: null,
				pdfPath,
				arxivUrl: '',
				addedAt: new Date().toISOString(),
				links: [],
				threadId: 'inbox'
			});
			ui.addPaperOpen = false;
			reset();
			goto(`/paper/${id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			busy = false;
		}
	}
</script>

<Dialog
	bind:open={ui.addPaperOpen}
	title="Add paper"
	description="Paste an arxiv link or ID, or drop a PDF file."
	onOpenChange={(open) => {
		if (!open) reset();
	}}
>
	<div class="space-y-4">
		<div class="space-y-2">
			<div class="flex items-center gap-2 text-xs text-muted-foreground">
				<Link2 class="h-3.5 w-3.5" />
				Arxiv link or ID
			</div>
			<div class="flex gap-2">
				<Input
					bind:value={raw}
					placeholder="2604.07209 or https://arxiv.org/abs/…"
					class="font-mono text-xs"
					onkeydown={(e: KeyboardEvent) => {
						if (e.key === 'Enter') importFromArxiv();
					}}
				/>
				<Button onclick={importFromArxiv} disabled={busy || !raw.trim()}>
					{#if busy}
						<Loader2 class="h-4 w-4 animate-spin" />
					{/if}
					Import
				</Button>
			</div>
		</div>

		<div class="relative">
			<div class="absolute inset-0 flex items-center">
				<div class="w-full border-t border-border/60"></div>
			</div>
			<div class="relative flex justify-center">
				<span class="bg-card px-2 text-[10px] uppercase tracking-wider text-muted-foreground">or</span>
			</div>
		</div>

		<div
			role="region"
			aria-label="Drop a PDF here"
			class="flex flex-col items-center justify-center rounded-md border border-dashed border-border/60 px-6 py-10 text-sm transition-colors {dragActive
				? 'border-accent bg-accent/5 text-accent'
				: 'text-muted-foreground'}"
			ondragover={(e) => {
				e.preventDefault();
				dragActive = true;
			}}
			ondragleave={() => (dragActive = false)}
			ondrop={handleDrop}
		>
			<Upload class="h-5 w-5" />
			<span class="mt-2 text-xs">Drop a PDF here</span>
		</div>

		{#if error}
			<p class="text-sm text-destructive">{error}</p>
		{/if}

		<!-- TODO: AI-assisted metadata extraction from dropped PDFs without an arxiv ID -->
	</div>
</Dialog>
