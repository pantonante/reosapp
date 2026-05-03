<script lang="ts">
	import { Button, Card, Input } from '$lib/components/ui';
	import { config } from '$lib/stores.svelte';
	import { rebuildCache } from '$lib/tauri/rebuild';
	import { ensureRootLayout } from '$lib/tauri/fs';
	import { open as openDialog } from '@tauri-apps/plugin-dialog';
	import { homeDir, join } from '@tauri-apps/api/path';
	import { FolderOpen, Loader2 } from 'lucide-svelte';

	let pickedPath = $state<string>('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	async function suggestDefault() {
		try {
			const home = await homeDir();
			pickedPath = await join(home, 'Documents', 'reos');
		} catch {
			pickedPath = '';
		}
	}

	async function pickFolder() {
		try {
			const result = await openDialog({
				directory: true,
				multiple: false,
				title: 'Choose your papers folder'
			});
			if (typeof result === 'string') pickedPath = result;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function finish() {
		if (!pickedPath) {
			error = 'Pick a folder first.';
			return;
		}
		busy = true;
		error = null;
		try {
			await config.update({ papersDir: pickedPath });
			await ensureRootLayout();
			await rebuildCache();
			window.location.reload();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			busy = false;
		}
	}

	$effect(() => {
		void suggestDefault();
	});
</script>

<div class="flex min-h-screen w-full items-center justify-center p-12">
	<Card class="w-full max-w-xl p-8">
		<h1 class="font-mono text-2xl font-light tracking-tight">
			<span class="text-accent">Re:</span>OS
		</h1>
		<p class="mt-1 text-sm text-muted-foreground">First-run setup</p>

		<div class="mt-8 space-y-4">
			<div>
				<label for="papers-folder" class="text-sm font-medium">Papers folder</label>
				<p class="mt-1 text-xs text-muted-foreground">
					Where Re:OS stores your library on disk. Pick an empty folder, or one that
					already contains a Re:OS layout. The SQLite cache lives separately at
					<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">~/.reos/cache</code>.
				</p>
				<div class="mt-3 flex gap-2">
					<Input
						id="papers-folder"
						bind:value={pickedPath}
						placeholder="/Users/you/Documents/reos"
						class="font-mono text-xs"
					/>
					<Button variant="outline" onclick={pickFolder}>
						<FolderOpen class="h-4 w-4" />
						Browse
					</Button>
				</div>
			</div>

			{#if error}
				<p class="text-sm text-destructive">{error}</p>
			{/if}

			<div class="flex justify-end gap-2 pt-2">
				<Button onclick={finish} disabled={busy || !pickedPath}>
					{#if busy}
						<Loader2 class="h-4 w-4 animate-spin" />
					{/if}
					Continue
				</Button>
			</div>
		</div>
	</Card>
</div>
