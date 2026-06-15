// stdio entry point. Kept separate from server.ts so the server (createServer)
// is a side-effect-free import for the contract tests; this file owns the
// transport binding and process lifecycle. esbuild bundles this → dist/server.js.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server';

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdio server: stay alive on the transport; logging to stderr only (stdout is the protocol).
  process.stderr.write('mermaid-node-editor-flows MCP server running on stdio\n');
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
