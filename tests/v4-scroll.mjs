// 回车 / 撤销后编辑器滚动不跳变（含强制模拟 WebView 的异常滚动）
import { chromium } from 'playwright';

const BASE = 'http://localhost:8341/';
const shot = 'shots/';
let fail = 0;
const log = (k, ok, extra) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + k + (extra != null ? '  → ' + extra : ''));
  if (!ok) fail++;
};

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);

const CODE = Array.from({ length: 200 }, (_, i) => `int a${i} = ${i};`).join('\n');
const setup = async (lineNo) => {
  await page.evaluate(({ c, n }) => {
    const ed = window.__pc.editor;
    ed.setValue(c, true);
    ed.ta.focus();
    const pos = ed.ta.value.indexOf('int a' + n + ' = ' + n + ';') + ('int a' + n + ' = ' + n).length;
    ed.ta.setSelectionRange(pos, pos);
    ed.ensureCaretVisible();
    // 再往下滚两屏，让光标上方留出空间（模拟用户翻到中间）
    ed.ta.scrollTop = Math.min(ed.ta.scrollHeight, ed.ta.scrollTop + 120);
    ed.syncScroll();
  }, { c: CODE, n: lineNo });
  await page.waitForTimeout(150);
};

const state = () => page.evaluate(() => {
  const ed = window.__pc.editor;
  const v = ed.ta.value;
  let line = 0;
  for (let i = ed.ta.selectionStart - 1; i >= 0; i--) if (v.charCodeAt(i) === 10) line++;
  const y = 8 + line * ed.lineHeight;
  const top = ed.ta.scrollTop, h = ed.ta.clientHeight;
  return {
    scrollTop: top, viewH: h, caretLine: line + 1, caretY: y,
    caretVisible: y >= top - 1 && y + ed.lineHeight <= top + h + 1,
    wrapY: document.querySelector('#code-wrap').scrollTop,
    maxScroll: ed.ta.scrollHeight - h,
  };
});

// 1. 正常回车：滚动只做必要调整，光标仍可见
await setup(100);
let before = await state();
await page.keyboard.press('Enter');
await page.waitForTimeout(250);
let after = await state();
log('回车后光标可见', after.caretVisible, JSON.stringify(after));
log('回车后未跳到末尾', after.scrollTop < after.maxScroll - 5, 'top=' + after.scrollTop + ' max=' + after.maxScroll);
log('回车后滚动位移很小', Math.abs(after.scrollTop - before.scrollTop) <= 40, before.scrollTop + ' → ' + after.scrollTop);

// 2. 连续回车 6 次
for (let i = 0; i < 6; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(80); }
after = await state();
log('连按回车后光标仍可见', after.caretVisible, JSON.stringify(after));
log('连按回车后未跳到末尾', after.scrollTop < after.maxScroll - 5, 'top=' + after.scrollTop);

// 3. Ctrl+Z 撤销回车
for (let i = 0; i < 6; i++) { await page.keyboard.press('Control+z'); await page.waitForTimeout(90); }
await page.waitForTimeout(250);
after = await state();
log('撤销后光标可见', after.caretVisible, JSON.stringify(after));
log('撤销后未跳到顶部', after.scrollTop > 0, 'top=' + after.scrollTop);
log('撤销后回到原位置附近', Math.abs(after.scrollTop - before.scrollTop) <= 60, before.scrollTop + ' → ' + after.scrollTop);

// 4. 符号后回车（含自动配对）
await setup(60);
await page.evaluate(() => {
  const ed = window.__pc.editor;
  const v = ed.ta.value, lineStart = v.lastIndexOf('\n', ed.ta.selectionStart - 1) + 1;
  ed.ta.setSelectionRange(v.indexOf('\n', ed.ta.selectionStart), v.indexOf('\n', ed.ta.selectionStart));
  void lineStart;
  ed.insert('{');
});
await page.waitForTimeout(150);
before = await state();
await page.keyboard.press('Enter');
await page.waitForTimeout(250);
after = await state();
log('符号后回车光标可见', after.caretVisible, JSON.stringify(after));
log('符号后回车未跳到末尾', after.scrollTop < after.maxScroll - 5, 'top=' + after.scrollTop);

// 5. 强制模拟 WebView 的异常滚动：回车时把 textarea 滚到末尾
await setup(100);
await page.evaluate(() => {
  const ed = window.__pc.editor;
  ed.ta.addEventListener('input', () => { ed.ta.scrollTop = ed.ta.scrollHeight; }, { once: true });
});
before = await state();
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
after = await state();
log('被滚到末尾时自动拉回光标', after.caretVisible, JSON.stringify(after));
log('拉回后不是末尾', after.scrollTop < after.maxScroll - 5, 'top=' + after.scrollTop);

// 6. 强制模拟撤销时被滚到顶部
await page.evaluate(() => {
  const ed = window.__pc.editor;
  ed.ta.addEventListener('input', () => { ed.ta.scrollTop = 0; }, { once: true });
});
await page.keyboard.press('Backspace');
await page.waitForTimeout(300);
after = await state();
log('被滚到顶部时自动拉回光标', after.caretVisible, JSON.stringify(after));

// 7. 外层容器被滚动时也不位移
await page.evaluate(() => {
  const w = document.querySelector('#code-wrap');
  w.scrollTop = 180;   // overflow:clip 下应当无效
  window.__pc.editor.syncScroll();
});
const wrapY = await page.evaluate(() => document.querySelector('#code-wrap').scrollTop);
log('代码区外层不可被滚动', wrapY === 0, 'wrapY=' + wrapY);

await page.screenshot({ path: shot + 'v4-scroll.png' });
console.log('\nERRORS:', errs.length ? errs : 'none');
console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
await browser.close();
process.exit(fail === 0 ? 0 : 1);
