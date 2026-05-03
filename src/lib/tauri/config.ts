import { invoke } from '@tauri-apps/api/core';
import type { ReosConfig } from '$lib/types';

export async function loadConfig(): Promise<ReosConfig> {
	return invoke<ReosConfig>('load_config');
}

export async function saveConfig(config: ReosConfig): Promise<void> {
	await invoke('save_config', { config });
}

export async function getConfigPath(): Promise<string> {
	return invoke<string>('config_path');
}
