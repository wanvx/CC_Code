// v1.2 验收：面板内 stdin 输入 / 补全可关闭 / 关于与更新
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:8341/';
const SHOT = new URL('../shots/', import.meta.url).pathname.replace(/^\//, '');
fs.mkdirSync(SHOT, { recursive: true });

const errors = [];
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  localStorage.clear();
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);

// 1. 输入框存在且可用
log('stdin pane =', await page.locator('#stdin-pane #stdin-ta').count());
await page.locator('.panel-tab[data-tab="stdin"]').click();
await page.waitForTimeout(200);
log('stdin tab title =', await page.locator('.panel-tab[data-tab="stdin"]').getAttribute('title'));

const CODE = '#include <cstdio>\n\nint main() {\n    int a, b;\n    if (scanf("%d %d", &a, &b) != 2) return 1;\n    printf("%d\\n", a + b);\n    return 0;\n}\n';
await page.evaluate((c) => window.__pc.editor.setValue(c, true), CODE);
await page.waitForTimeout(200);

// 2. 直接在主界面输入并在运行按钮喂进去
await page.locator('#stdin-ta').fill('3 4');
await page.waitForTimeout(150);
log('tab title after fill =', await page.locator('.panel-tab[data-tab="stdin"]').getAttribute('title'));
await page.locator('#btn-run').click();
await page.waitForFunction(() => /运行完成|编译失败|出错/.test(document.querySelector('#st-status').textContent), null, { timeout: 120000 });
await page.waitForTimeout(300);
const term = await page.locator('#terminal').innerText();
log('terminal =', JSON.stringify(term));
log('PASS stdout 7 =', /(^|\n)7(\n|$)/.test(term));

// 3. 输入跟文件走：新建另一个文件后输入框应为空
await page.evaluate(() => {
  window.__pc.state.vfs.createFile('', 'other.cpp', '');
  window.__pc.renderTree();
  window.__pc.openFile('other.cpp');
});
await page.waitForTimeout(250);
await page.locator('.panel-tab[data-tab="stdin"]').click();
await page.waitForTimeout(200);
log('other stdin empty =', (await page.locator('#stdin-ta').inputValue()) === '');
await page.locator('#stdin-ta').fill('9 9');
await page.waitForTimeout(200);

await page.evaluate(() => window.__pc.openFile('main.cpp'));
await page.waitForTimeout(250);
log('back to main stdin =', JSON.stringify(await page.locator('#stdin-ta').inputValue()));

// 4. 补全：左右键关闭 / 上下越界关闭 / ✕ 按钮关闭
const acOpen = async () => !(await page.locator('#ac').evaluate((el) => el.classList.contains('hidden')));
const typeFresh = async (txt) => {
  await page.evaluate((t) => {
    const ed = window.__pc.editor;
    ed.setValue(t, true);
    ed.ta.focus();
    ed.ta.setSelectionRange(t.length, t.length);
    ed.updateAutocomplete();
  }, txt);
  await page.waitForTimeout(450);
};

await typeFresh('int pri');
log('ac open after typing =', await acOpen());
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(200);
log('ac closed by ArrowLeft =', !(await acOpen()));
log('caret moved left =', await page.evaluate(() => window.__pc.editor.ta.selectionStart === 6));

await typeFresh('int pri');
log('ac open again =', await acOpen());
await page.keyboard.press('ArrowUp');   // 已在第一项，再上 => 关闭
await page.waitForTimeout(200);
log('ac closed by ArrowUp at top =', !(await acOpen()));

await typeFresh('int pri');
const closeVisible = await page.locator('#ac .ac-close').isVisible();
log('ac close button visible =', closeVisible);
if (closeVisible) {
  await page.locator('#ac .ac-close').click();
  await page.waitForTimeout(200);
  log('ac closed by button =', !(await acOpen()));
}

await page.evaluate((c) => { window.__pc.editor.setValue(c, true); }, CODE);
await page.waitForTimeout(200);

await page.screenshot({ path: SHOT + 'v3-01-stdin.png' });

// 7. 设置里的关于区
await page.evaluate(() => window.__pc.settingsModal());
await page.waitForTimeout(400);
log('github link =', await page.locator('#m-github').innerText());
log('author link =', await page.locator('#m-author').innerText());
log('check update btn =', await page.locator('#m-check-update').count());
log('appInfo =', JSON.stringify(await page.evaluate(() => window.__pc.appInfo)));
await page.locator('.modal-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
await page.waitForTimeout(300);
await page.screenshot({ path: SHOT + 'v3-02-about.png' });

log('\nERRORS:', errors.length ? errors : 'none');
await browser.close();
