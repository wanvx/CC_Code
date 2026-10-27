// 端到端验证（v1.3）：手机视口打开 IDE → 高亮 → 补全 → 签名 → 缩放 → 编译运行 → 错误检测
import { chromium, devices } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8341';
const SHOT = new URL('../shots/', import.meta.url).pathname.replace(/^\//, '');
fs.mkdirSync(SHOT, { recursive: true });
const shot = (n) => SHOT + 'e2e-' + n + '.png';

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const ok = (name, cond, extra) => console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra == null ? '' : '  → ' + extra));
const st = () => page.locator('#st-status').textContent();
const waitRun = () => page.waitForFunction(
  () => /退出码|编译失败|出错/.test(document.querySelector('#st-status').textContent),
  null, { timeout: 180000, polling: 300 }
);

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.screenshot({ path: shot('01-home') });

// 1. 造一个自己的文件（v1.1 起不再内置示例工程）
const CODE = '#include <cstdio>\n\nint main() {\n    for (int i = 1; i <= 100; i++) {\n        if (i % 10 == 0) printf("%d\\n", i);\n    }\n    return 0;\n}\n';
await page.evaluate((c) => {
  window.__pc.state.vfs.write('main.cpp', c);
  window.__pc.renderTree();
  window.__pc.openFile('main.cpp');
}, CODE);
await page.waitForTimeout(400);

const lines = await page.locator('#hl-code .cl').count();
const tokens = await page.locator('#hl-code .tk-key, #hl-code .tk-type, #hl-code .tk-str').count();
ok('语法高亮生效', lines >= 8 && tokens >= 4, 'lines=' + lines + ' tokens=' + tokens);
ok('缩进参考线已画', (await page.locator('#hl-code .gi').count()) > 0);

// 2. 补全：Tab 确认
await page.evaluate(() => {
  const ed = window.__pc.editor;
  ed.ta.focus();
  ed.ta.setSelectionRange(0, 0);
});
await page.keyboard.type('pri', { delay: 60 });
await page.waitForTimeout(400);
const acVisible = await page.locator('#ac:not(.hidden)').count();
const acItems = await page.locator('.ac-item').count();
ok('自动补全触发', acVisible === 1 && acItems >= 3, 'items=' + acItems);
await page.screenshot({ path: shot('02-autocomplete') });
await page.keyboard.press('Tab');
ok('Tab 确认插入 printf', (await page.locator('#ta').inputValue()).startsWith('printf'));
for (let i = 0; i < 15; i++) {
  const v = await page.locator('#ta').inputValue();
  if (v.startsWith('#include')) break;
  await page.keyboard.press('Control+z');
}
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok('撤销恢复到原文', (await page.locator('#ta').inputValue()).startsWith('#include'));

// 3. Ctrl+滚轮缩放
const fs0 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--code-fs'));
await page.locator('#code-wrap').hover();
await page.keyboard.down('Control');
await page.mouse.wheel(0, -400);
await page.keyboard.up('Control');
await page.waitForTimeout(200);
const fs1 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--code-fs'));
ok('Ctrl+滚轮缩放', parseFloat(fs1) > parseFloat(fs0), fs0.trim() + ' → ' + fs1.trim());
await page.screenshot({ path: shot('03-zoom') });

// 4. 签名提示
await page.click('#code-wrap');
await page.evaluate(() => { const ed = window.__pc.editor; ed.ta.setSelectionRange(0, 0); });
await page.keyboard.type('printf(', { delay: 40 });
await page.waitForTimeout(350);
ok('参数签名提示', (await page.locator('#sig:not(.hidden)').count()) === 1, await page.locator('#sig').innerText().catch(() => ''));
await page.screenshot({ path: shot('04-sighelp') });
for (let i = 0; i < 15; i++) {
  const v = await page.locator('#ta').inputValue();
  if (v.startsWith('#include')) break;
  await page.keyboard.press('Control+z');
}
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// 5. 真实编译运行（C++）
await page.click('#btn-run');
await waitRun();
const term = await page.locator('#terminal').innerText();
ok('编译运行输出正确', /(^|\n)100(\n|$)/.test(term) && /退出码 0/.test(await st()), JSON.stringify(term.slice(-40)));
ok('运行后停在输出页', (await page.evaluate(() => document.querySelector('.pane.active').id)) === 'terminal');
await page.screenshot({ path: shot('05-run') });

// 6. 编译错误 → 问题页
await page.click('#code-wrap');
await page.keyboard.press('Control+End');
await page.keyboard.type('\nint x = ;', { delay: 30 });
await page.click('#btn-run');
await waitRun();
const st3 = await st();
ok('编译失败被识别', /失败/.test(st3), st3);
ok('问题页自动切换', (await page.evaluate(() => document.querySelector('.pane.active').id)) === 'problems');
const probs = await page.locator('.prob').count();
ok('问题列表有条目', probs > 0, 'count=' + probs);
await page.screenshot({ path: shot('06-problems') });

console.log('\nPAGE ERRORS:', errors.length ? errors : 'none');
console.log(errors.length ? 'E2E DONE (with page errors)' : 'ALL PASSED');
await browser.close();
