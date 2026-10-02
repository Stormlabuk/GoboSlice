#!/usr/bin/env node
/* Concatenates src/ into the single-file deliverable, dist/goboslice.html.
   No dependencies. Usage:
     node build.js           write dist/goboslice.html
     node build.js --check   exit 1 if dist/goboslice.html is out of date */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist', 'goboslice.html');

/* Order matters: the app files share one script scope and run top to bottom. */
const APP = [
  'util', 'profiles', 'geometry', 'scene', 'parts', 'panel', 'supports', 'magic',
  'slicing', 'output', 'layer-preview', 'islands', 'selftest', 'picking', 'undo', 'input',
  'import', 'settings', 'main'
];

function read(rel) { return fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8'); }

function build() {
  return read('head.html') + read('body.html') +
    '<script>\n' + read('core.js') + APP.map((n) => read(`app/${n}.js`)).join('') +
    '</script>\n</body>\n</html>\n';
}

function main() {
  const html = build();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== html) { console.error('dist/goboslice.html is out of date. Run: npm run build'); process.exit(1); }
    console.log('dist/goboslice.html is up to date.');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, html);
    console.log(`Wrote dist/goboslice.html (${Buffer.byteLength(html)} bytes).`);
  }
}

if (require.main === module) main();
module.exports = { build, APP, OUT };
