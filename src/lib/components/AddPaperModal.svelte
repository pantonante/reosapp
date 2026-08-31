<script lang="ts">
	import { Button, Dialog, Input } from '$lib/components/ui';
	import { canonicalizeArxivInput, extractArxivId, fetchArxivPaper, downloadArxivPdf } from '$lib/arxiv';
	import {
		extractBiorxivRef,
		biorxivPaperId,
		fetchBiorxivPaper,
		downloadBiorxivPdf,
		type BiorxivRef
	} from '$lib/biorxiv';
	import { prepareWebSource } from '$lib/web';
	import type { Paper } from '$lib/types';
	import { writePaperPdf, removePaperFolder } from '$lib/tauri/fs';
	import { extractPdfMetadata, extractWebpageMetadata } from '$lib/tauri/extract';
	import { papers, threads, ui } from '$lib/stores.svelte';
	import { goto } from '$app/navigation';
	import { Loader2, Link2, Upload, Sparkles, FileText, Globe } from 'lucide-svelte';

	let raw = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let dragActive = $state(false);

	// PDF + extraction state
	type Stage = 'idle' | 'extracting' | 'review';
	type SourceKind = 'pdf' | 'web';
	let stage = $state<Stage>('idle');
	let extractError = $state<string | null>(null);
	let pendingSourceKind = $state<SourceKind>('pdf');
	let pendingPdfPath = $state<string | null>(null);
	let pendingArxivId = $state<string | null>(null);
	let pendingThreadSlug = $state<string | null>(null);
	let pendingFileName = $state('');
	let pendingSourceUrl = $state<string | null>(null);

	// Editable extracted metadata
	let metaTitle = $state('');
	let metaAuthors = $state('');
	let metaYear = $state('');
	let metaAbstract = $state('');

	const targetThreadId = $derived(ui.addPaperTargetThreadId ?? 'inbox');
	const targetThreadTitle = $derived(
		targetThreadId === 'inbox' ? null : (threads.get(targetThreadId)?.title ?? null)
	);

	function reset() {
		raw = '';
		busy = false;
		error = null;
		dragActive = false;
		stage = 'idle';
		extractError = null;
		pendingSourceKind = 'pdf';
		pendingPdfPath = null;
		pendingArxivId = null;
		pendingThreadSlug = null;
		pendingFileName = '';
		pendingSourceUrl = null;
		metaTitle = '';
		metaAuthors = '';
		metaYear = '';
		metaAbstract = '';
	}

	async function discardPending() {
		if (pendingThreadSlug && pendingArxivId) {
			try {
				await removePaperFolder(pendingThreadSlug, pendingArxivId);
			} catch {
				// best-effort cleanup
			}
		}
	}

	async function attachToThread(paperId: string) {
		if (targetThreadId === 'inbox') return;
		const dest = threads.get(targetThreadId);
		if (!dest) return;
		await threads.update(targetThreadId, {
			papers: [...dest.papers, { paperId, contextNote: '', order: dest.papers.length }]
		});
	}

	async function importFromInput() {
		const trimmed = raw.trim();
		if (!trimmed) return;
		const canonicalInput = canonicalizeArxivInput(trimmed);
		if (canonicalInput !== trimmed) raw = canonicalInput;
		// bioRxiv/medRxiv links (and bare dated DOIs) get the preprint pipeline,
		// not the generic webpage one.
		const biorxivRef = extractBiorxivRef(canonicalInput);
		if (biorxivRef) {
			await importFromBiorxiv(biorxivRef);
			return;
		}
		// If the input is a non-arxiv URL, take the webpage path even when the
		// Arxiv regex happens to match a number pattern inside the URL (e.g.
		// `example.com/2024.0123/...`). Only short-circuit to Arxiv when the
		// URL host is arxiv.org or the input isn't a URL at all.
		const prepared = await prepareWebSource(canonicalInput);
		const isArxivHost = prepared
			? /(^|\.)arxiv\.org$/i.test(new URL(prepared.normalizedUrl).hostname)
			: false;
		const arxivId = extractArxivId(canonicalInput);
		if (arxivId && (isArxivHost || !prepared)) {
			await importFromArxivId(arxivId);
			return;
		}
		if (prepared) {
			await importFromWebpage(prepared.normalizedUrl, prepared.webId);
			return;
		}
		error = 'Could not parse an Arxiv ID or URL from that input.';
	}

	// Shared tail of the arXiv/bioRxiv pipelines: fetch metadata, download the
	// PDF, persist, and jump to the new paper. Returns to the existing paper
	// when the ID is already in the library.
	async function importRemotePaper(
		dedupId: string,
		fetchPaper: () => Promise<Paper>,
		downloadPdf: (paper: Paper) => Promise<Uint8Array>
	) {
		const existing = papers.items.find((p) => p.arxivId === dedupId);
		if (existing) {
			ui.addPaperOpen = false;
			goto(`/paper/${existing.id}`);
			return;
		}
		busy = true;
		error = null;
		try {
			const paper = await fetchPaper();
			const pdfBytes = await downloadPdf(paper);
			const pdfPath = await writePaperPdf(targetThreadId, paper.arxivId, pdfBytes);
			await papers.add({ ...paper, pdfPath, threadId: targetThreadId });
			await attachToThread(paper.id);
			ui.addPaperOpen = false;
			reset();
			goto(`/paper/${paper.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			busy = false;
		}
	}

	async function importFromArxivId(arxivId: string) {
		await importRemotePaper(
			arxivId,
			() => fetchArxivPaper(arxivId),
			() => downloadArxivPdf(arxivId)
		);
	}

	async function importFromBiorxiv(ref: BiorxivRef) {
		await importRemotePaper(
			biorxivPaperId(ref),
			() => fetchBiorxivPaper(ref),
			(paper) => downloadBiorxivPdf(paper.arxivUrl)
		);
	}

	async function importFromWebpage(normalizedUrl: string, webId: string) {
		// Dedup by normalized URL — opening Add Paper with a URL already in the
		// library should just jump to the existing paper.
		const existing = papers.items.find((p) => p.sourceUrl === normalizedUrl);
		if (existing) {
			ui.addPaperOpen = false;
			goto(`/paper/${existing.id}`);
			return;
		}

		error = null;
		extractError = null;
		const slug = targetThreadId;
		pendingSourceKind = 'web';
		pendingArxivId = webId;
		pendingThreadSlug = slug;
		pendingSourceUrl = normalizedUrl;
		pendingFileName = new URL(normalizedUrl).hostname;
		pendingPdfPath = null;
		metaTitle = pendingFileName;
		metaAuthors = '';
		metaYear = '';
		metaAbstract = '';
		stage = 'extracting';

		try {
			const meta = await extractWebpageMetadata(normalizedUrl);
			if (meta.title) metaTitle = meta.title;
			metaAuthors = (meta.authors ?? []).join(', ');
			metaYear = meta.year ?? '';
			metaAbstract = meta.abstract ?? '';
		} catch (extractErr) {
			extractError = extractErr instanceof Error ? extractErr.message : String(extractErr);
		}
		stage = 'review';
	}

	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragActive = false;
		if (stage !== 'idle') return;
		const file = e.dataTransfer?.files?.[0];
		if (!file) return;
		if (!file.name.toLowerCase().endsWith('.pdf')) {
			error = 'Drop a PDF file.';
			return;
		}
		error = null;
		extractError = null;

		try {
			const buf = new Uint8Array(await file.arrayBuffer());
			const arxivIdFromName = extractArxivId(file.name);
			const arxivId = arxivIdFromName ?? `local-${Date.now()}`;
			const slug = targetThreadId;
			const pdfPath = await writePaperPdf(slug, arxivId, buf);

			pendingSourceKind = 'pdf';
			pendingPdfPath = pdfPath;
			pendingArxivId = arxivId;
			pendingThreadSlug = slug;
			pendingFileName = file.name;
			pendingSourceUrl = null;

			// Pre-fill title from filename so the user has *something* useful even
			// if extraction fails.
			metaTitle = file.name.replace(/\.pdf$/i, '');
			metaAuthors = '';
			metaYear = '';
			metaAbstract = '';
			stage = 'extracting';

			try {
				const meta = await extractPdfMetadata(pdfPath);
				if (meta.title) metaTitle = meta.title;
				metaAuthors = (meta.authors ?? []).join(', ');
				metaYear = meta.year ?? '';
				metaAbstract = meta.abstract ?? '';
			} catch (extractErr) {
				extractError =
					extractErr instanceof Error ? extractErr.message : String(extractErr);
			}
			stage = 'review';
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			stage = 'idle';
		}
	}

	async function confirmPdfPaper() {
		if (!pendingArxivId || !pendingThreadSlug) return;
		if (pendingSourceKind === 'pdf' && !pendingPdfPath) return;
		if (pendingSourceKind === 'web' && !pendingSourceUrl) return;
		busy = true;
		error = null;
		try {
			const id = `p${Date.now()}`;
			const authors = metaAuthors
				.split(',')
				.map((a) => a.trim())
				.filter(Boolean);
			const yearTrim = metaYear.trim();
			const publishedDate = /^\d{4}$/.test(yearTrim) ? `${yearTrim}-01-01` : '';
			const fallbackTitle =
				pendingSourceKind === 'web'
					? pendingFileName
					: pendingFileName.replace(/\.pdf$/i, '');
			await papers.add({
				id,
				arxivId: pendingArxivId,
				title: metaTitle.trim() || fallbackTitle,
				authors,
				abstract: metaAbstract.trim(),
				publishedDate,
				categories: [],
				tags: [],
				readingStatus: 'unread',
				rating: null,
				pdfPath: pendingSourceKind === 'pdf' ? pendingPdfPath! : '',
				arxivUrl: '',
				sourceUrl: pendingSourceKind === 'web' ? pendingSourceUrl! : undefined,
				addedAt: new Date().toISOString(),
				links: [],
				threadId: pendingThreadSlug
			});
			await attachToThread(id);
			ui.addPaperOpen = false;
			reset();
			goto(`/paper/${id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			busy = false;
		}
	}

	async function cancelPdfReview() {
		await discardPending();
		reset();
	}
</script>

<Dialog
	bind:open={ui.addPaperOpen}
	title={stage === 'review'
		? 'Review extracted metadata'
		: targetThreadTitle
			? `Add paper to “${targetThreadTitle}”`
			: 'Add paper'}
	description={stage === 'review'
		? 'AI-extracted metadata. Edit anything that looks off, then add.'
		: stage === 'extracting'
			? pendingSourceKind === 'web'
				? 'Fetching the page and pulling out metadata…'
				: 'Reading the PDF and pulling out metadata…'
			: 'Paste an Arxiv/bioRxiv link or ID, a webpage URL, or drop a PDF.'}
	onOpenChange={(open) => {
		if (!open) {
			// Closing during review/extracting drops the temp paper folder.
			discardPending();
			reset();
			ui.addPaperTargetThreadId = null;
		}
	}}
>
	{#if stage === 'extracting'}
		<div class="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
			<div class="relative">
				<Sparkles class="h-6 w-6 text-accent" />
				<Loader2 class="absolute -right-3 -top-1 h-3.5 w-3.5 animate-spin text-accent" />
			</div>
			<p class="font-medium text-foreground">Extracting metadata…</p>
			<p class="text-xs">This usually takes 10–30 seconds.</p>
			{#if pendingFileName}
				<p class="mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
					{#if pendingSourceKind === 'web'}
						<Globe class="h-3 w-3" />
					{:else}
						<FileText class="h-3 w-3" />
					{/if}
					<span class="font-mono">{pendingFileName}</span>
				</p>
			{/if}
		</div>
	{:else if stage === 'review'}
		<div class="space-y-4">
			{#if extractError}
				<div
					class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
				>
					AI extraction failed: {extractError}. Fill in the fields manually below.
				</div>
			{:else}
				<p class="inline-flex items-center gap-1.5 text-[11px] text-accent">
					<Sparkles class="h-3 w-3" />
					Pre-filled from the {pendingSourceKind === 'web' ? 'webpage' : 'PDF'} — review and edit.
				</p>
			{/if}

			<div class="space-y-1.5">
				<label for="meta-title" class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
					Title
				</label>
				<Input id="meta-title" bind:value={metaTitle} placeholder="Paper title" />
			</div>

			<div class="space-y-1.5">
				<label
					for="meta-authors"
					class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
				>
					Authors
				</label>
				<Input
					id="meta-authors"
					bind:value={metaAuthors}
					placeholder="Author 1, Author 2, …"
				/>
			</div>

			<div class="grid grid-cols-[120px_1fr] gap-3">
				<div class="space-y-1.5">
					<label
						for="meta-year"
						class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
					>
						Year
					</label>
					<Input id="meta-year" bind:value={metaYear} placeholder="2024" />
				</div>
				<div class="space-y-1.5">
					<span
						class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
					>
						{pendingSourceKind === 'web' ? 'Source' : 'File'}
					</span>
					<div
						class="flex h-9 items-center gap-1.5 truncate rounded-md border border-border/60 bg-secondary/30 px-3 font-mono text-xs text-muted-foreground"
						title={pendingSourceUrl ?? pendingFileName}
					>
						{#if pendingSourceKind === 'web'}
							<Globe class="h-3 w-3 shrink-0" />
						{:else}
							<FileText class="h-3 w-3 shrink-0" />
						{/if}
						<span class="truncate">{pendingFileName}</span>
					</div>
				</div>
			</div>

			<div class="space-y-1.5">
				<label
					for="meta-abstract"
					class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
				>
					Abstract
				</label>
				<textarea
					id="meta-abstract"
					bind:value={metaAbstract}
					placeholder="Paper abstract"
					rows="5"
					class="w-full rounded-md border border-border/60 bg-secondary/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-border focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
				></textarea>
			</div>

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}

			<div class="flex justify-end gap-2 pt-2">
				<Button variant="subtle" onclick={cancelPdfReview} disabled={busy}>Cancel</Button>
				<Button onclick={confirmPdfPaper} disabled={busy}>
					{#if busy}
						<Loader2 class="h-4 w-4 animate-spin" />
					{/if}
					Add paper
				</Button>
			</div>
		</div>
	{:else}
		<div class="space-y-4">
			<div class="space-y-2">
				<div class="flex items-center gap-2 text-xs text-muted-foreground">
					<Link2 class="h-3.5 w-3.5" />
					Arxiv/bioRxiv link, ID, or webpage URL
				</div>
				<div class="flex gap-2">
					<Input
						bind:value={raw}
						placeholder="2604.07209, arxiv.org/abs/…, biorxiv.org/content/…, or https://…"
						class="font-mono text-xs"
						onkeydown={(e: KeyboardEvent) => {
							if (e.key === 'Enter') importFromInput();
						}}
					/>
					<Button onclick={importFromInput} disabled={busy || !raw.trim()}>
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
					<span class="bg-card px-2 text-[10px] uppercase tracking-wider text-muted-foreground"
						>or</span
					>
				</div>
			</div>

			<div
				role="region"
				aria-label="Drop a PDF here"
				class="flex flex-col items-center justify-center rounded-md border border-dashed px-6 py-10 text-sm transition-colors {dragActive
					? 'border-accent bg-accent/5 text-accent'
					: 'border-border/60 text-muted-foreground'}"
				ondragover={(e) => {
					e.preventDefault();
					dragActive = true;
				}}
				ondragleave={() => (dragActive = false)}
				ondrop={handleDrop}
			>
				<Upload class="h-5 w-5" />
				<span class="mt-2 text-xs">Drop a PDF here</span>
				<span class="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
					<Sparkles class="h-3 w-3" />
					AI will extract title, authors, abstract
				</span>
			</div>

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}
		</div>
	{/if}
</Dialog>
