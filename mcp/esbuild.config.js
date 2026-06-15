// Bundle the MCP server into a single self-contained CJS file with a shebang, so
// `npx mermaid-node-editor-flows` runs with no resolution surprises. Bundles the
// reused parser/editor/analysis layer + the MCP SDK + zod.
const esbuild = require('esbuild');
const { chmodSync } = require('node:fs');

esbuild
  .build({
    entryPoints: ['src/server.ts'],
    outfile: 'dist/server.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'info',
  })
  .then(() => {
    chmodSync('dist/server.js', 0o755);
    console.log('[esbuild] mcp server bundled -> dist/server.js');
  })
  .catch(() => process.exit(1));
