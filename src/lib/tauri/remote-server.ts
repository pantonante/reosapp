import { invoke } from '@tauri-apps/api/core';

export interface RemoteServerStatus {
	enabled: boolean;
	running: boolean;
	addresses: string[];
	port: number;
	airdropAvailable: boolean;
}

export function getRemoteServerStatus(): Promise<RemoteServerStatus> {
	return invoke('remote_server_status');
}

export function setRemoteServerEnabled(enabled: boolean): Promise<RemoteServerStatus> {
	return invoke('set_remote_server_enabled', { enabled });
}

export function shareRemoteAddress(address: string): Promise<void> {
	return invoke('share_remote_address', { address });
}

export function syncRemoteOpenPapers(ids: string[], activeId: string | null): Promise<void> {
	return invoke('set_remote_open_papers', { ids, activeId });
}
