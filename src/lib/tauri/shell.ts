import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';

export async function revealInFinder(path: string): Promise<void> {
	await invoke('reveal_in_finder', { path });
}

/** Opens the AirDrop sheet with the file's Google Drive link; returns the link. */
export async function airdropDriveLink(path: string): Promise<string> {
	return await invoke<string>('airdrop_drive_link', { path });
}

export async function openExternal(url: string): Promise<void> {
	await openUrl(url);
}
