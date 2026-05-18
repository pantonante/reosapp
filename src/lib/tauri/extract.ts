import { invoke } from '@tauri-apps/api/core';

export interface ExtractedMetadata {
	title: string;
	authors: string[];
	year: string;
	abstract: string;
}

export async function extractPdfMetadata(pdfPath: string): Promise<ExtractedMetadata> {
	return await invoke<ExtractedMetadata>('extract_pdf_metadata', {
		args: { pdfPath }
	});
}

export async function extractWebpageMetadata(url: string): Promise<ExtractedMetadata> {
	return await invoke<ExtractedMetadata>('extract_webpage_metadata', {
		args: { url }
	});
}
