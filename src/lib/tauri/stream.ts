import { FileText, FilePen, Terminal, Search, Wrench, Globe } from 'lucide-svelte';

export type StreamBlock =
	| { kind: 'text'; text: string }
	| { kind: 'tool'; tool: string; summary: string }
	| { kind: 'tool_result'; result: string; isError: boolean }
	| { kind: 'thinking' };

export function basename(p: unknown): string {
	if (typeof p !== 'string') return '';
	const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
	return idx >= 0 ? p.slice(idx + 1) : p;
}

export function summarizeToolInput(name: string, input: unknown): string {
	const inp = (input ?? {}) as Record<string, unknown>;
	switch (name) {
		case 'Read':
		case 'Write':
		case 'Edit':
		case 'NotebookEdit':
			return basename(inp.file_path);
		case 'Bash': {
			const cmd = typeof inp.command === 'string' ? inp.command : '';
			const firstLine = cmd.split('\n')[0] ?? '';
			return firstLine.length > 60 ? firstLine.slice(0, 57) + '…' : firstLine;
		}
		case 'Grep':
		case 'Glob':
			return typeof inp.pattern === 'string' ? inp.pattern : '';
		case 'WebFetch':
		case 'WebSearch': {
			const u = (inp.url ?? inp.query) as string | undefined;
			if (!u) return '';
			try {
				return new URL(u).hostname;
			} catch {
				return u.length > 40 ? u.slice(0, 37) + '…' : u;
			}
		}
		case 'Skill':
			return typeof inp.skill === 'string' ? inp.skill : '';
		default:
			return '';
	}
}

function summarizeToolResult(content: unknown): string {
	// Tool results come as a string (Bash stdout, file content) or an array of
	// content blocks (PDF/image extraction). Squash to a single short string.
	const raw =
		typeof content === 'string'
			? content
			: Array.isArray(content)
				? (content
						.map((c) => (typeof c === 'object' && c && 'text' in c ? (c as { text: string }).text : ''))
						.filter(Boolean)
						.join(' ') ?? '')
				: '';
	const firstLine = raw.split('\n').find((l) => l.trim().length > 0) ?? '';
	return firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
}

export function parseStreamEvent(raw: string): StreamBlock[] {
	// Claude CLI's stream-json emits one JSON event per line. We surface:
	//  - `assistant` text + tool_use + thinking blocks
	//  - `user` tool_result blocks (a one-line snippet of the tool's output)
	// Init/system/rate_limit/result events are ignored — the wrapper handles done.
	try {
		const ev = JSON.parse(raw);
		if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
			const out: StreamBlock[] = [];
			for (const b of ev.message.content as Array<Record<string, unknown>>) {
				if (b.type === 'text' && typeof b.text === 'string' && b.text) {
					out.push({ kind: 'text', text: b.text });
				} else if (b.type === 'tool_use' && typeof b.name === 'string') {
					out.push({
						kind: 'tool',
						tool: b.name,
						summary: summarizeToolInput(b.name, b.input)
					});
				} else if (b.type === 'thinking') {
					out.push({ kind: 'thinking' });
				}
			}
			return out;
		}
		if (ev?.type === 'user' && Array.isArray(ev.message?.content)) {
			const out: StreamBlock[] = [];
			for (const b of ev.message.content as Array<Record<string, unknown>>) {
				if (b.type === 'tool_result') {
					const snippet = summarizeToolResult(b.content);
					if (snippet) {
						out.push({
							kind: 'tool_result',
							result: snippet,
							isError: b.is_error === true
						});
					}
				}
			}
			return out;
		}
	} catch {
		// non-JSON line; ignore
	}
	return [];
}

export function collectText(blocks: StreamBlock[]): string {
	return blocks
		.filter((b): b is Extract<StreamBlock, { kind: 'text' }> => b.kind === 'text')
		.map((b) => b.text)
		.join('\n')
		.trim();
}

export function toolIcon(name: string) {
	switch (name) {
		case 'Read':
			return FileText;
		case 'Write':
		case 'Edit':
		case 'NotebookEdit':
			return FilePen;
		case 'Bash':
			return Terminal;
		case 'Grep':
		case 'Glob':
			return Search;
		case 'WebFetch':
		case 'WebSearch':
			return Globe;
		default:
			return Wrench;
	}
}

export function toolVerb(name: string): string {
	switch (name) {
		case 'Read':
			return 'Read';
		case 'Write':
			return 'Wrote';
		case 'Edit':
			return 'Edited';
		case 'NotebookEdit':
			return 'Edited notebook';
		case 'Bash':
			return 'Ran';
		case 'Grep':
			return 'Grep';
		case 'Glob':
			return 'Glob';
		case 'WebFetch':
			return 'Fetched';
		case 'WebSearch':
			return 'Searched';
		case 'Skill':
			return 'Skill';
		default:
			return name;
	}
}
