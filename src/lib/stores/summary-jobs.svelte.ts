import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import type { Paper } from '$lib/types';
import { INBOX_SLUG, paperDir, readPaperSummary } from '$lib/tauri/fs';
import type { ChatEvent, ChatStreamArgs } from '$lib/tauri/chat';
import { parseStreamEvent, type StreamBlock } from '$lib/tauri/stream';
import { parseSummaryFrontmatter, isMetaEmpty } from '$lib/summary-meta';
import { summaryMeta } from '$lib/stores.svelte';

export type JobStatus = 'streaming' | 'completed' | 'error';

export interface SummaryJob {
	paperId: string;
	sessionId: string;
	status: JobStatus;
	blocks: StreamBlock[];
	stderr: string[];
	exitCode: number | null;
	error: string | null;
	startedAt: number;
	finishedAt: number | null;
}

const jobs = $state<Record<string, SummaryJob>>({});
const sessionToPaper = new Map<string, string>();
const sessionToPaperRef = new Map<string, Paper>();

let listenerInstalled = false;
let unlistenAll: UnlistenFn | null = null;
let listenerPromise: Promise<void> | null = null;

async function ensureListener(): Promise<void> {
	if (listenerInstalled) return;
	if (listenerPromise) return listenerPromise;
	listenerPromise = (async () => {
		unlistenAll = await listen<ChatEvent>('chat:event', ({ payload }) => {
			const paperId = sessionToPaper.get(payload.sessionId);
			console.log('[summary-jobs] event', payload.type, payload.sessionId, '→ paperId=', paperId);
			if (!paperId) return;
			const job = jobs[paperId];
			if (!job || job.sessionId !== payload.sessionId) return;
			handleEvent(job, payload);
		});
		listenerInstalled = true;
	})();
	return listenerPromise;
}

function handleEvent(job: SummaryJob, event: ChatEvent) {
	if (event.type === 'stdout') {
		const blocks = parseStreamEvent(event.line);
		if (blocks.length) job.blocks = [...job.blocks, ...blocks];
	} else if (event.type === 'stderr') {
		// Accumulate raw stderr for diagnostics. The CLI mostly logs progress
		// here, but errors land here too.
		const trimmed = event.line.trim();
		if (trimmed) job.stderr = [...job.stderr, trimmed];
	} else if (event.type === 'done') {
		job.exitCode = event.code;
		job.finishedAt = Date.now();
		if (event.code === 0) {
			job.status = 'completed';
			const paper = sessionToPaperRef.get(job.sessionId);
			if (paper) void persistMetaFromSummary(paper);
		} else {
			job.status = 'error';
			job.error =
				job.stderr.length > 0
					? job.stderr.join('\n')
					: `claude CLI exited with code ${event.code}`;
		}
		sessionToPaper.delete(job.sessionId);
		sessionToPaperRef.delete(job.sessionId);
	} else if (event.type === 'error') {
		job.status = 'error';
		job.error = event.message;
		job.finishedAt = Date.now();
		sessionToPaper.delete(job.sessionId);
		sessionToPaperRef.delete(job.sessionId);
	}
}

async function persistMetaFromSummary(paper: Paper): Promise<void> {
	try {
		const text = await readPaperSummary(paper.threadId ?? INBOX_SLUG, paper.arxivId);
		if (!text) return;
		const { meta } = parseSummaryFrontmatter(text);
		if (isMetaEmpty(meta)) {
			// Either no frontmatter or empty arrays. Drop any stale cached row so
			// the paper doesn't keep showing up on the graph with old data.
			await summaryMeta.remove(paper.id);
			return;
		}
		await summaryMeta.set({
			paperId: paper.id,
			topics: meta!.topics,
			domains: meta!.domains,
			keywords: meta!.keywords,
			updatedAt: new Date().toISOString()
		});
	} catch (e) {
		console.warn('[summary-jobs] failed to persist summary meta', e);
	}
}

export function getJob(paperId: string): SummaryJob | undefined {
	return jobs[paperId];
}

export function isRunning(paperId: string): boolean {
	return jobs[paperId]?.status === 'streaming';
}

export function clearJob(paperId: string): void {
	const job = jobs[paperId];
	if (job) {
		sessionToPaper.delete(job.sessionId);
		sessionToPaperRef.delete(job.sessionId);
	}
	delete jobs[paperId];
}

export async function cancelJob(paperId: string): Promise<void> {
	const job = jobs[paperId];
	if (!job || job.status !== 'streaming') return;
	try {
		await invoke('chat_cancel', { sessionId: job.sessionId });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		job.error = `Failed to cancel: ${msg}`;
	}
	// Mark as cancelled immediately so the UI updates; the eventual `done`
	// event from the killed subprocess is harmless (we ignore it because the
	// session_id will already have been removed from sessionToPaper below).
	job.status = 'error';
	job.error = job.error ?? 'Cancelled by user';
	job.finishedAt = Date.now();
	sessionToPaper.delete(job.sessionId);
	sessionToPaperRef.delete(job.sessionId);
}

export async function startSummary(paper: Paper): Promise<SummaryJob | null> {
	if (!paper.pdfPath) return null;
	if (isRunning(paper.id)) return jobs[paper.id];

	await ensureListener();

	const sessionId = `summarize-${paper.id}-${Date.now()}`;
	jobs[paper.id] = {
		paperId: paper.id,
		sessionId,
		status: 'streaming',
		blocks: [],
		stderr: [],
		exitCode: null,
		error: null,
		startedAt: Date.now(),
		finishedAt: null
	};
	sessionToPaper.set(sessionId, paper.id);
	sessionToPaperRef.set(sessionId, paper);

	// CWD is the paper folder itself, so `paper.pdf` and `summary.md` are just
	// filenames in CWD. The `summarize-paper` skill (auto-loaded via
	// `--add-dir` from the bundled `reos-skills/`) takes care of the rest —
	// the prompt below is a plain trigger that matches the skill's
	// frontmatter description.
	const workspaceDir = await paperDir(paper.threadId ?? INBOX_SLUG, paper.arxivId);
	const prompt = 'Summarize this paper.';

	const args: ChatStreamArgs = {
		sessionId,
		prompt,
		pdfPaths: [],
		workspaceDir
	};

	try {
		await invoke('chat_stream', { args });
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		const job = jobs[paper.id];
		if (job && job.sessionId === sessionId) {
			job.status = 'error';
			job.error = `Failed to start claude CLI: ${msg}`;
			job.finishedAt = Date.now();
			sessionToPaper.delete(sessionId);
			sessionToPaperRef.delete(sessionId);
		}
	}

	return jobs[paper.id];
}
