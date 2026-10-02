// Browser tests against dist/goboslice.html with the real three.js r128.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'e2e',
  timeout: 240000,
  expect: { timeout: 15000 },
  workers: 2,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    viewport: { width: 1400, height: 860 },
    acceptDownloads: true,
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] }
  }
});
