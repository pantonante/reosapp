import type { Paper } from '$lib/types';
import { papers } from '$lib/stores.svelte';
import { INBOX_SLUG, readPaperSummary } from '$lib/tauri/fs';
import {
	cancelJob,
	getJob,
	isRunning,
	startSummary
} from '$lib/stores/summary-jobs.svelte';

const MAX_CONCURRENT = 3;

export interface BulkState {
	running: boolean;
	cancelling: boolean;
	total: number;
	started: number;
	completed: number;
	failed: number;
	cancelled: number;
	activePaperIds: string[];
}

const state = $state<BulkState>({
	running: false,
	cancelling: false,
	total: 0,
	started: 0,
	completed: 0,
	failed: 0,
	cancelled: 0,
	activePaperIds: []
});

let cancelRequested = false;

export function bulkSummaryState(): BulkState {
	return state;
}

async function findPapersWithoutSummary(): Promise<Paper[]> {
	const out: Paper[] = [];
	for (const p of papers.items) {
		if (!p.pdfPath) continue;
		if (isRunning(p.id)) continue;
		const slug = p.threadId ?? INBOX_SLUG;
		const text = await readPaperSummary(slug, p.arxivId);
		if (text === null) out.push(p);
	}
	return out;
}

async function awaitJob(paperId: string): Promise<'completed' | 'error'> {
	// The chat:event listener in summary-jobs.svelte.ts flips status off
	// 'streaming' when the CLI exits; poll until that happens.
	while (true) {
		const job = getJob(paperId);
		if (!job) return 'error';
		if (job.status !== 'streaming') return job.status;
		await new Promise((r) => setTimeout(r, 250));
	}
}

export async function generateAllMissingSummaries(): Promise<void> {
	if (state.running) return;
	cancelRequested = false;
	const queue = await findPapersWithoutSummary();
	state.running = true;
	state.cancelling = false;
	state.total = queue.length;
	state.started = 0;
	state.completed = 0;
	state.failed = 0;
	state.cancelled = 0;
	state.activePaperIds = [];

	if (queue.length === 0) {
		state.running = false;
		return;
	}

	let cursor = 0;
	async function worker() {
		while (cursor < queue.length) {
			if (cancelRequested) return;
			const paper = queue[cursor++];
			state.started++;
			state.activePaperIds = [...state.activePaperIds, paper.id];
			const job = await startSummary(paper);
			if (!job) {
				state.failed++;
				state.activePaperIds = state.activePaperIds.filter((id) => id !== paper.id);
				continue;
			}
			const result = await awaitJob(paper.id);
			state.activePaperIds = state.activePaperIds.filter((id) => id !== paper.id);
			if (result === 'completed') state.completed++;
			else if (cancelRequested) state.cancelled++;
			else state.failed++;
		}
	}

	const workers = Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, () => worker());
	await Promise.all(workers);
	state.running = false;
	state.cancelling = false;
}

export async function cancelBulkSummary(): Promise<void> {
	if (!state.running) return;
	cancelRequested = true;
	state.cancelling = true;
	const ids = [...state.activePaperIds];
	await Promise.all(ids.map((id) => cancelJob(id).catch(() => {})));
}
