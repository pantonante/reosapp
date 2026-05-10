import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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
