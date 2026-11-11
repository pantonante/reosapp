<script lang="ts">
	import type { ChatModel } from '$lib/types';
	import { CHAT_MODELS } from '$lib/tauri/chat';
	import { cn } from '$lib/utils/cn';

	let {
		value,
		onchange,
		disabled = false
	}: {
		value: ChatModel;
		onchange: (model: ChatModel) => void;
		disabled?: boolean;
	} = $props();
</script>

<div
	class="inline-flex shrink-0 items-center rounded-md border border-border/60 p-0.5"
	role="radiogroup"
	aria-label="Model"
>
	{#each CHAT_MODELS as m (m.id)}
		{@const active = value === m.id}
		<button
			type="button"
			role="radio"
			aria-checked={active}
			title={m.description}
			{disabled}
			class={cn(
				'rounded px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50',
				active
					? 'bg-secondary font-medium text-foreground'
					: 'text-muted-foreground hover:text-foreground'
			)}
			onclick={() => onchange(m.id)}
		>
			{m.label}
		</button>
	{/each}
</div>
