<script lang="ts">
	import 'katex/dist/katex.min.css';
	import { Marked } from 'marked';
	import markedKatex from 'marked-katex-extension';
	import { Button, Textarea } from '$lib/components/ui';
	import type { ChatMessage, ChatSummary, Thread } from '$lib/types';
	import {
		appendThreadChat,
		listThreadChats,
		newThreadChatId,
		readThreadChat,
		threadDir
	} from '$lib/tauri/fs';
	import { listenChatEvents, startChatStream, type ChatEvent } from '$lib/tauri/chat';
	import {
		collectText,
		parseStreamEvent,
		toolIcon,
		toolVerb,
		type StreamBlock
	} from '$lib/tauri/stream';
	import type { UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, tick, untrack } from 'svelte';
	import { Send, Loader2, MessageSquare, Plus } from 'lucide-svelte';
	import { cn } from '$lib/utils/cn';

	let {
		thread,
		initialChatId = null,
		startNew = false
	}: {
		thread: Thread;
		/** Chat to open first (from the thread page's chat list). */
		initialChatId?: string | null;
		/** Open on a fresh, empty chat instead of the last one. */
		startNew?: boolean;
	} = $props();

	const SYSTEM_PROMPT = `You are Re:OS's thread research assistant. Your working directory is a thread folder. You can read, edit, and create files freely within it.

Layout:
  meta.json              — thread metadata (id, title, question, status)
  synthesis.md           — the user's synthesis notes for this thread
                           (may be empty; YAML frontmatter optional)
  chats/<id>.jsonl       — prior conversations on this thread
                           (one JSON message per line)
  notes/<id>.md          — the thread's notes, shown in the app's Notes tab
                           (YAML frontmatter: title, createdAt, updatedAt;
                           media in notes/media/, embedded as ![](media/<file>);
                           link papers as [text](paper:<arxivId>))
  papers/<arxivId>/      — one folder per paper in the thread, containing:
    meta.json              — paper metadata (title, authors, abstract, tags…)
    paper.pdf              — full PDF (readable with the Read tool)
    summary.md             — generated summary with YAML frontmatter
                             (topics / domains / keywords)
    figures/               — key figures/tables cropped from the PDF, embedded
                             in summary.md as ![](figures/<file>.png)
    notes.md              — user's freeform notes (may be missing)
    chats/<id>.jsonl       — prior per-paper conversations

Defaults:
  - Prefer reading summary.md before paper.pdf — it's distilled and cheap.
  - Prior chats (this thread's and per-paper) are valid context. Skim them before answering questions about "what we discussed".
  - When the user asks about a specific paper, read its meta.json and summary.md first; open paper.pdf only if those don't answer the question.
  - When you produce artifacts (synthesis edits, comparison tables), write them into the thread folder using meaningful filenames. When the user asks for a note, write it to notes/ in the format above so it shows up in the app.`;

	const marked = new Marked({ async: false });
	marked.use(markedKatex({ throwOnError: false, nonStandard: true }));

	function renderMd(text: string): string {
		return marked.parse(text) as string;
	}

	let messages = $state<ChatMessage[]>([]);
	let composing = $state('');
	let streaming = $state(false);
	let streamBlocks = $state<StreamBlock[]>([]);
	let chats = $state<ChatSummary[]>([]);
	let currentChatId = $state<string>('');
	let scrollRoot: HTMLDivElement;
	let composerEl = $state<HTMLTextAreaElement | null>(null);
	// A chat only gets a file (and a list entry) once its first message is sent.
	const isUnsaved = $derived(!chats.some((c) => c.id === currentChatId));
	let unlisten: UnlistenFn | null = null;
	let sessionId = '';

	const currentChatTitle = $derived(
		chats.find((c) => c.id === currentChatId)?.title ?? 'New chat'
	);

	async function loadChatList() {
		chats = await listThreadChats(thread.id);
	}

	// Last chat viewed per thread, so returning to the chat tab lands on it.
	const lastChatKey = (tid: string) => `reos:threadChat:${tid}`;

	function rememberChat(id: string) {
		try {
			localStorage.setItem(lastChatKey(thread.id), id);
		} catch {
			// best effort
		}
	}

	async function openChat(id: string) {
		currentChatId = id;
		rememberChat(id);
		messages = await readThreadChat(thread.id, id);
		await tick();
		scrollToBottom();
	}

	function startNewChat() {
		currentChatId = newThreadChatId();
		messages = [];
		streamBlocks = [];
		composerEl?.focus();
	}

	async function load(wanted: string | null, fresh: boolean) {
		await loadChatList();
		if (fresh) return startNewChat();
		let remembered: string | null = null;
		try {
			remembered = localStorage.getItem(lastChatKey(thread.id));
		} catch {
			// storage unavailable
		}
		const pick = [wanted, remembered].find((id) => id && chats.some((c) => c.id === id));
		if (pick) await openChat(pick);
		else if (chats.length > 0) await openChat(chats[0].id);
		else startNewChat();
	}

	function formatRelative(iso: string): string {
		const d = new Date(iso);
		if (isNaN(d.getTime())) return '';
		const diffMs = Date.now() - d.getTime();
		const mins = Math.floor(diffMs / 60_000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		if (days < 7) return `${days}d ago`;
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	function scrollToBottom() {
		scrollRoot?.scrollTo({ top: scrollRoot.scrollHeight });
	}

	async function handleEvent(event: ChatEvent) {
		if (event.type === 'stdout') {
			const blocks = parseStreamEvent(event.line);
			if (blocks.length) streamBlocks = [...streamBlocks, ...blocks];
		} else if (event.type === 'done') {
			const finalText = collectText(streamBlocks);
			streaming = false;
			if (finalText) {
				const msg: ChatMessage = {
					role: 'assistant',
					content: finalText,
					createdAt: new Date().toISOString()
				};
				messages = [...messages, msg];
				await appendThreadChat(thread.id, currentChatId, msg);
				await loadChatList();
			}
			streamBlocks = [];
			await tick();
			scrollToBottom();
		} else if (event.type === 'error') {
			streaming = false;
			streamBlocks = [{ kind: 'text', text: `Error: ${event.message}` }];
		}
	}

	async function send() {
		const prompt = composing.trim();
		if (!prompt || streaming) return;
		const userMsg: ChatMessage = {
			role: 'user',
			content: prompt,
			createdAt: new Date().toISOString()
		};
		messages = [...messages, userMsg];
		composing = '';
		if (!currentChatId) currentChatId = newThreadChatId();
		await appendThreadChat(thread.id, currentChatId, userMsg);
		rememberChat(currentChatId);
		await loadChatList();
		await tick();
		scrollToBottom();

		streaming = true;
		streamBlocks = [];
		sessionId = `thread-${thread.id}-${Date.now()}`;

		if (unlisten) unlisten();
		unlisten = await listenChatEvents(sessionId, handleEvent);

		const workspaceDir = await threadDir(thread.id);

		await startChatStream({
			sessionId,
			prompt,
			pdfPaths: [],
			system: SYSTEM_PROMPT,
			workspaceDir
		});
	}

	// Keyed on the id, not the object: the store swaps the thread object on any
	// edit (e.g. a rename), which must not yank the user out of their chat.
	const threadId = $derived(thread.id);

	$effect(() => {
		void threadId;
		const wanted = initialChatId;
		const fresh = startNew;
		untrack(() => void load(wanted, fresh));
	});

	onDestroy(() => {
		if (unlisten) unlisten();
	});
</script>

<div class="flex h-full">
	<aside class="flex w-56 shrink-0 flex-col border-r border-border/60 bg-card lg:w-64" aria-label="Chats">
		<div class="flex h-9 shrink-0 items-center justify-between border-b border-border/60 pl-3 pr-1.5">
			<span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Chats</span>
			<button
				type="button"
				class="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
				title={streaming ? 'Wait for the reply to finish' : 'New chat'}
				aria-label="New chat"
				disabled={streaming}
				onclick={startNewChat}
			>
				<Plus class="h-3.5 w-3.5" />
			</button>
		</div>
		<nav class="flex-1 space-y-0.5 overflow-y-auto p-1.5">
			{#if isUnsaved}
				<div class="rounded-md bg-secondary px-2.5 py-1.5 text-xs text-foreground">
					<div class="truncate font-medium">New chat</div>
					<div class="text-[10px] text-muted-foreground">not sent yet</div>
				</div>
			{/if}
			{#each chats as c (c.id)}
				{@const active = c.id === currentChatId}
				<button
					type="button"
					class={cn(
						'block w-full rounded-md px-2.5 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed',
						active
							? 'bg-secondary text-foreground'
							: 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
					)}
					aria-current={active ? 'true' : undefined}
					disabled={streaming && !active}
					onclick={() => void openChat(c.id)}
				>
					<div class="truncate font-medium">{c.title}</div>
					<div class="text-[10px] text-muted-foreground">
						{formatRelative(c.updatedAt)} · {c.messageCount} message{c.messageCount === 1 ? '' : 's'}
					</div>
				</button>
			{/each}
			{#if chats.length === 0 && !isUnsaved}
				<p class="px-2.5 py-2 text-xs text-muted-foreground">No chats yet.</p>
			{/if}
		</nav>
	</aside>

	<section class="flex min-w-0 flex-1 flex-col">
		<div class="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-4">
			<MessageSquare class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			<span class="truncate text-xs text-muted-foreground" title={currentChatTitle}>{currentChatTitle}</span>
		</div>
		<div bind:this={scrollRoot} class="min-h-0 flex-1 overflow-y-auto">
			<div class="mx-auto max-w-3xl space-y-3 px-4 py-4">
				{#each messages as m (m.createdAt + m.role)}
					<div
						class={cn(
							'rounded-md border p-3',
							m.role === 'user' ? 'border-border/60 bg-secondary/40' : 'border-border/40 bg-background/40'
						)}
					>
						<div class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
							{m.role}
						</div>
						<div class="chat-md text-sm leading-relaxed">{@html renderMd(m.content)}</div>
					</div>
				{/each}
				{#if streaming}
					<div class="rounded-md border border-accent/40 bg-accent/5 p-3">
						<div class="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-accent">
							<Loader2 class="h-3 w-3 animate-spin" />
							assistant
						</div>
						<div class="space-y-1.5 text-sm leading-relaxed">
							{#each streamBlocks as block, i (i)}
								{#if block.kind === 'text'}
									<div class="chat-md">{@html renderMd(block.text)}</div>
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
							{#if streamBlocks.length === 0}
								<div class="text-xs text-muted-foreground">
									… (if this hangs, check the terminal running <code class="font-mono">npm run tauri dev</code>
									for <code class="font-mono">[chat_stream:…]</code> diagnostic logs)
								</div>
							{/if}
						</div>
					</div>
				{/if}
				{#if messages.length === 0 && !streaming}
					<p class="px-2 py-12 text-center text-sm text-muted-foreground">
						Ask Claude about this thread.
					</p>
				{/if}
			</div>
		</div>
		<div class="shrink-0 border-t border-border/60">
			<div class="mx-auto max-w-3xl p-3">
				<Textarea
					bind:ref={composerEl}
					bind:value={composing}
					placeholder="Ask about this thread… (⌘↩ to send)"
					rows={3}
					class="resize-none text-sm"
					onkeydown={(e: KeyboardEvent) => {
						if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
							e.preventDefault();
							void send();
						}
					}}
				/>
				<div class="mt-2 flex flex-wrap items-center justify-end gap-2 sm:justify-between">
					<span class="hidden min-w-0 flex-1 truncate text-[10px] text-muted-foreground sm:block">
						Powered by your local <code class="font-mono">claude</code> CLI · skills enabled · navigates thread folder
					</span>
					<Button size="sm" onclick={send} disabled={streaming || !composing.trim()}>
						<Send class="h-3.5 w-3.5" />
						Send
					</Button>
				</div>
			</div>
		</div>
	</section>
</div>

<style>
	/* Compact markdown styles for chat bubbles. Mirrors PaperChat. */
	.chat-md :global(> :first-child) {
		margin-top: 0;
	}
	.chat-md :global(> :last-child) {
		margin-bottom: 0;
	}
	.chat-md :global(p) {
		margin: 0.4rem 0;
	}
	.chat-md :global(h1),
	.chat-md :global(h2),
	.chat-md :global(h3),
	.chat-md :global(h4) {
		font-weight: 600;
		color: hsl(var(--foreground));
		margin: 0.7rem 0 0.3rem;
		line-height: 1.3;
	}
	.chat-md :global(h1) {
		font-size: 1rem;
	}
	.chat-md :global(h2) {
		font-size: 0.95rem;
	}
	.chat-md :global(h3) {
		font-size: 0.9rem;
	}
	.chat-md :global(h4) {
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: hsl(var(--muted-foreground));
	}
	.chat-md :global(ul) {
		margin: 0.4rem 0;
		padding-left: 1.25rem;
		list-style-type: disc;
	}
	.chat-md :global(ul ul) {
		list-style-type: circle;
	}
	.chat-md :global(ul ul ul) {
		list-style-type: square;
	}
	.chat-md :global(ol) {
		margin: 0.4rem 0;
		padding-left: 1.5rem;
		list-style-type: decimal;
	}
	.chat-md :global(li) {
		margin: 0.15rem 0;
	}
	.chat-md :global(li > p) {
		margin: 0.1rem 0;
	}
	.chat-md :global(li::marker) {
		color: hsl(var(--muted-foreground));
	}
	.chat-md :global(strong) {
		font-weight: 600;
		color: hsl(var(--foreground));
	}
	.chat-md :global(em) {
		font-style: italic;
	}
	.chat-md :global(code) {
		font-family: 'JetBrains Mono', 'SF Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		background: hsl(var(--muted) / 0.7);
		padding: 0.05em 0.3em;
		border-radius: 3px;
		font-size: 0.9em;
	}
	.chat-md :global(pre) {
		background: hsl(var(--muted) / 0.6);
		border: 1px solid hsl(var(--border));
		border-radius: 5px;
		padding: 0.5rem 0.65rem;
		overflow-x: auto;
		margin: 0.5rem 0;
		line-height: 1.5;
	}
	.chat-md :global(pre code) {
		background: transparent;
		padding: 0;
		font-size: 0.9em;
	}
	.chat-md :global(blockquote) {
		border-left: 2px solid hsl(var(--accent) / 0.6);
		padding: 0.05rem 0 0.05rem 0.65rem;
		margin: 0.5rem 0;
		color: hsl(var(--muted-foreground));
		font-style: italic;
	}
	.chat-md :global(table) {
		border-collapse: collapse;
		margin: 0.5rem 0;
		width: 100%;
		font-size: 0.95em;
	}
	.chat-md :global(th),
	.chat-md :global(td) {
		border: 1px solid hsl(var(--border));
		padding: 0.3rem 0.45rem;
		text-align: left;
		vertical-align: top;
	}
	.chat-md :global(th) {
		background: hsl(var(--muted) / 0.7);
		font-weight: 600;
	}
	.chat-md :global(hr) {
		border: 0;
		border-top: 1px solid hsl(var(--border));
		margin: 0.7rem 0;
	}
	.chat-md :global(a) {
		color: hsl(var(--accent));
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 2px;
	}
	.chat-md :global(a:hover) {
		text-decoration-thickness: 2px;
	}
	.chat-md :global(.katex-display) {
		margin: 0.5rem 0;
		padding: 0.15rem 0;
		overflow-x: auto;
		overflow-y: hidden;
	}
</style>
