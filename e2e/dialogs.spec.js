'use strict';
/* Dialogs must close without relying on form submission, which a sandboxed iframe
   without allow-forms blocks. */
const { test, expect, openApp } = require('./fixtures');

const HOSTS = [
  { name: 'top-level page' },
  { name: 'sandboxed iframe (allow-scripts)', frame: true, sandbox: 'allow-scripts' },
  { name: 'sandboxed iframe (allow-scripts allow-same-origin)', frame: true, sandbox: 'allow-scripts allow-same-origin' }
];

const isOpen = (f, id) => f.locator(id).evaluate((d) => d.open);

/* how each way of closing is performed; backdrop = the dimmed area outside the dialog box */
const CLOSERS = {
  Done: (page, f) => f.click('#settingsDlg [data-close="ok"]'),
  '✕': (page, f) => f.click('#settingsDlg header [data-close="cancel"]'),
  Esc: (page) => page.keyboard.press('Escape'),
  backdrop: (page) => page.mouse.click(6, 6),
  Cancel: (page, f) => f.click('#cfNo'),
  Continue: (page, f) => f.click('#cfYes')
};

test('the sandboxed iframes really are sandboxed: no allow-forms, form submission blocked', async ({ page }) => {
  for (const host of HOSTS.filter((h) => h.frame)) {
    const f = await openApp(page, host);
    expect(await page.locator('#app').getAttribute('sandbox')).toBe(host.sandbox);
    if (!host.sandbox.includes('allow-same-origin')) expect(await f.evaluate(() => self.origin)).toBe('null');
    const blocked = page.waitForEvent('console', (m) => /Blocked form submission/.test(m.text()));
    await f.evaluate(() => { const fm = document.createElement('form'); fm.method = 'dialog'; document.body.appendChild(fm); fm.requestSubmit(); fm.remove(); });
    await blocked;
  }
});

for (const host of HOSTS) {
  test.describe(host.name, () => {
    for (const how of ['Done', '✕', 'Esc', 'backdrop']) {
      test(`Printer settings closes via ${how}`, async ({ page }) => {
        const f = await openApp(page, host);
        await f.click('#btnSettings');
        await expect.poll(() => isOpen(f, '#settingsDlg')).toBe(true);
        /* clicking inside the dialog must not close it */
        await f.click('#setTitle');
        expect(await isOpen(f, '#settingsDlg')).toBe(true);
        await CLOSERS[how](page, f);
        await expect.poll(() => isOpen(f, '#settingsDlg')).toBe(false);
        /* changes made in the dialog are applied when it closes */
        await f.click('#btnSettings');
        await f.fill('#settingsBody [data-p="name"]', 'Renamed');
        await CLOSERS[how](page, f);
        await expect.poll(() => isOpen(f, '#settingsDlg')).toBe(false);
        await expect(f.locator('#profileSel option:checked')).toHaveText('Renamed');
        expect(page.errors).toEqual([]);
      });
    }

    for (const how of ['Cancel', 'Continue', 'Esc', 'backdrop']) {
      test(`confirm dialog closes via ${how} and leaves Printer settings open`, async ({ page }) => {
        const f = await openApp(page, host);
        await f.click('#btnSettings');
        await f.fill('#settingsBody [data-p="name"]', 'Edited');
        await f.click('#profRestore');
        await expect.poll(() => isOpen(f, '#confirmDlg')).toBe(true);
        await CLOSERS[how](page, f);
        await expect.poll(() => isOpen(f, '#confirmDlg')).toBe(false);
        expect(await isOpen(f, '#settingsDlg')).toBe(true);
        /* only Continue confirms: it restores the shipped preset name */
        await expect(f.locator('#profileSel option:checked')).toHaveText(how === 'Continue' ? 'S140 Stitch' : 'Edited');
        await f.click('#settingsDlg [data-close="ok"]');
        await expect.poll(() => isOpen(f, '#settingsDlg')).toBe(false);
        expect(page.errors).toEqual([]);
      });
    }
  });
}
