// Bundles the extension entry point into dist/extension.js.
// `vscode` is provided by the host at runtime, so it stays external.
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

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
