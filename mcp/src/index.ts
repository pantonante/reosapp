#!/usr/bin/env node
/**
 * reos-mcp-server — read-only stdio MCP server for the Re:OS paper library.
 *
 * Reads the library directly from disk (papersDir from ~/.reos/config.json);
 * never touches the app's SQLite cache and never writes under papersDir.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';

const server = new McpServer({
	name: 'reos-mcp-server',
	version: '0.1.0'
});

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
