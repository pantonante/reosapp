<script lang="ts">
	import { Button, Textarea } from '$lib/components/ui';
	import type { ChatMessage, Paper } from '$lib/types';
	import { appendPaperChat, readPaperChat, threadDir, INBOX_SLUG } from '$lib/tauri/fs';
	import { listenChatEvents, startChatStream, type ChatEvent } from '$lib/tauri/chat';
	import {
		collectText,
		parseStreamEvent,
		toolIcon,
		toolVerb,
		type StreamBlock
	} from '$lib/tauri/stream';
	import type { UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount, tick } from 'svelte';
	import { Send, Loader2 } from 'lucide-svelte';

	let { paper }: { paper: Paper } = $props();

	let messages = $state<ChatMessage[]>([]);
	let composing = $state('');
	let streaming = $state(false);
	let streamBlocks = $state<StreamBlock[]>([]);
	let scrollRoot: HTMLDivElement;
	let unlisten: UnlistenFn | null = null;
	let sessionId = '';

	async function load() {
		messages = await readPaperChat(paper.threadId ?? INBOX_SLUG, paper.arxivId);
		await tick();
		scrollToBottom();
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
				await appendPaperChat(paper.threadId ?? INBOX_SLUG, paper.arxivId, msg);
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
		await appendPaperChat(paper.threadId ?? INBOX_SLUG, paper.arxivId, userMsg);
		await tick();
		scrollToBottom();

		streaming = true;
		streamBlocks = [];
		sessionId = `paper-${paper.id}-${Date.now()}`;

		if (unlisten) unlisten();
		unlisten = await listenChatEvents(sessionId, handleEvent);

		const workspaceDir = await threadDir(paper.threadId ?? INBOX_SLUG);

		await startChatStream({
			sessionId,
			prompt,
			pdfPaths: paper.pdfPath ? [paper.pdfPath] : [],
			workspaceDir
		});
	}

	onMount(() => {
		void load();
	});

	$effect(() => {
		if (paper.id) void load();
	});

	onDestroy(() => {
		if (unlisten) unlisten();
	});
</script>

<div class="flex h-full flex-col">
	<div bind:this={scrollRoot} class="flex-1 space-y-3 overflow-y-auto p-3">
		{#each messages as m (m.createdAt + m.role)}
			<div class="rounded-md border border-border/40 bg-background/40 p-2">
				<div class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
					{m.role}
				</div>
				<div class="whitespace-pre-wrap text-xs leading-relaxed">{m.content}</div>
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
					{#if streamBlocks.length === 0}
						<div class="text-muted-foreground">
							… (if this hangs, check the terminal running <code class="font-mono">npm run tauri dev</code>
							for <code class="font-mono">[chat_stream:…]</code> diagnostic logs)
						</div>
					{/if}
				</div>
			</div>
		{/if}
		{#if messages.length === 0 && !streaming}
			<p class="px-2 py-8 text-center text-xs text-muted-foreground">
				Ask Claude about this paper.
			</p>
		{/if}
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
		<div class="mt-2 flex items-center justify-between">
			<span class="text-[10px] text-muted-foreground">
				Powered by your local <code class="font-mono">claude</code> CLI · skills enabled
			</span>
			<Button size="sm" onclick={send} disabled={streaming || !composing.trim()}>
				<Send class="h-3.5 w-3.5" />
				Send
			</Button>
		</div>
	</div>
</div>
