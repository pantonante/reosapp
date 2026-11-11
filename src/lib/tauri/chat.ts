import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ChatModel } from '$lib/types';

export type ChatEvent =
	| { type: 'stdout'; sessionId: string; line: string }
	| { type: 'stderr'; sessionId: string; line: string }
	| { type: 'done'; sessionId: string; code: number }
	| { type: 'error'; sessionId: string; message: string };

export interface ChatStreamArgs {
	sessionId: string;
	prompt: string;
	pdfPaths: string[];
	system?: string;
	/** Absolute path to the thread folder; used as CWD for the `claude` subprocess. */
	workspaceDir: string;
	/** Optional absolute path to `<papersRoot>/_reos`. Exposed to the agent via a
	 * second `--add-dir` so skills can read shared resources like
	 * `vocabulary.md`. */
	reosMetaDir?: string;
	/** `--model` alias or id. Omit for the CLI default. */
	model?: string;
	/** Claude CLI session id to continue with `--resume`. */
	resume?: string;
	/** Appended to the CLI's default system prompt (e.g. a paper's full text). */
	appendSystem?: string;
	/** Stream token-level deltas so text appears as it is generated. */
	partial?: boolean;
}

export const CHAT_MODELS: { id: ChatModel; label: string; description: string }[] = [
	{ id: 'sonnet', label: 'Sonnet', description: 'Fast. Starts answering in about a second.' },
	{ id: 'opus', label: 'Opus', description: 'Deeper answers, several seconds slower to start.' }
];

/** Sonnet unless the user picked another default in Settings. */
export const DEFAULT_CHAT_MODEL: ChatModel = 'sonnet';

export function isChatModel(v: unknown): v is ChatModel {
	return CHAT_MODELS.some((m) => m.id === v);
}

export async function startChatStream(args: ChatStreamArgs): Promise<void> {
	await invoke('chat_stream', { args });
}

export async function cancelChatStream(sessionId: string): Promise<void> {
	await invoke('chat_cancel', { sessionId });
}

export async function listenChatEvents(
	sessionId: string,
	onEvent: (event: ChatEvent) => void
): Promise<UnlistenFn> {
	return await listen<ChatEvent>('chat:event', (e) => {
		if (e.payload.sessionId !== sessionId) return;
		onEvent(e.payload);
	});
}

const paperTextCache = new Map<string, Promise<string | null>>();

/** Plain text of a PDF (cached on disk by the backend), or null when it has no
 * usable text layer. Memoized per path so a prefetch and a send share work. */
export function getPaperText(pdfPath: string): Promise<string | null> {
	let p = paperTextCache.get(pdfPath);
	if (!p) {
		p = invoke<string | null>('paper_text', { pdfPath }).catch((e) => {
			console.warn('[chat] paper_text failed', e);
			paperTextCache.delete(pdfPath);
			return null;
		});
		paperTextCache.set(pdfPath, p);
	}
	return p;
}
