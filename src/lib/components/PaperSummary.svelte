<script lang="ts">
	import 'katex/dist/katex.min.css';
	import { Marked } from 'marked';
	import markedKatex from 'marked-katex-extension';
	import { Button } from '$lib/components/ui';
	import type { Paper } from '$lib/types';
	import { INBOX_SLUG, readPaperSummary } from '$lib/tauri/fs';
	import { toolIcon, toolVerb } from '$lib/tauri/stream';
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
	import { onDestroy, onMount } from 'svelte';

	let { paper }: { paper: Paper } = $props();

	const marked = new Marked();
	marked.use(markedKatex({ throwOnError: false, nonStandard: true }));

	let summary = $state<string | null>(null);
	let summaryHtml = $state<string>('');
	let loaded = $state(false);
	let stderrExpanded = $state(true);
	let now = $state(Date.now());

	let lastReloadAt = $state<number>(0);

	const job: SummaryJob | undefined = $derived(getJob(paper.id));
	const streaming = $derived(job?.status === 'streaming');
	const jobError = $derived(job?.status === 'error' ? job : null);

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

	async function load() {
		loaded = false;
		summary = await readPaperSummary(paper.threadId ?? INBOX_SLUG, paper.arxivId);
		summaryHtml = summary ? await marked.parse(summary) : '';
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
		stderrExpanded = true;
		await startSummary(paper);
	}

	async function cancel() {
		await cancelJob(paper.id);
	}

	function dismissError() {
		clearJob(paper.id);
	}

	onMount(() => {
		void load();
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
				<Button size="sm" variant="ghost" onclick={generate} disabled={!paper.pdfPath}>
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
			<Button size="sm" variant="ghost" onclick={generate} disabled={!paper.pdfPath}>
				<RefreshCw class="h-3 w-3" />
				Regenerate
			</Button>
		</div>
		<div class="flex-1 overflow-y-auto p-4">
			<div class="summary-md text-xs leading-relaxed">
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
				No summary yet. Generate a builder-oriented review of this paper.
			</p>
			<Button size="sm" onclick={generate} disabled={!paper.pdfPath}>
				<Sparkles class="h-3.5 w-3.5" />
				Generate summary
			</Button>
			<p class="mt-2 text-[10px] text-muted-foreground">
				Powered by your local <code class="font-mono">claude</code> CLI · uses the
				<code class="font-mono">summarize-paper</code> skill. Multiple papers can summarize in parallel.
			</p>
		</div>
	{/if}
</div>

<style>
	.summary-md :global(h1) {
		font-size: 1rem;
		font-weight: 600;
		margin-top: 0.25rem;
		margin-bottom: 0.5rem;
	}
	.summary-md :global(h2) {
		font-size: 0.85rem;
		font-weight: 600;
		margin-top: 1rem;
		margin-bottom: 0.35rem;
		color: hsl(var(--accent));
	}
	.summary-md :global(h3) {
		font-size: 0.75rem;
		font-weight: 600;
		margin-top: 0.85rem;
		margin-bottom: 0.3rem;
	}
	.summary-md :global(p) {
		margin: 0.4rem 0;
	}
	.summary-md :global(ul),
	.summary-md :global(ol) {
		margin: 0.4rem 0;
		padding-left: 1.1rem;
	}
	.summary-md :global(li) {
		margin: 0.15rem 0;
	}
	.summary-md :global(strong) {
		color: hsl(var(--foreground));
		font-weight: 600;
	}
	.summary-md :global(code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: hsl(var(--muted));
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
		font-size: 0.85em;
	}
	.summary-md :global(pre) {
		background: hsl(var(--muted));
		border: 1px solid hsl(var(--border));
		border-radius: 4px;
		padding: 0.5rem 0.75rem;
		overflow-x: auto;
		margin: 0.5rem 0;
	}
	.summary-md :global(pre code) {
		background: transparent;
		padding: 0;
	}
	.summary-md :global(blockquote) {
		border-left: 2px solid hsl(var(--border));
		padding-left: 0.75rem;
		margin: 0.5rem 0;
		color: hsl(var(--muted-foreground));
	}
	.summary-md :global(table) {
		border-collapse: collapse;
		margin: 0.5rem 0;
		font-size: 0.95em;
	}
	.summary-md :global(th),
	.summary-md :global(td) {
		border: 1px solid hsl(var(--border));
		padding: 0.3rem 0.5rem;
		text-align: left;
	}
	.summary-md :global(th) {
		background: hsl(var(--muted));
		font-weight: 600;
	}
	.summary-md :global(hr) {
		border: 0;
		border-top: 1px solid hsl(var(--border));
		margin: 0.85rem 0;
	}
	.summary-md :global(a) {
		color: hsl(var(--accent));
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>
