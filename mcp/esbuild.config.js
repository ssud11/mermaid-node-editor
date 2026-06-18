// Bundle the MCP server into a single self-contained CJS file with a shebang, so
// `npx mermaid-node-editor-flows` runs with no resolution surprises. Bundles the
// reused parser/editor/analysis layer + the MCP SDK + zod.
const esbuild = require('esbuild');
const path = require('node:path');
const { chmodSync } = require('node:fs');

// The shared src/parser.ts loads the core via '../../mermaid-node-core/src/index.js'
// (a path relative to the tsc output, not the source directory). Remap it to the
// actual absolute path so esbuild can bundle it correctly.
const coreIndexPath = path.resolve(__dirname, '../mermaid-node-core/src/index.js');
const coreResolvePlugin = {
  name: 'core-remap',
  setup(build) {
    build.onResolve({ filter: /mermaid-node-core/ }, () => ({
      path: coreIndexPath,
    }));
  },
};

esbuild
  .build({
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/server.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'info',
    // Inline mermaid-node-core via the static-require path in src/parser.ts (the
    // bundled server is self-contained; the core source tree isn't shipped).
    define: { __MNE_BUNDLE__: 'true' },
    plugins: [coreResolvePlugin],
  })
  .then(() => {
    chmodSync('dist/server.js', 0o755);
    console.log('[esbuild] mcp server bundled -> dist/server.js');
  })
  .catch(() => process.exit(1));
