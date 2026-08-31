// Bootstrap: ~/.reos/config.json -> papersDir. Mirrors the app's Rust-side
// config (src-tauri/src/commands/config.rs). Mtime-cached and re-read lazily
// on every tool call so fixing the config needs no client restart.

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_PATH = join(homedir(), '.reos', 'config.json');

export class ConfigError extends Error {}

const NOT_CONFIGURED_MSG =
	`Re:OS papers folder is not configured. Open the Re:OS app once to set it, ` +
	`or create ${CONFIG_PATH} with: { "papersDir": "/absolute/path/to/library" }`;

let cache: { mtimeMs: number; papersDir: string | null } | null = null;

/** Absolute path of the library root. Throws ConfigError with a fix-it message. */
export async function papersRoot(): Promise<string> {
	let mtimeMs: number;
	try {
		mtimeMs = (await stat(CONFIG_PATH)).mtimeMs;
	} catch {
		cache = null;
		throw new ConfigError(NOT_CONFIGURED_MSG);
	}
	if (!cache || cache.mtimeMs !== mtimeMs) {
		let papersDir: string | null = null;
		try {
			const parsed: unknown = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
			if (parsed && typeof parsed === 'object') {
				const dir = (parsed as { papersDir?: unknown }).papersDir;
				if (typeof dir === 'string' && dir.trim()) papersDir = dir;
			}
		} catch {
			throw new ConfigError(`Could not parse ${CONFIG_PATH} — is it valid JSON?`);
		}
		cache = { mtimeMs, papersDir };
	}
	if (!cache.papersDir) throw new ConfigError(NOT_CONFIGURED_MSG);
	return cache.papersDir;
}
