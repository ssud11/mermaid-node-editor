// IT-1 headless runtime smoke entrypoint (runs in Node, not the extension host).
// Downloads a VS Code build and launches it with this extension loaded, then runs
// ./suite/index.js inside the extension host.
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  // VS Code's Electron binary honors ELECTRON_RUN_AS_NODE — it's set inside a
  // VS Code host, which makes the downloaded build launch as plain
  // Node (ignoring every VS Code flag -> "bad option" + exit 9). Strip it so the
  // test host launches as VS Code. Harmless where it isn't set (e.g. CI).
  delete process.env.ELECTRON_RUN_AS_NODE;
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index.js');
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // --disable-extensions disables OTHER installed extensions; the one under
      // development is still loaded. --no-sandbox/--disable-gpu for headless CI/xvfb.
      launchArgs: ['--disable-extensions', '--disable-gpu', '--no-sandbox'],
    });
  } catch (err) {
    console.error('Integration smoke failed:', err);
    process.exit(1);
  }
}

main();
