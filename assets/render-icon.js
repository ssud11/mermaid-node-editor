// Rasterize assets/icon.svg -> icon.png (128x128) using the box's chromium via
// playwright-core (no extra tooling). Re-run after editing icon.svg.
//   LIBGL_ALWAYS_SOFTWARE=1 node assets/render-icon.js
const path = require('path');
const { chromium } = require('playwright-core');

const EXEC =
  process.env.PW_CHROMIUM ||
  path.join(process.env.HOME, '.local/share/playwright-chromium-current');

(async () => {
  const browser = await chromium.launch({
    executablePath: EXEC,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb'],
  });
  const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.resolve(__dirname, 'icon.svg'));
  await page.screenshot({
    path: path.resolve(__dirname, '../icon.png'),
    omitBackground: true,
    clip: { x: 0, y: 0, width: 128, height: 128 },
  });
  await browser.close();
  console.log('icon.png written (128x128)');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
