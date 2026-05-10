<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { ui } from '$lib/stores.svelte';
	import { Button } from '$lib/components/ui';
	import { bulkSummaryState, cancelBulkSummary } from '$lib/summary-bulk.svelte';
	import { X, Sparkles, Loader2, CheckCircle2, AlertTriangle } from 'lucide-svelte';

	const bulk = bulkSummaryState();

	let confirmingClose = $state(false);

	const inProgress = $derived(bulk.activePaperIds.length);
	const remaining = $derived(
		Math.max(0, bulk.total - bulk.completed - bulk.failed - bulk.cancelled)
	);
	const finished = $derived(bulk.completed + bulk.failed + bulk.cancelled);
	const allDone = $derived(!bulk.running && bulk.total > 0 && finished >= bulk.total);
	const nothingToDo = $derived(!bulk.running && bulk.total === 0);

	function requestClose() {
		if (bulk.running) {
			confirmingClose = true;
		} else {
			ui.bulkSummaryOpen = false;
			confirmingClose = false;
		}
	}

	async function confirmCancel() {
		await cancelBulkSummary();
		confirmingClose = false;
		ui.bulkSummaryOpen = false;
	}

	function dismissConfirm() {
		confirmingClose = false;
	}

	// Bits-ui sends boolean changes via onOpenChange; intercept attempts to close
	// while running to show the confirm prompt instead.
	function handleOpenChange(open: boolean) {
		if (open) {
			ui.bulkSummaryOpen = true;
			return;
		}
		if (bulk.running) {
			confirmingClose = true;
			ui.bulkSummaryOpen = true;
		} else {
			ui.bulkSummaryOpen = false;
			confirmingClose = false;
		}
	}
</script>

<DialogPrimitive.Root bind:open={ui.bulkSummaryOpen} onOpenChange={handleOpenChange}>
	<DialogPrimitive.Portal>
		<DialogPrimitive.Overlay
			class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
		/>
		<DialogPrimitive.Content
			class="panel fixed left-1/2 top-1/2 z-50 grid w-full max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 p-6"
			interactOutsideBehavior="ignore"
			escapeKeydownBehavior="ignore"
		>
			<div class="flex flex-col space-y-1.5 text-left">
				<DialogPrimitive.Title
					class="flex items-center gap-2 text-lg font-semibold leading-none tracking-tight"
				>
					<Sparkles class="h-4 w-4" />
					Generate missing summaries
				</DialogPrimitive.Title>
				<DialogPrimitive.Description class="text-sm text-muted-foreground">
					{#if nothingToDo}
						All papers already have summaries.
					{:else if bulk.cancelling}
						Cancelling in-flight jobs…
					{:else if bulk.running}
						Running up to 3 summaries in parallel.
					{:else if allDone}
						Finished.
					{:else}
						Ready.
					{/if}
				</DialogPrimitive.Description>
			</div>

			{#if bulk.total > 0}
				<div class="space-y-3">
					<div
						class="grid grid-cols-3 gap-2 rounded-md border border-border/60 bg-secondary/30 p-3 text-center"
					>
						<div>
							<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Total</div>
							<div class="text-lg font-semibold tabular-nums">{bulk.total}</div>
						</div>
						<div>
							<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
								Processing
							</div>
							<div class="flex items-center justify-center gap-1 text-lg font-semibold tabular-nums">
								{#if inProgress > 0}
									<Loader2 class="h-3.5 w-3.5 animate-spin" />
								{/if}
								{inProgress}
							</div>
						</div>
						<div>
							<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
								Completed
							</div>
							<div class="flex items-center justify-center gap-1 text-lg font-semibold tabular-nums">
								{#if bulk.completed > 0}
									<CheckCircle2 class="h-3.5 w-3.5 text-emerald-500" />
								{/if}
								{bulk.completed}
							</div>
						</div>
					</div>

					<div class="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
						<div
							class="h-full bg-primary transition-all duration-300"
							style:width={`${bulk.total > 0 ? (finished / bulk.total) * 100 : 0}%`}
						></div>
					</div>

					<div class="flex justify-between text-xs text-muted-foreground">
						<span>{remaining} remaining</span>
						{#if bulk.failed > 0 || bulk.cancelled > 0}
							<span class="flex items-center gap-1">
								{#if bulk.failed > 0}
									<AlertTriangle class="h-3 w-3 text-amber-500" />
									{bulk.failed} failed
								{/if}
								{#if bulk.cancelled > 0}
									{bulk.failed > 0 ? ' · ' : ''}{bulk.cancelled} cancelled
								{/if}
							</span>
						{/if}
					</div>
				</div>
			{/if}

			{#if confirmingClose}
				<div class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
					<p class="font-medium">Cancel all in-flight summaries?</p>
					<p class="text-xs text-muted-foreground">
						{inProgress} job{inProgress === 1 ? '' : 's'} will be killed. Already-completed summaries
						are kept.
					</p>
					<div class="mt-3 flex justify-end gap-2">
						<Button variant="ghost" onclick={dismissConfirm}>Keep running</Button>
						<Button onclick={confirmCancel}>Cancel jobs</Button>
					</div>
				</div>
			{:else}
				<div class="flex justify-end gap-2 pt-1">
					{#if bulk.running}
						<Button variant="ghost" onclick={requestClose}>Cancel…</Button>
					{:else}
						<Button onclick={requestClose}>Close</Button>
					{/if}
				</div>
			{/if}

			<button
				type="button"
				onclick={requestClose}
				class="absolute right-4 top-4 rounded-sm text-muted-foreground opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
				aria-label="Close"
			>
				<X class="h-4 w-4" />
			</button>
		</DialogPrimitive.Content>
	</DialogPrimitive.Portal>
</DialogPrimitive.Root>
