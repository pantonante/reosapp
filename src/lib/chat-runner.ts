import type { ChatMessage, ChatModel } from '$lib/types';
import {
	listenChatEvents,
	startChatStream,
	type ChatEvent,
	type ChatStreamArgs
} from '$lib/tauri/chat';
import { collectText, parseStreamEvent, type StreamBlock } from '$lib/tauri/stream';

/**
 * One chat turn against the local `claude` CLI, shared by paper and thread
 * chats.
 *
 * - Streams token deltas, so text shows up as it is generated.
 * - Continues the previous turn's CLI session (`--resume`), so follow-ups keep
 *   context and hit the prompt cache. If that session can't be resumed (e.g.
 *   the paper moved to another thread folder), it retries once from scratch
 *   with the transcript inlined.
 * - Owns its event listener, so the reply is still delivered to `onFinish`
 *   (which persists it) when the component that started it has been
 *   unmounted, e.g. the user navigated to another paper mid-answer.
 */

export interface ChatTurnOptions {
	/** Session id prefix for the backend, e.g. `paper-<id>`. */
	label: string;
	prompt: string;
	/** Messages before this turn (not including `prompt`). */
	history: ChatMessage[];
	workspaceDir: string;
	model: ChatModel;
	system?: string;
	appendSystem?: string;
	/** Attached as `@path` mentions; only sent on a turn that starts a session. */
	pdfPaths?: string[];
	onUpdate: (blocks: StreamBlock[]) => void;
	onFinish: (result: ChatTurnResult) => void | Promise<void>;
}

export interface ChatTurnResult {
	text: string;
	/** CLI session to resume next turn. */
	sessionId: string | null;
	/** Set when the turn produced no answer. */
	error: string | null;
}

const TRANSCRIPT_MAX_CHARS = 60_000;

function lastSessionId(history: ChatMessage[]): string | null {
	for (let i = history.length - 1; i >= 0; i--) {
		const id = history[i].sessionId;
		if (id) return id;
	}
	return null;
}

/** Prompt with prior turns inlined, for chats with no resumable session. */
function withTranscript(history: ChatMessage[], prompt: string): string {
	if (history.length === 0) return prompt;
	let transcript = history
		.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
		.join('\n\n');
	if (transcript.length > TRANSCRIPT_MAX_CHARS) {
		transcript = '…' + transcript.slice(-TRANSCRIPT_MAX_CHARS);
	}
	return `<conversation_so_far>\n${transcript}\n</conversation_so_far>\n\n${prompt}`;
}

interface Accumulator {
	blocks: StreamBlock[];
	/** Text of the block currently being generated, from token deltas. */
	live: string;
	sessionId: string | null;
	resultText: string;
	resultError: string | null;
	stderr: string[];
}

function feed(acc: Accumulator, line: string): boolean {
	let ev: Record<string, unknown>;
	try {
		ev = JSON.parse(line);
	} catch {
		return false;
	}
	if (typeof ev.session_id === 'string' && !acc.sessionId) acc.sessionId = ev.session_id;

	if (ev.type === 'stream_event') {
		// Ignore subagent streams; only the main conversation is shown live.
		if (ev.parent_tool_use_id) return false;
		const e = ev.event as { type?: string; delta?: { type?: string; text?: string } };
		if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
			acc.live += e.delta.text;
			return true;
		}
		return false;
	}
	if (ev.type === 'result') {
		if (typeof ev.session_id === 'string') acc.sessionId = ev.session_id;
		if (typeof ev.result === 'string') acc.resultText = ev.result;
		if (ev.is_error) {
			const errors = Array.isArray(ev.errors) ? (ev.errors as unknown[]).map(String) : [];
			acc.resultError = errors.join('\n') || (typeof ev.result === 'string' ? ev.result : 'error');
		}
		return false;
	}
	const blocks = parseStreamEvent(line);
	if (blocks.length === 0) return false;
	// A completed text block supersedes the deltas that built it.
	if (blocks.some((b) => b.kind === 'text')) acc.live = '';
	acc.blocks = [...acc.blocks, ...blocks];
	return true;
}

function view(acc: Accumulator): StreamBlock[] {
	return acc.live ? [...acc.blocks, { kind: 'text', text: acc.live }] : acc.blocks;
}

export function runChatTurn(opts: ChatTurnOptions): void {
	const resume = lastSessionId(opts.history);
	void attempt(opts, resume, false);
}

async function attempt(opts: ChatTurnOptions, resume: string | null, isRetry: boolean) {
	const sessionId = `${opts.label}-${Date.now()}`;
	const acc: Accumulator = {
		blocks: [],
		live: '',
		sessionId: null,
		resultText: '',
		resultError: null,
		stderr: []
	};
	opts.onUpdate([]);

	// Coalesce token deltas into one UI update per frame.
	let frame = 0;
	const schedule = () => {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			opts.onUpdate(view(acc));
		});
	};

	let finished = false;
	const unlisten = await listenChatEvents(sessionId, (event: ChatEvent) => {
		if (finished) return;
		if (event.type === 'stdout') {
			if (feed(acc, event.line)) schedule();
		} else if (event.type === 'stderr') {
			if (event.line.trim()) acc.stderr.push(event.line.trim());
		} else if (event.type === 'done' || event.type === 'error') {
			finished = true;
			if (frame) cancelAnimationFrame(frame);
			unlisten();
			const text = collectText(acc.blocks) || acc.live.trim() || acc.resultText.trim();
			if (!text && resume && !isRetry) {
				// Most likely the session couldn't be resumed. Start over with the
				// transcript inlined rather than failing the turn.
				console.warn('[chat] resume failed, retrying fresh:', acc.resultError ?? acc.stderr);
				void attempt(opts, null, true);
				return;
			}
			let error: string | null = null;
			if (!text) {
				error =
					event.type === 'error'
						? event.message
						: acc.resultError ||
							acc.stderr.slice(-5).join('\n') ||
							`claude exited with code ${event.code} without replying`;
			}
			void opts.onFinish({ text, sessionId: acc.sessionId, error });
		}
	});

	const fresh = !resume;
	const args: ChatStreamArgs = {
		sessionId,
		prompt: fresh ? withTranscript(opts.history, opts.prompt) : opts.prompt,
		pdfPaths: fresh ? (opts.pdfPaths ?? []) : [],
		system: opts.system,
		appendSystem: opts.appendSystem,
		workspaceDir: opts.workspaceDir,
		model: opts.model,
		resume: resume ?? undefined,
		partial: true
	};
	try {
		await startChatStream(args);
	} catch (e) {
		// The backend also emits an `error` event for spawn failures; this
		// covers invoke-level failures that never reach it.
		if (!finished) {
			finished = true;
			unlisten();
			void opts.onFinish({
				text: '',
				sessionId: null,
				error: e instanceof Error ? e.message : String(e)
			});
		}
	}
}
