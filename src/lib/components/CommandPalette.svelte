<script lang="ts">
	import { Command, Dialog as DialogPrimitive } from 'bits-ui';
	import { goto } from '$app/navigation';
	import { papers, threads, ui } from '$lib/stores.svelte';
	import { rebuildCache } from '$lib/tauri/rebuild';
	import { Inbox, Library, Layers, Plus, FileText, RefreshCw, Settings } from 'lucide-svelte';

	let value = $state('');

	function close() {
		ui.commandPaletteOpen = false;
		value = '';
	}

	function run(fn: () => unknown) {
		close();
		void fn();
	}

	const navActions = [
		{ label: 'Inbox', icon: Inbox, run: () => goto('/') },
		{ label: 'Library', icon: Library, run: () => goto('/library') },
		{ label: 'Threads', icon: Layers, run: () => goto('/threads') },
		{ label: 'Settings', icon: Settings, run: () => goto('/settings') }
	];

	const commandActions = [
		{ label: 'Add paper', icon: Plus, run: () => (ui.addPaperOpen = true) },
		{ label: 'Rebuild cache', icon: RefreshCw, run: () => rebuildCache() }
	];

	function handleKey(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			ui.commandPaletteOpen = !ui.commandPaletteOpen;
		}
	}
</script>

<svelte:window onkeydown={handleKey} />

<DialogPrimitive.Root bind:open={ui.commandPaletteOpen}>
	<DialogPrimitive.Portal>
		<DialogPrimitive.Overlay class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
		<DialogPrimitive.Content
			class="fixed left-1/2 top-[20vh] z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border/60 bg-card shadow-2xl"
		>
			<Command.Root label="Command palette" class="w-full">
				<Command.Input
					bind:value
					placeholder="Search papers, threads, or commands…"
					class="w-full border-0 border-b border-border/60 bg-transparent px-4 py-3 text-sm focus:outline-none"
				/>
				<Command.List class="max-h-80 overflow-y-auto p-1">
					<Command.Empty class="px-4 py-8 text-center text-sm text-muted-foreground">
						No results.
					</Command.Empty>

					<Command.Group>
						<Command.GroupHeading class="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
							Navigate
						</Command.GroupHeading>
						<Command.GroupItems>
							{#each navActions as action (action.label)}
								{@const Icon = action.icon}
								<Command.Item
									value={`nav:${action.label}`}
									onSelect={() => run(action.run)}
									class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground data-[selected]:bg-accent/15 data-[selected]:text-accent"
								>
									<Icon class="h-3.5 w-3.5" />
									{action.label}
								</Command.Item>
							{/each}
						</Command.GroupItems>
					</Command.Group>

					<Command.Group>
						<Command.GroupHeading class="mt-1 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
							Commands
						</Command.GroupHeading>
						<Command.GroupItems>
							{#each commandActions as action (action.label)}
								{@const Icon = action.icon}
								<Command.Item
									value={`cmd:${action.label}`}
									onSelect={() => run(action.run)}
									class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground data-[selected]:bg-accent/15 data-[selected]:text-accent"
								>
									<Icon class="h-3.5 w-3.5" />
									{action.label}
								</Command.Item>
							{/each}
						</Command.GroupItems>
					</Command.Group>

					{#if papers.items.length > 0}
						<Command.Group>
							<Command.GroupHeading class="mt-1 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
								Papers
							</Command.GroupHeading>
							<Command.GroupItems>
								{#each papers.items.slice(0, 20) as paper (paper.id)}
									<Command.Item
										value={`paper:${paper.title} ${paper.authors.join(' ')} ${paper.arxivId}`}
										onSelect={() => run(() => goto(`/paper/${paper.id}`))}
										class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground data-[selected]:bg-accent/15 data-[selected]:text-accent"
									>
										<FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
										<span class="truncate">{paper.title}</span>
										<span class="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
											{paper.arxivId}
										</span>
									</Command.Item>
								{/each}
							</Command.GroupItems>
						</Command.Group>
					{/if}

					{#if threads.items.length > 0}
						<Command.Group>
							<Command.GroupHeading class="mt-1 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
								Threads
							</Command.GroupHeading>
							<Command.GroupItems>
								{#each threads.items.slice(0, 20) as thread (thread.id)}
									<Command.Item
										value={`thread:${thread.title} ${thread.question}`}
										onSelect={() => run(() => goto(`/threads/${thread.id}`))}
										class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground data-[selected]:bg-accent/15 data-[selected]:text-accent"
									>
										<Layers class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
										<span class="truncate">{thread.title}</span>
									</Command.Item>
								{/each}
							</Command.GroupItems>
						</Command.Group>
					{/if}
				</Command.List>
			</Command.Root>
		</DialogPrimitive.Content>
	</DialogPrimitive.Portal>
</DialogPrimitive.Root>
