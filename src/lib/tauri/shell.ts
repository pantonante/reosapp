import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

export async function revealInFinder(path: string): Promise<void> {
	await invoke('reveal_in_finder', { path });
}

export async function openExternal(url: string): Promise<void> {
	await openUrl(url);
}
