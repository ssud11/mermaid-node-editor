// Bundles the extension entry point into dist/extension.js.
// `vscode` is provided by the host at runtime, so it stays external.
//
// Pre-step: ensures the mermaid-node-core PEG grammar is compiled to
// generated-parser.js before esbuild bundles it in. A fresh clone / CI runner
// must run this step before the extension can compile.
const esbuild = require('esbuild');
const { execSync } = require('node:child_process');
const path = require('node:path');

// Build the grammar if the generated file is missing or stale. Using execSync
// so the build fails loudly if the grammar step fails (not silently left stale).
const coreDir = path.join(__dirname, 'mermaid-node-core');
execSync('npm install --prefer-offline --silent 2>/dev/null || npm install', {
  cwd: coreDir,
  stdio: ['ignore', 'ignore', 'pipe'],
});
execSync('node scripts/build-parser.mjs', { cwd: coreDir, stdio: 'inherit' });

const watch = process.argv.includes('--watch');

// In src/parser.ts the core is required via '../../mermaid-node-core/src/index.js'
// — a path relative to the COMPILED tsc output (out/src/ → ../../ = project root).
// At bundle time esbuild resolves from the source file's directory (src/), so
// '../../' goes outside the project. We intercept the resolution with a plugin.
const coreResolvePlugin = {
  name: 'core-remap',
  setup(build) {
    build.onResolve({ filter: /mermaid-node-core/ }, (args) => ({
      path: path.join(coreDir, 'src', 'index.js'),
    }));
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
  // Signals src/parser.ts to take the static-require path so the core-remap plugin
  // INLINES mermaid-node-core (the packaged build excludes its source tree). The
  // runtime parent-dir walk is DCE-dropped from the bundle.
  define: { __MNE_BUNDLE__: 'true' },
  plugins: [coreResolvePlugin],
};

// Phase B (v1.2): the live-preview webview bundle — the real `mermaid` library +
// ELK layout, compiled to a single browser/IIFE file loaded by the preview panel.
// Separate target (browser, not node) and separate output tree (dist/webview/).
/** @type {import('esbuild').BuildOptions} */
const previewOptions = {
  entryPoints: ['src/webview/preview/main.ts'],
  bundle: true,
  outfile: 'dist/webview/preview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: watch,
  minify: !watch,
  // mermaid/its deps probe these globals; pin them for the browser bundle.
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    const previewCtx = await esbuild.context(previewOptions);
    await ctx.watch();
    await previewCtx.watch();
    console.log('[esbuild] watching for changes...');
  } else {
    await esbuild.build(options);
    await esbuild.build(previewOptions);
    console.log('[esbuild] build complete -> dist/extension.js + dist/webview/preview.js');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
