/* Serves the built app at a local origin. The page keeps its cdnjs <script> tag; the request
   is answered with the identical r128 build from node_modules/three, so tests run offline.
   The web font is blocked so text rendering does not depend on the network. */
'use strict';
const base = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'http://localhost:4173';
const THREE_JS = path.join(ROOT, 'node_modules', 'three', 'build', 'three.min.js');

/* a page that embeds the app in an iframe with the given sandbox flags */
function framePage(sandbox) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe id="app" src="/goboslice.html" ${sandbox == null ? '' : `sandbox="${sandbox}"`}></iframe></body></html>`;
}

const test = base.test.extend({
  context: async ({ context }, use) => {
    await context.route('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', (r) =>
      r.fulfill({ path: THREE_JS, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' } }));
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort());
    await context.route(`${ORIGIN}/**`, (r) => {
      const u = new URL(r.request().url());
      if (u.pathname === '/goboslice.html') return r.fulfill({ path: path.join(ROOT, 'dist', 'goboslice.html'), contentType: 'text/html; charset=utf-8' });
      if (u.pathname === '/frame.html') return r.fulfill({ body: framePage(u.searchParams.get('sandbox')), contentType: 'text/html; charset=utf-8' });
      return r.fulfill({ status: 404, body: 'not found' });
    });
    await use(context);
  },
  page: async ({ page }, use) => {
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED|ERR_BLOCKED/.test(m.text())) page.errors.push(m.text()); });
    await use(page);
  }
});

/* Opens the app and waits until the 3D view is up. Returns the frame the app runs in. */
async function openApp(page, { sandbox, frame = false } = {}) {
  if (!frame) {
    await page.goto(`${ORIGIN}/goboslice.html`);
    await page.waitForFunction(() => typeof renderer !== 'undefined' && renderer && typeof THREE !== 'undefined');
    return page.mainFrame();
  }
  await page.goto(`${ORIGIN}/frame.html${sandbox == null ? '' : '?sandbox=' + encodeURIComponent(sandbox)}`);
  const f = page.frameLocator('#app');
  await f.locator('#btnSlice').waitFor();
  const fr = page.frames().find((x) => x.url().endsWith('/goboslice.html'));
  await fr.waitForFunction(() => typeof renderer !== 'undefined' && renderer);
  return fr;
}

module.exports = { test, expect: base.expect, openApp, ORIGIN, ROOT };
