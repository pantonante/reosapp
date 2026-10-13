import { invoke } from '@tauri-apps/api/core';

export interface AlphaXivCredentialStatus {
	configured: boolean;
	hint: string | null;
}

export interface AlphaXivImage {
	fileName: string;
	mimeType: string;
	/** Base64-encoded bytes returned by an MCP image content block. */
	data: string;
}

export interface AlphaXivPaperContent {
	markdown: string;
	images: AlphaXivImage[];
	imageUrls: string[];
	imageWarning: string | null;
}

export interface AlphaXivFetchedImage {
	mimeType: string;
	data: string;
}

export function getAlphaXivCredentialStatus(): Promise<AlphaXivCredentialStatus> {
	return invoke('alphaxiv_credential_status');
}

export function saveAlphaXivApiKey(apiKey: string): Promise<AlphaXivCredentialStatus> {
	return invoke('save_alphaxiv_api_key', { apiKey });
}

export function deleteAlphaXivApiKey(): Promise<AlphaXivCredentialStatus> {
	return invoke('delete_alphaxiv_api_key');
}

export function testAlphaXivApiKey(): Promise<void> {
	return invoke('test_alphaxiv_api_key');
}

export function getAlphaXivPaperContent(paperUrl: string): Promise<AlphaXivPaperContent> {
	return invoke('alphaxiv_get_paper_content', { paperUrl });
}

export function fetchAlphaXivImage(url: string): Promise<AlphaXivFetchedImage> {
	return invoke('alphaxiv_fetch_image', { url });
}

export function decodeBase64(data: string): Uint8Array {
	const binary = atob(data.replace(/\s/g, ''));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function imageExtension(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case 'image/jpeg':
			return 'jpg';
		case 'image/webp':
			return 'webp';
		case 'image/gif':
			return 'gif';
		default:
			return 'png';
	}
}
