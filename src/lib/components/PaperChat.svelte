<script lang="ts">
	import 'katex/dist/katex.min.css';
	import { Marked } from 'marked';
	import { katexExtension } from '$lib/utils/markdown-katex';
	import { Button, Textarea } from '$lib/components/ui';
	import type { ChatMessage, ChatModel, ChatSummary, Paper } from '$lib/types';
	import {
		appendPaperChat,
		listPaperChats,
		newPaperChatId,
		readPaperChat,
		threadDir,
		INBOX_SLUG
	} from '$lib/tauri/fs';
	import { getPaperText } from '$lib/tauri/chat';
	import { runChatTurn } from '$lib/chat-runner';
	import { DEFAULT_CHAT_MODEL, isChatModel } from '$lib/tauri/chat';
	import { config } from '$lib/stores.svelte';
	import ChatModelPicker from '$lib/components/ChatModelPicker.svelte';
	import { toolIcon, toolVerb, type StreamBlock } from '$lib/tauri/stream';
	import { tick, untrack } from 'svelte';
	import { Send, Loader2, Clock, Plus } from 'lucide-svelte';
	import { textZoom } from '$lib/text-zoom.svelte';

	let { paper }: { paper: Paper } = $props();

	const marked = new Marked({ async: false });
	marked.use(katexExtension());

	function renderMd(text: string): string {
		return marked.parse(text) as string;
	}

	let messages = $state<ChatMessage[]>([]);
	let composing = $state('');
	let streaming = $state(false);
	let streamBlocks = $state<StreamBlock[]>([]);
	let chats = $state<ChatSummary[]>([]);
	let currentChatId = $state<string>('');
	let historyOpen = $state(false);
	let scrollRoot: HTMLDivElement;
	let errorNote = $state('');
	// Starts on the Settings default; a pick here applies to this view only.
	let pickedModel = $state<ChatModel | null>(null);
	const model = $derived<ChatModel>(
		pickedModel ?? (isChatModel(config.value.chatModel) ? config.value.chatModel : DEFAULT_CHAT_MODEL)
	);
	/** Paper whose reply is streaming, when `streaming`. */
	let streamingFor = '';

	const currentChatTitle = $derived(
		chats.find((c) => c.id === currentChatId)?.title ?? 'New chat'
	);

	function threadSlug(): string {
		return paper.threadId ?? INBOX_SLUG;
	}

	async function loadChatList() {
		chats = await listPaperChats(threadSlug(), paper.arxivId);
	}

	async function openChat(id: string) {
		currentChatId = id;
		messages = await readPaperChat(threadSlug(), paper.arxivId, id);
		historyOpen = false;
		await tick();
		scrollToBottom();
	}

	function startNewChat() {
		currentChatId = newPaperChatId();
		messages = [];
		streamBlocks = [];
		errorNote = '';
		historyOpen = false;
	}

	async function load() {
		if (streaming) {
			// A reply in flight for this paper owns `messages`; reloading would
			// drop it. One for another paper (the page component is reused across
			// papers) keeps running in the background and saves itself.
			if (streamingFor === paper.id) return;
			streaming = false;
			streamBlocks = [];
		}
		await loadChatList();
		if (chats.length > 0) {
			await openChat(chats[0].id);
		} else {
			startNewChat();
		}
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

	// Above this the text is cut, and Claude is told to read the PDF for the rest.
	const MAX_PAPER_CHARS = 300_000;

	/** System-prompt addition carrying the paper's full text, so Claude can
	 * answer straight away instead of opening the PDF (slow on Google Drive)
	 * with a tool call on every turn. Null when the PDF has no text layer. */
	async function paperContext(p: Paper): Promise<string | null> {
		if (!p.pdfPath) return null;
		let text = await getPaperText(p.pdfPath);
		if (!text) return null;
		const truncated = text.length > MAX_PAPER_CHARS;
		if (truncated) text = text.slice(0, MAX_PAPER_CHARS);
		const byline = [p.authors?.slice(0, 3).join(', '), p.publishedDate?.slice(0, 4)]
			.filter(Boolean)
			.join(' · ');
		return [
			`The user is asking about a paper they have open in Re:OS: "${p.title}"${byline ? ` (${byline})` : ''}.`,
			`Its full text, extracted from the PDF, is below between <paper> tags. Answer from it directly. Do not open the PDF to answer questions the text covers.`,
			`Open the PDF (${p.pdfPath}) with the Read tool, using the pages parameter, only when you need a figure, a table or an equation that the extraction garbled${truncated ? ', or text after the point where the extraction below was cut' : ''}.`,
			`Your working directory is the paper's thread folder. This paper's folder is papers/${p.arxivId}/ (summary.md, notes, figures).`,
			`<paper>\n${text}${truncated ? '\n[… truncated …]' : ''}\n</paper>`
		].join('\n');
	}

	async function send() {
		const prompt = composing.trim();
		if (!prompt || streaming) return;
		const userMsg: ChatMessage = {
			role: 'user',
			content: prompt,
			createdAt: new Date().toISOString()
		};
		const history = messages;
		messages = [...messages, userMsg];
		composing = '';
		errorNote = '';
		if (!currentChatId) currentChatId = newPaperChatId();
		streaming = true;
		streamingFor = paper.id;
		streamBlocks = [];

		// Captured now: the reply is saved here even if the user switches chat
		// or paper before it finishes.
		const slug = threadSlug();
		const arxivId = paper.arxivId;
		const chatId = currentChatId;
		const target = paper;

		await appendPaperChat(slug, arxivId, chatId, userMsg);
		await loadChatList();
		await tick();
		scrollToBottom();

		const [workspaceDir, context] = await Promise.all([threadDir(slug), paperContext(target)]);

		// Without extracted text, fall back to handing Claude the PDF (or, for
		// webpage-papers, the source URL for its WebFetch tool).
		const pdfPaths = !context && target.pdfPath ? [target.pdfPath] : [];
		const finalPrompt =
			!target.pdfPath && target.sourceUrl
				? `Source URL: ${target.sourceUrl}\nUse WebFetch to read the page if you need its content to answer.\n\n${prompt}`
				: prompt;

		const isCurrent = () => paper.id === target.id && currentChatId === chatId;

		runChatTurn({
			label: `paper-${target.id}`,
			prompt: finalPrompt,
			history,
			model,
			workspaceDir,
			appendSystem: context ?? undefined,
			pdfPaths,
			onUpdate: (blocks) => {
				if (!isCurrent()) return;
				streamBlocks = blocks;
				if (nearBottom()) void tick().then(scrollToBottom);
			},
			onFinish: async ({ text, sessionId, error }) => {
				const current = isCurrent();
				if (current) {
					streaming = false;
					streamBlocks = [];
				}
				if (text) {
					const msg: ChatMessage = {
						role: 'assistant',
						content: text,
						createdAt: new Date().toISOString(),
						...(sessionId ? { sessionId } : {})
					};
					if (current) messages = [...messages, msg];
					await appendPaperChat(slug, arxivId, chatId, msg);
					if (current) await loadChatList();
				} else if (current) {
					errorNote = error ?? 'No reply.';
				}
				if (current) {
					await tick();
					scrollToBottom();
				}
			}
		});
	}

	function nearBottom(): boolean {
		if (!scrollRoot) return false;
		return scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight < 120;
	}

	// Keyed on the id, not the object: the papers store swaps the object on
	// any metadata change or external sync, which must not reload the chat.
	const paperId = $derived(paper.id);

	$effect(() => {
		void paperId;
		untrack(() => {
			void load();
			// Warm the text cache while the user is still typing.
			if (paper.pdfPath) void getPaperText(paper.pdfPath);
		});
	});
</script>

<div class="relative flex h-full flex-col">
	<div class="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
		<div class="truncate text-xs text-muted-foreground" title={currentChatTitle}>
			{currentChatTitle}
		</div>
		<div class="flex items-center gap-1">
			<button
				type="button"
				class="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
				title="Chat history"
				disabled={streaming}
				onclick={() => (historyOpen = !historyOpen)}
			>
				<Clock class="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				class="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
				title="New chat"
				disabled={streaming}
				onclick={startNewChat}
			>
				<Plus class="h-3.5 w-3.5" />
			</button>
		</div>
	</div>
	{#if historyOpen}
		<div
			class="absolute right-2 top-9 z-10 max-h-72 w-64 overflow-y-auto rounded-md border border-border/60 bg-card shadow-lg"
		>
			{#if chats.length === 0}
				<div class="px-3 py-2 text-xs text-muted-foreground">No past chats</div>
			{:else}
				{#each chats as c (c.id)}
					<button
						type="button"
						class="block w-full border-b border-border/40 px-3 py-1.5 text-left text-xs last:border-b-0 hover:bg-muted {c.id ===
						currentChatId
							? 'text-accent'
							: ''}"
						onclick={() => openChat(c.id)}
					>
						<div class="truncate">{c.title}</div>
						<div class="text-[10px] text-muted-foreground">{formatRelative(c.updatedAt)}</div>
					</button>
				{/each}
			{/if}
		</div>
	{/if}
	<div bind:this={scrollRoot} class="flex-1 overflow-y-auto p-3">
		<div class="space-y-3" data-text-zoom style:zoom={textZoom.value}>
		{#each messages as m (m.createdAt + m.role)}
			<div class="rounded-md border border-border/40 bg-background/40 p-2">
				<div class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
					{m.role}
				</div>
				<div class="chat-md text-xs leading-relaxed">{@html renderMd(m.content)}</div>
			</div>
		{/each}
		{#if streaming}
			<div class="rounded-md border border-accent/40 bg-accent/5 p-2">
				<div class="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-accent">
					<Loader2 class="h-3 w-3 animate-spin" />
					assistant
				</div>
				<div class="space-y-1.5 text-xs leading-relaxed">
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
						<div class="text-muted-foreground">
							Thinking…
						</div>
					{/if}
				</div>
			</div>
		{/if}
		{#if errorNote && !streaming}
			<div class="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
				<div class="mb-1 text-[10px] uppercase tracking-wider text-destructive">No reply</div>
				<pre class="whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">{errorNote}</pre>
			</div>
		{/if}
		{#if messages.length === 0 && !streaming}
			<p class="px-2 py-8 text-center text-xs text-muted-foreground">
				Ask Claude about this paper.
			</p>
		{/if}
		</div>
	</div>
	<div class="border-t border-border/60 p-2">
		<Textarea
			bind:value={composing}
			placeholder="Ask about this paper… (⌘↩ to send)"
			rows={2}
			class="resize-none text-xs"
			onkeydown={(e: KeyboardEvent) => {
				if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
					e.preventDefault();
					void send();
				}
			}}
		/>
		<div class="mt-2 flex items-center justify-between gap-2">
			<div class="flex min-w-0 flex-1 items-center gap-2">
				<ChatModelPicker value={model} onchange={(m) => (pickedModel = m)} disabled={streaming} />
				<span class="hidden min-w-0 truncate text-[10px] text-muted-foreground sm:block">
					via your local <code class="font-mono">claude</code> CLI
				</span>
			</div>
			<Button size="sm" onclick={send} disabled={streaming || !composing.trim()}>
				<Send class="h-3.5 w-3.5" />
				Send
			</Button>
		</div>
	</div>
</div>

<style>
	/* Compact markdown styles for chat bubbles. Mirrors the patterns in
	   PaperSummary's .summary-md but tuned for the smaller, denser chat view. */
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
