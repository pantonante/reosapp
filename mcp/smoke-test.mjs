// Smoke test: drives dist/index.js over stdio with the real MCP client.
// Usage: node smoke-test.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'smoke-test', version: '0.0.1' });
await client.connect(
	new StdioClientTransport({ command: 'node', args: ['dist/index.js'] })
);

const show = (label, res, max = 900) => {
	const text = res.content?.map((c) => c.text).join('\n') ?? '(no content)';
	console.log(`\n===== ${label}${res.isError ? ' [ERROR RESULT]' : ''} =====`);
	console.log(text.length > max ? text.slice(0, max) + `\n…[${text.length} chars total]` : text);
	return text;
};

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

const threadsRes = await client.callTool({ name: 'list_threads', arguments: {} });
const threadsText = show('list_threads', threadsRes);
const threads = JSON.parse(threadsText).threads;
const firstReal = threads.find((t) => t.slug !== 'inbox' && t.paperCount > 0) ?? threads[0];

show(
	`get_thread ${firstReal.slug}`,
	await client.callTool({ name: 'get_thread', arguments: { thread: firstReal.slug } })
);

const searchText = show(
	'search_papers (list all, limit 5)',
	await client.callTool({ name: 'search_papers', arguments: { limit: 5 } })
);
const firstPaper = JSON.parse(searchText).papers[0];

show(
	'search_papers query',
	await client.callTool({
		name: 'search_papers',
		arguments: { query: firstPaper.title.split(/\s+/)[0], limit: 3 }
	})
);

show(
	`get_paper ${firstPaper.arxivId}`,
	await client.callTool({ name: 'get_paper', arguments: { paper: firstPaper.arxivId } })
);

show(
	`get_paper_content ${firstPaper.arxivId}`,
	await client.callTool({ name: 'get_paper_content', arguments: { paper: firstPaper.arxivId } })
);

const chatsText = show(
	`list_chats ${firstReal.slug}`,
	await client.callTool({ name: 'list_chats', arguments: { thread: firstReal.slug } })
);
const chatsParsed = JSON.parse(chatsText);
if (chatsParsed.chats.length) {
	show(
		'get_chat (last 4 msgs)',
		await client.callTool({
			name: 'get_chat',
			arguments: { thread: firstReal.slug, chat_id: chatsParsed.chats[0].id, last_n: 4 }
		})
	);
} else {
	// find any thread with a paper chat instead
	const withPaperChats = Object.keys(chatsParsed.paperChatCounts ?? {});
	console.log('\n(no thread-level chats in this thread; paper chats:', withPaperChats, ')');
}

show('get_vocabulary', await client.callTool({ name: 'get_vocabulary', arguments: {} }), 400);

// Error paths
show(
	'get_paper bogus ref',
	await client.callTool({ name: 'get_paper', arguments: { paper: 'does-not-exist-xyz' } })
);
show(
	'get_thread ambiguous/unknown',
	await client.callTool({ name: 'get_thread', arguments: { thread: 'zzz-no-such-thread' } }),
	400
);

// Web paper (no PDF) if one exists
const webSearch = await client.callTool({ name: 'search_papers', arguments: { limit: 100 } });
const webPaper = JSON.parse(webSearch.content[0].text).papers.find((p) =>
	p.arxivId.startsWith('web-')
);
if (webPaper) {
	show(
		`get_paper web paper ${webPaper.arxivId}`,
		await client.callTool({ name: 'get_paper', arguments: { paper: webPaper.arxivId } })
	);
}

await client.close();
console.log('\nSmoke test complete.');
