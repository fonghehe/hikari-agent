import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'test-fixture', version: '1.0.0' });
server.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: 'text', text }],
}));
server.registerResource(
  'reference',
  'fixture://reference',
  { mimeType: 'text/plain' },
  async (uri) => ({
    contents: [{ uri: uri.href, text: 'Actual MCP reference content', mimeType: 'text/plain' }],
  }),
);
server.registerPrompt('review', { argsSchema: { subject: z.string() } }, async ({ subject }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `Review ${subject}` } }],
}));
await server.connect(new StdioServerTransport());
