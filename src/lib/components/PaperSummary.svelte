<script lang="ts">
	import 'katex/dist/katex.min.css';
	import DOMPurify from 'dompurify';
	import { Marked } from 'marked';
	import markedKatex from 'marked-katex-extension';
	import { Button } from '$lib/components/ui';
	import type { Paper } from '$lib/types';
	import {
		INBOX_SLUG,
		readPaperSummary,
		readPaperSummaryAsset,
		writePaperSummary,
		writePaperSummaryAsset
	} from '$lib/tauri/fs';
	import { toolIcon, toolVerb } from '$lib/tauri/stream';
	import { parseSummaryFrontmatter, isMetaEmpty } from '$lib/summary-meta';
	import {
		cancelJob,
		clearJob,
		getJob,
		startSummary,
		type SummaryJob
	} from '$lib/stores/summary-jobs.svelte';
	import {
		Loader2,
		Sparkles,
		RefreshCw,
		AlertCircle,
		ChevronDown,
		ChevronRight,
		X
	} from 'lucide-svelte';
	import { Download, KeyRound } from 'lucide-svelte';
	import { onDestroy, onMount } from 'svelte';
	import { ask } from '@tauri-apps/plugin-dialog';
	import { goto } from '$app/navigation';
	import { summaryMeta } from '$lib/stores.svelte';
	import { cn } from '$lib/utils/cn';
	import {
		decodeBase64,
		fetchAlphaXivImage,
		getAlphaXivCredentialStatus,
		getAlphaXivPaperContent,
		imageExtension
	} from '$lib/tauri/alphaxiv';

	let { paper }: { paper: Paper } = $props();

	const marked = new Marked();
	marked.use(markedKatex({ throwOnError: false, nonStandard: true }));

	let summary = $state<string | null>(null);
	let summaryHtml = $state<string>('');
	let summaryFrontmatter = $state<{ topics: string[]; domains: string[]; keywords: string[] } | null>(null);
	let loaded = $state(false);
	let stderrExpanded = $state(true);
	let now = $state(Date.now());
	let alphaXivConfigured = $state(false);
	let alphaXivImporting = $state(false);
	let alphaXivError = $state<string | null>(null);
	let alphaXivMessage = $state<string | null>(null);

	let lastReloadAt = $state<number>(0);

	const job: SummaryJob | undefined = $derived(getJob(paper.id));
	const streaming = $derived(job?.status === 'streaming');
	const jobError = $derived(job?.status === 'error' ? job : null);
	const canSummarize = $derived(!!paper.pdfPath || !!paper.sourceUrl);
	const isWebpage = $derived(!paper.pdfPath && !!paper.sourceUrl);
	const isArxivPaper = $derived(/^\d{4}\.\d{4,5}$/.test(paper.arxivId));

	let tickInterval: ReturnType<typeof setInterval> | null = null;
	$effect(() => {
		if (streaming && tickInterval == null) {
			tickInterval = setInterval(() => {
				now = Date.now();
			}, 1000);
		} else if (!streaming && tickInterval != null) {
			clearInterval(tickInterval);
			tickInterval = null;
		}
	});

	onDestroy(() => {
		if (tickInterval != null) clearInterval(tickInterval);
	});

	function mimeForFileName(fileName: string): string {
		const extension = fileName.split('.').pop()?.toLowerCase();
		switch (extension) {
			case 'jpg':
			case 'jpeg':
				return 'image/jpeg';
			case 'webp':
				return 'image/webp';
			case 'gif':
				return 'image/gif';
			default:
				return 'image/png';
		}
	}

	function bytesToDataUrl(bytes: Uint8Array, mimeType: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const copy = new Uint8Array(bytes.byteLength);
			copy.set(bytes);
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(reader.error ?? new Error('Could not read summary image'));
			reader.readAsDataURL(new Blob([copy.buffer], { type: mimeType }));
		});
	}

	async function inlineLocalImages(body: string): Promise<string> {
		const matches = [...body.matchAll(/summary-assets\/([a-zA-Z0-9][a-zA-Z0-9._-]*)/g)];
		const fileNames = [...new Set(matches.map((match) => match[1]))];
		let rendered = body;
		for (const fileName of fileNames) {
			try {
				const bytes = await readPaperSummaryAsset(
					paper.threadId ?? INBOX_SLUG,
					paper.arxivId,
					fileName
				);
				const dataUrl = await bytesToDataUrl(bytes, mimeForFileName(fileName));
				rendered = rendered.split(`summary-assets/${fileName}`).join(dataUrl);
			} catch (e) {
				console.warn(`[summary] could not load local asset ${fileName}`, e);
			}
		}
		return rendered;
	}

	async function renderBody(body: string): Promise<string> {
		const withLocalImages = await inlineLocalImages(body);
		const html = await marked.parse(withLocalImages);
		return DOMPurify.sanitize(html, {
			USE_PROFILES: { html: true },
			ADD_DATA_URI_TAGS: ['img']
		});
	}

	async function load() {
		loaded = false;
		summary = await readPaperSummary(paper.threadId ?? INBOX_SLUG, paper.arxivId);
		if (summary) {
			const { meta, body } = parseSummaryFrontmatter(summary);
			summaryFrontmatter = isMetaEmpty(meta) ? null : meta;
			summaryHtml = await renderBody(body);
		} else {
			summaryFrontmatter = null;
			summaryHtml = '';
		}
		loaded = true;
	}

	$effect(() => {
		if (paper.id) {
			lastReloadAt = 0;
			void load();
		}
	});

	$effect(() => {
		const j = getJob(paper.id);
		if (j && j.status === 'completed' && j.finishedAt && j.finishedAt > lastReloadAt) {
			lastReloadAt = j.finishedAt;
			void load();
		}
	});

	async function generate() {
		alphaXivError = null;
		alphaXivMessage = null;
		stderrExpanded = true;
		await startSummary(paper);
	}

	async function importAlphaXiv() {
		if (!alphaXivConfigured) {
			await goto('/settings');
			return;
		}
		if (summary) {
			const ok = await ask(
				'Replace the current summary with AlphaXiv’s report? The existing summary will be overwritten.',
				{ title: 'Import AlphaXiv report', kind: 'warning', okLabel: 'Replace', cancelLabel: 'Cancel' }
			);
			if (!ok) return;
		}
		alphaXivImporting = true;
		alphaXivError = null;
		alphaXivMessage = null;
		try {
			const sourceUrl = `https://www.alphaxiv.org/abs/${paper.arxivId}`;
			const result = await getAlphaXivPaperContent(sourceUrl);
			const slug = paper.threadId ?? INBOX_SLUG;
			const preservedMeta = summary ? parseSummaryFrontmatter(summary).meta : null;
			let markdown = result.markdown.trim();
			let imageCount = 0;
			let failedImageCount = 0;

			for (const image of result.images) {
				await writePaperSummaryAsset(slug, paper.arxivId, image.fileName, decodeBase64(image.data));
				imageCount++;
			}

			// The MCP report is often text-only. Merge any URLs it contains with the
			// bounded set of overview figure URLs discovered by the Rust command.
			const remotePattern = /https:\/\/paper-assets\.alphaxiv\.org\/[^\s)"']+/g;
			const remoteUrls = [
				...new Set([...result.imageUrls, ...(markdown.match(remotePattern) ?? [])])
			].slice(0, 24);
			for (const [index, url] of remoteUrls.entries()) {
				try {
					const image = await fetchAlphaXivImage(url);
					const fileName = `alphaxiv-remote-${String(index + 1).padStart(2, '0')}.${imageExtension(image.mimeType)}`;
					await writePaperSummaryAsset(slug, paper.arxivId, fileName, decodeBase64(image.data));
					if (markdown.includes(url)) {
						markdown = markdown.split(url).join(`summary-assets/${fileName}`);
					} else {
						markdown += `\n\n![AlphaXiv overview figure ${index + 1}](summary-assets/${fileName})`;
					}
					imageCount++;
				} catch (error) {
					failedImageCount++;
					console.warn(`[alphaxiv] could not import overview image ${index + 1}`, error);
				}
			}

			const importedAt = new Date().toISOString();
			const topics = preservedMeta?.topics ?? [];
			const domains = preservedMeta?.domains ?? [];
			const keywords = preservedMeta?.keywords ?? [];
			const document = `---\ntopics: ${JSON.stringify(topics)}\ndomains: ${JSON.stringify(domains)}\nkeywords: ${JSON.stringify(keywords)}\nsummary-source: alphaxiv\nsummary-source-url: ${sourceUrl}\nsummary-imported-at: ${importedAt}\n---\n\n> Imported from [AlphaXiv](${sourceUrl}) on ${importedAt.slice(0, 10)}.\n\n${markdown}\n`;
			await writePaperSummary(slug, paper.arxivId, document);
			if (isMetaEmpty(preservedMeta)) {
				if (summaryMeta.has(paper.id)) await summaryMeta.remove(paper.id);
			} else {
				await summaryMeta.set({
					paperId: paper.id,
					topics,
					domains,
					keywords,
					updatedAt: importedAt
				});
			}
			await load();
			const imageResult = imageCount
				? ` with ${imageCount} image${imageCount === 1 ? '' : 's'}`
				: '';
			const imageProblem = failedImageCount
				? ` ${failedImageCount} image${failedImageCount === 1 ? '' : 's'} could not be downloaded.`
				: result.imageWarning
					? ` ${result.imageWarning}`
					: '';
			alphaXivMessage = `AlphaXiv report imported${imageResult}.${imageProblem}`;
		} catch (e) {
			alphaXivError = e instanceof Error ? e.message : String(e);
		} finally {
			alphaXivImporting = false;
		}
	}

	async function cancel() {
		await cancelJob(paper.id);
	}

	function dismissError() {
		clearJob(paper.id);
	}

	onMount(async () => {
		void load();
		try {
			alphaXivConfigured = (await getAlphaXivCredentialStatus()).configured;
		} catch {
			alphaXivConfigured = false;
		}
	});
</script>

<div class="flex h-full flex-col">
	{#if !loaded && !streaming && !jobError}
		<div class="flex flex-1 items-center justify-center text-xs text-muted-foreground">
			<Loader2 class="mr-2 h-3 w-3 animate-spin" />
			Loading…
		</div>
	{:else if streaming && job}
		<div class="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
			<span class="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-accent">
				<Loader2 class="h-3 w-3 animate-spin" />
				summarizing · {Math.floor((now - job.startedAt) / 1000)}s
			</span>
			<Button size="sm" variant="ghost" onclick={cancel}>
				<X class="h-3 w-3" />
				Cancel
			</Button>
		</div>
		<div class="flex-1 overflow-y-auto p-3">
			<div class="space-y-1.5 text-xs leading-relaxed">
				{#each job.blocks as block, i (i)}
					{#if block.kind === 'text'}
						<div class="whitespace-pre-wrap">{block.text}</div>
					{:else if block.kind === 'thinking'}
						<div class="inline-flex items-center gap-1.5 text-[10px] italic text-muted-foreground/70">
							<Loader2 class="h-3 w-3 animate-spin" />
							thinking…
						</div>
					{:else if block.kind === 'tool_result'}
						<div
							class="ml-4 font-mono text-[10px] {block.isError
								? 'text-destructive'
								: 'text-muted-foreground/70'}"
						>
							↳ {block.result}
						</div>
					{:else}
						{@const Icon = toolIcon(block.tool)}
						<div
							class="inline-flex items-center gap-1.5 rounded border border-border/50 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
						>
							<Icon class="h-3 w-3" />
							<span>{toolVerb(block.tool)}</span>
							{#if block.summary}
								<span class="text-foreground/80">{block.summary}</span>
							{/if}
						</div>
					{/if}
				{/each}
				{#if job.blocks.length === 0}
					{@const waited = Math.floor((now - job.startedAt) / 1000)}
					{#if waited < 30}
						<div class="text-muted-foreground">Waiting for first response from claude…</div>
					{:else if job.stderr.length === 0}
						<div class="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-amber-700 dark:text-amber-400">
							<div class="font-medium">No output from <code class="font-mono">claude</code> in {waited}s.</div>
							<div class="mt-1 text-muted-foreground">
								The CLI was spawned but isn't producing any stdout or stderr. Most common
								causes: (1) <code class="font-mono">claude login</code> session expired or never set up — run <code class="font-mono">claude</code> in a terminal once to confirm; (2) a one-time
								consent / setup prompt is blocking; (3) network hang on initial auth check. Check the terminal where
								<code class="font-mono">npm run tauri dev</code> is running for
								<code class="font-mono">[chat_stream:…]</code> diagnostic logs.
							</div>
						</div>
					{:else}
						<div class="text-muted-foreground">
							Claude is producing stderr but no model output yet ({waited}s). Skill loading or first-token latency.
						</div>
					{/if}
				{/if}
			</div>

			<div class="mt-4 rounded border border-border/40 bg-muted/40">
				<button
					class="flex w-full items-center gap-1 px-2 py-1 text-left text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
					onclick={() => (stderrExpanded = !stderrExpanded)}
				>
					{#if stderrExpanded}
						<ChevronDown class="h-3 w-3" />
					{:else}
						<ChevronRight class="h-3 w-3" />
					{/if}
					stderr ({job.stderr.length})
				</button>
				{#if stderrExpanded}
					{#if job.stderr.length > 0}
						<pre
							class="max-h-40 overflow-auto whitespace-pre-wrap break-words border-t border-border/40 px-2 py-1 font-mono text-[10px] text-muted-foreground">{job.stderr.join('\n')}</pre>
					{:else}
						<div
							class="border-t border-border/40 px-2 py-1 text-[10px] text-muted-foreground"
						>
							(no stderr yet)
						</div>
					{/if}
				{/if}
			</div>
		</div>
	{:else if jobError}
		<div class="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
			<span class="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-destructive">
				<AlertCircle class="h-3 w-3" />
				summary failed{jobError.exitCode !== null ? ` (exit ${jobError.exitCode})` : ''}
			</span>
			<div class="flex gap-1">
				<Button size="sm" variant="ghost" onclick={dismissError}>Dismiss</Button>
				<Button size="sm" variant="ghost" onclick={generate} disabled={!canSummarize}>
					<RefreshCw class="h-3 w-3" />
					Retry
				</Button>
			</div>
		</div>
		<div class="flex-1 overflow-y-auto p-3 text-xs">
			{#if jobError.error}
				<div
					class="rounded border border-destructive/40 bg-destructive/5 p-2 font-mono text-[11px] text-destructive"
				>
					<pre class="whitespace-pre-wrap break-words">{jobError.error}</pre>
				</div>
			{/if}
			{#if jobError.blocks.length > 0}
				<div class="mt-3 space-y-1.5">
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
						Partial output
					</div>
					{#each jobError.blocks as block, i (i)}
						{#if block.kind === 'text'}
							<div class="whitespace-pre-wrap text-muted-foreground">{block.text}</div>
						{:else if block.kind === 'thinking'}
							<div class="text-[10px] italic text-muted-foreground/70">thinking…</div>
						{:else if block.kind === 'tool_result'}
							<div
								class="ml-4 font-mono text-[10px] {block.isError
									? 'text-destructive'
									: 'text-muted-foreground/70'}"
							>
								↳ {block.result}
							</div>
						{:else}
							{@const Icon = toolIcon(block.tool)}
							<div
								class="inline-flex items-center gap-1.5 rounded border border-border/50 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
							>
								<Icon class="h-3 w-3" />
								<span>{toolVerb(block.tool)}</span>
								{#if block.summary}<span class="text-foreground/80">{block.summary}</span>{/if}
							</div>
						{/if}
					{/each}
				</div>
			{/if}
			{#if jobError.stderr.length > 0}
				<div class="mt-3 rounded border border-border/40 bg-muted/40">
					<div class="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
						stderr
					</div>
					<pre
						class="max-h-60 overflow-auto whitespace-pre-wrap break-words border-t border-border/40 px-2 py-1 font-mono text-[10px] text-muted-foreground">{jobError.stderr.join('\n')}</pre>
				</div>
			{/if}
		</div>
	{:else if summary}
		<div class="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
			<span class="text-[10px] uppercase tracking-wider text-muted-foreground">Summary</span>
			<div class="flex items-center gap-1">
				{#if isArxivPaper}
					<Button size="sm" variant="ghost" onclick={importAlphaXiv} disabled={alphaXivImporting}>
						{#if alphaXivImporting}<Loader2 class="h-3 w-3 animate-spin" />{:else}<Download class="h-3 w-3" />{/if}
						AlphaXiv
					</Button>
				{/if}
				<Button size="sm" variant="ghost" onclick={generate} disabled={!canSummarize || alphaXivImporting}>
					<RefreshCw class="h-3 w-3" />
					Regenerate
				</Button>
			</div>
		</div>
		{#if alphaXivError || alphaXivMessage}
			<div class={cn('border-b border-border/60 px-3 py-2 text-xs', alphaXivError ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400')}>
				{alphaXivError ?? alphaXivMessage}
			</div>
		{/if}
		<div class="flex-1 overflow-y-auto px-6 py-8 sm:px-10">
			<div class="summary-md mx-auto">
				{#if summaryFrontmatter}
					<div class="summary-meta mb-6 space-y-2">
						{#if summaryFrontmatter.topics.length}
							<div class="flex flex-wrap items-baseline gap-1.5">
								<span class="meta-label">Topics</span>
								{#each summaryFrontmatter.topics as t (t)}
									<span class="chip chip-topic">{t}</span>
								{/each}
							</div>
						{/if}
						{#if summaryFrontmatter.domains.length}
							<div class="flex flex-wrap items-baseline gap-1.5">
								<span class="meta-label">Domains</span>
								{#each summaryFrontmatter.domains as d (d)}
									<span class="chip chip-domain">{d}</span>
								{/each}
							</div>
						{/if}
						{#if summaryFrontmatter.keywords.length}
							<div class="flex flex-wrap items-baseline gap-1.5">
								<span class="meta-label">Keywords</span>
								{#each summaryFrontmatter.keywords as k (k)}
									<span class="chip chip-keyword">{k}</span>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
				{@html summaryHtml}
			</div>
		</div>
	{:else}
		<div
			class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
			data-testid="summary-empty"
		>
			<Sparkles class="h-6 w-6 text-muted-foreground" />
			<p class="text-xs text-muted-foreground">
				{#if isWebpage}
					No summary yet. Generate a builder-oriented review of this webpage.
				{:else}
					No summary yet. Generate a builder-oriented review of this paper.
				{/if}
			</p>
			<div class="flex flex-wrap justify-center gap-2">
				{#if isArxivPaper}
					<Button size="sm" variant="outline" onclick={importAlphaXiv} disabled={alphaXivImporting}>
						{#if alphaXivImporting}
							<Loader2 class="h-3.5 w-3.5 animate-spin" />
						{:else if alphaXivConfigured}
							<Download class="h-3.5 w-3.5" />
						{:else}
							<KeyRound class="h-3.5 w-3.5" />
						{/if}
						{alphaXivConfigured ? 'Import from AlphaXiv' : 'Set AlphaXiv key'}
					</Button>
				{/if}
				<Button size="sm" onclick={generate} disabled={!canSummarize || alphaXivImporting}>
					<Sparkles class="h-3.5 w-3.5" />
					Generate summary
				</Button>
			</div>
			{#if alphaXivError}
				<p class="max-w-md text-xs text-destructive">{alphaXivError}</p>
			{/if}
			<p class="mt-2 text-[10px] text-muted-foreground">
				{#if isWebpage}
					Powered by your local <code class="font-mono">claude</code> CLI · fetches the page live via WebFetch.
				{:else}
					Powered by your local <code class="font-mono">claude</code> CLI · uses the
					<code class="font-mono">summarize-paper</code> skill. Multiple papers can summarize in parallel.
				{/if}
			</p>
		</div>
	{/if}
</div>

<style>
	/* Reading-optimized typography for paper summaries with inline LaTeX.
	   A book-style serif pairs naturally with KaTeX (Computer Modern roots),
	   so prose and math share a consistent texture. */
	.summary-md {
		font-family: 'Charter', 'Iowan Old Style', 'Source Serif 4',
			'Source Serif Pro', 'Palatino Linotype', 'Book Antiqua', Palatino,
			Georgia, serif;
		font-size: 15.5px;
		line-height: 1.7;
		letter-spacing: 0.005em;
		color: hsl(var(--foreground) / 0.92);
		font-feature-settings: 'kern', 'liga', 'clig', 'calt', 'onum';
		text-rendering: optimizeLegibility;
		-webkit-font-smoothing: antialiased;
		/* Container fills the scroll area; the 68ch reading limit is applied to
		   prose children individually so tables can use the full width. */
		width: 100%;
		hyphens: auto;
	}

	.summary-md :global(h1) {
		font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Inter',
			system-ui, sans-serif;
		font-size: 1.5rem;
		font-weight: 600;
		line-height: 1.25;
		letter-spacing: -0.01em;
		color: hsl(var(--foreground));
		margin-top: 0.25rem;
		margin-bottom: 0.9rem;
	}
	.summary-md :global(h2) {
		font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Inter',
			system-ui, sans-serif;
		font-size: 1.05rem;
		font-weight: 600;
		line-height: 1.3;
		letter-spacing: 0.01em;
		text-transform: uppercase;
		color: hsl(var(--accent));
		margin-top: 2rem;
		margin-bottom: 0.6rem;
		padding-bottom: 0.3rem;
		border-bottom: 1px solid hsl(var(--border) / 0.7);
	}
	.summary-md :global(h3) {
		font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Inter',
			system-ui, sans-serif;
		font-size: 0.95rem;
		font-weight: 600;
		line-height: 1.35;
		color: hsl(var(--foreground));
		margin-top: 1.4rem;
		margin-bottom: 0.45rem;
	}
	.summary-md :global(h4) {
		font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Inter',
			system-ui, sans-serif;
		font-size: 0.85rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: hsl(var(--muted-foreground));
		margin-top: 1.1rem;
		margin-bottom: 0.35rem;
	}
	.summary-md :global(p) {
		margin: 0.85rem 0;
	}
	.summary-md :global(ul) {
		margin: 0.85rem 0;
		padding-left: 1.5rem;
		list-style-type: disc;
	}
	.summary-md :global(ul ul) {
		list-style-type: circle;
	}
	.summary-md :global(ul ul ul) {
		list-style-type: square;
	}
	.summary-md :global(ol) {
		margin: 0.85rem 0;
		padding-left: 1.75rem;
		list-style-type: decimal;
	}
	.summary-md :global(li) {
		margin: 0.35rem 0;
		padding-left: 0.15rem;
	}
	.summary-md :global(li > p) {
		margin: 0.25rem 0;
	}
	.summary-md :global(li::marker) {
		color: hsl(var(--muted-foreground));
	}
	.summary-md :global(strong) {
		color: hsl(var(--foreground));
		font-weight: 600;
	}
	.summary-md :global(em) {
		font-style: italic;
	}
	.summary-md :global(code) {
		font-family: 'JetBrains Mono', 'SF Mono', ui-monospace, SFMono-Regular,
			Menlo, Consolas, monospace;
		background: hsl(var(--muted) / 0.7);
		padding: 0.08em 0.35em;
		border-radius: 3px;
		font-size: 0.85em;
		font-feature-settings: normal;
	}
	.summary-md :global(pre) {
		background: hsl(var(--muted) / 0.6);
		border: 1px solid hsl(var(--border));
		border-radius: 6px;
		padding: 0.85rem 1rem;
		overflow-x: auto;
		margin: 1rem 0;
		line-height: 1.55;
	}
	.summary-md :global(pre code) {
		background: transparent;
		padding: 0;
		font-size: 0.85em;
	}
	.summary-md :global(blockquote) {
		border-left: 3px solid hsl(var(--accent) / 0.6);
		padding: 0.1rem 0 0.1rem 1rem;
		margin: 1rem 0;
		color: hsl(var(--muted-foreground));
		font-style: italic;
	}
	.summary-md :global(table) {
		/* Tables span the full container width (with the parent scroll area's
		   px-10 already supplying the small margin from the panel edges). */
		border-collapse: collapse;
		margin: 1.25rem 0;
		font-size: 0.95em;
		width: 100%;
	}
	.summary-md :global(th),
	.summary-md :global(td) {
		border: 1px solid hsl(var(--border));
		padding: 0.45rem 0.65rem;
		text-align: left;
		vertical-align: top;
	}
	.summary-md :global(th) {
		background: hsl(var(--muted) / 0.7);
		font-weight: 600;
		font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Inter',
			system-ui, sans-serif;
		font-size: 0.9em;
	}
	.summary-md :global(hr) {
		border: 0;
		border-top: 1px solid hsl(var(--border));
		margin: 1.5rem 0;
	}
	.summary-md :global(a) {
		color: hsl(var(--accent));
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 3px;
	}
	.summary-md :global(a:hover) {
		text-decoration-thickness: 2px;
	}
	.summary-md :global(img) {
		display: block;
		max-width: min(100%, 960px);
		height: auto;
		margin: 1.5rem auto 0.65rem;
		border: 1px solid hsl(var(--border) / 0.8);
		border-radius: 10px;
		background: white;
		box-shadow: 0 10px 28px -18px hsl(var(--shadow-color) / 0.7);
	}

	/* Constrain prose to a comfortable reading width while letting tables span
	   the full container. Placed after the per-element rules so margin-inline
	   wins over their `margin: x 0` shorthand. */
	.summary-md :global(h1),
	.summary-md :global(h2),
	.summary-md :global(h3),
	.summary-md :global(h4),
	.summary-md :global(p),
	.summary-md :global(ul),
	.summary-md :global(ol),
	.summary-md :global(blockquote),
	.summary-md :global(pre),
	.summary-md :global(hr),
	.summary-md > .summary-meta {
		max-width: 68ch;
		margin-inline: auto;
	}

	.summary-meta :global(.meta-label) {
		font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Inter',
			system-ui, sans-serif;
		font-size: 0.65rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: hsl(var(--muted-foreground));
		margin-right: 0.15rem;
		min-width: 4.5rem;
	}
	.summary-meta :global(.chip) {
		font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Inter',
			system-ui, sans-serif;
		font-size: 0.7rem;
		line-height: 1;
		padding: 0.22rem 0.5rem;
		border-radius: 999px;
		border: 1px solid hsl(var(--border));
		background: hsl(var(--muted) / 0.4);
		color: hsl(var(--foreground) / 0.85);
		white-space: nowrap;
	}
	.summary-meta :global(.chip-topic) {
		background: hsl(var(--accent) / 0.12);
		border-color: hsl(var(--accent) / 0.4);
		color: hsl(var(--accent));
		font-weight: 500;
	}
	.summary-meta :global(.chip-domain) {
		background: hsl(var(--muted) / 0.6);
		font-weight: 500;
	}
	.summary-meta :global(.chip-keyword) {
		background: transparent;
		color: hsl(var(--muted-foreground));
	}

	/* KaTeX: give display math room to breathe and align it visually with prose. */
	.summary-md :global(.katex) {
		font-size: 1.02em;
	}
	.summary-md :global(.katex-display) {
		margin: 1.1rem 0;
		padding: 0.25rem 0;
		overflow-x: auto;
		overflow-y: hidden;
	}
	.summary-md :global(.katex-display > .katex) {
		font-size: 1.05em;
	}
</style>
