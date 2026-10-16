#!/usr/bin/env node
/**
 * reos-mcp-server — stdio MCP server for the Re:OS paper library.
 *
 * Works on the library directly on disk (papersDir from ~/.reos/config.json)
 * and never touches the app's SQLite cache. Read-only except for the additive
 * create_thread/add_paper tools (see mutate.ts).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';

const server = new McpServer(
	{
		name: 'reos-mcp-server',
		version: '0.1.0'
	},
	{
		instructions: [
			"Re:OS is the user's research library: threads (investigations) containing papers and markdown notes.",
			'When writing notes (create_note / update_note), always cite the papers you use by linking them inline as [text](paper:<arxivId>).',
			'If a paper you want to cite is not in the library yet, add it first with add_paper, then link it with the arxivId add_paper returns.',
			'Read cheaply first: get_thread, then get_paper_content (summaries/notes), then chats, and open a paper.pdf only as a last resort.'
		].join(' ')
	}
);

registerTools(server);

async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// stdout is the protocol channel — diagnostics go to stderr only.
	console.error('reos-mcp-server running on stdio');
}

main().catch((err) => {
	console.error('reos-mcp-server fatal error:', err);
	process.exit(1);
});
