// v1.3 验收：补全弹窗跟随代码 / 输入输出同层 tab / 缩进参考线
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:8341/';
const SHOT = new URL('../shots/', import.meta.url).pathname.replace(/^\//, '');
fs.mkdirSync(SHOT, { recursive: true });

const errors = [];
const log = (...a) => console.log(...a);
const ok = (name, cond, extra) => log((cond ? 'PASS ' : 'FAIL ') + name + (extra == null ? '' : '  → ' + extra));

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(700);

// ── 1. 面板：输出 / 输入 / 问题 同一层 ──
const tabs = await page.$$eval('.panel-tab', (els) => els.map((e) => e.dataset.tab));
ok('三 tab 同层', JSON.stringify(tabs) === '["output","stdin","problems"]', tabs.join(','));
ok('旧的下层输入条已移除', (await page.locator('#stdin-box').count()) === 0);
ok('输入在面板内', (await page.locator('#panel #stdin-pane #stdin-ta').count()) === 1);

const activePane = () => page.evaluate(() => document.querySelector('.pane.active').id);
ok('默认输出页', (await activePane()) === 'terminal');

await page.locator('.panel-tab[data-tab="stdin"]').click();
await page.waitForTimeout(250);
ok('点输入切到 stdin', (await activePane()) === 'stdin-pane');

// 输入内容 → 运行 → 自动回输出页
const CODE = '#include <cstdio>\n\nint main() {\n    int a, b;\n    if (scanf("%d %d", &a, &b) != 2) return 1;\n    printf("%d\\n", a + b);\n    return 0;\n}\n';
await page.evaluate((c) => window.__pc.editor.setValue(c, true), CODE);
await page.waitForTimeout(150);
await page.locator('.panel-tab[data-tab="stdin"]').click();
await page.waitForTimeout(150);
await page.locator('#stdin-ta').fill('3 4');
await page.waitForTimeout(200);
ok('输入 tab 有内容标记', !(await page.locator('#stdin-dot').evaluate((el) => el.classList.contains('hidden'))));
await page.locator('#btn-run').click();
await page.waitForFunction(() => /运行完成|编译失败|出错/.test(document.querySelector('#st-status').textContent), null, { timeout: 120000 });
await page.waitForTimeout(400);
ok('运行后自动回输出页', (await activePane()) === 'terminal');
const term = await page.locator('#terminal').innerText();
ok('stdin 被喂进程序', /(^|\n)7(\n|$)/.test(term), JSON.stringify(term.slice(-60)));

// 清空按钮按当前 tab 生效
await page.locator('.panel-tab[data-tab="stdin"]').click();
await page.waitForTimeout(150);
await page.locator('#btn-clear').click();
await page.waitForTimeout(250);
ok('清空作用于输入框', (await page.locator('#stdin-ta').inputValue()) === '');
ok('输出没被连带清掉', (await page.locator('#terminal').innerText()).length > 0);
await page.screenshot({ path: SHOT + 'v5-01-panel.png' });

// ── 2. 缩进参考线 ──
const GUIDE_CODE = '#include <cstdio>\n\nint main() {\n    if (1) {\n        for (int i = 0; i < 2; i++) {\n            printf("%d\\n", i);\n        }\n    }\n    return 0;\n}\n';
await page.evaluate((c) => window.__pc.editor.setValue(c, true), GUIDE_CODE);
await page.waitForTimeout(250);
const gcount = () => page.evaluate(() => document.querySelectorAll('#hl .gi').length);
ok('默认开启有参考线', (await gcount()) > 0, 'gi=' + (await gcount()));

// 8 空格缩进 = 2 级 → 宽度应是 4 空格缩进（1 级）的两倍
const gw = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#hl .cl')];
  const pick = (prefix) => {
    const r = rows.find((x) => (x.querySelector('.lt').textContent || '').startsWith(prefix));
    const gi = r && r.querySelector('.gi');
    return gi ? gi.getBoundingClientRect().width : 0;
  };
  return { w4: pick('    if'), w8: pick('        for') };
});
ok('缩进 8 空格 → 参考线宽度 2 级', gw.w4 > 0 && Math.abs(gw.w8 / gw.w4 - 2) < 0.08, JSON.stringify(gw));

await page.evaluate(() => window.__pc.editor.setIndentGuides(false));
await page.waitForTimeout(200);
ok('关掉后没有参考线', (await gcount()) === 0);
await page.evaluate(() => window.__pc.editor.setIndentGuides(true));
await page.waitForTimeout(200);
await page.screenshot({ path: SHOT + 'v5-02-guides.png' });

// 设置里的开关真实生效
await page.evaluate(() => window.__pc.settingsModal());
await page.waitForTimeout(350);
await page.locator('#m-guides').click();
await page.waitForTimeout(250);
ok('设置开关关掉参考线', (await gcount()) === 0);
await page.locator('#m-guides').click();
await page.waitForTimeout(250);
ok('设置开关打开参考线', (await gcount()) > 0);
await page.locator('#m-close').click();
await page.waitForTimeout(250);

// ── 3. 补全弹窗跟随代码 ──
const LONG = Array.from({ length: 40 }, (_, i) => 'int v' + i + ' = ' + i + ';').join('\n') + '\n\nvoid f() {\nint pri';
await page.evaluate((t) => {
  const ed = window.__pc.editor;
  ed.setValue(t, true);
  ed.ta.focus();
  ed.ta.setSelectionRange(t.length, t.length);
  ed.updateAutocomplete();
}, LONG);
await page.waitForTimeout(500);

const acOpen = async () => !(await page.locator('#ac').evaluate((el) => el.classList.contains('hidden')));
ok('补全已弹出', await acOpen());

// 光标行相对宿主的理论 top（弹窗应贴在它下方一行，或翻到上方）
const probe = () => page.evaluate(() => {
  const ed = window.__pc.editor, ta = ed.ta, v = ta.value, pos = ta.selectionStart;
  const line = v.slice(0, pos).split('\n').length - 1;
  const padTop = parseFloat(getComputedStyle(ta).paddingTop) || 8;
  const lh = ed.lineHeight;
  const hostR = ed.host.getBoundingClientRect();
  const taR = ta.getBoundingClientRect();
  const acR = document.querySelector('#ac').getBoundingClientRect();
  const caretTop = (taR.top - hostR.top) + padTop + line * lh - ta.scrollTop;
  const delta = Math.round(acR.top - hostR.top - caretTop);
  return {
    line,
    delta,
    ph: Math.round(acR.height),
    anchoredBelow: Math.abs(delta - (lh + 2)) <= 4,
    anchoredAbove: Math.abs(delta + (acR.height + 4)) <= 4,
    insideHost: acR.top >= hostR.top - 6 && acR.bottom <= hostR.bottom + 6 &&
      acR.left >= hostR.left - 6 && acR.right <= hostR.right + 6,
    scrollTop: ta.scrollTop
  };
});
const anchored = (p) => p.anchoredBelow || p.anchoredAbove;

// 把光标行滚到编辑区中间，避免上下边界触发翻转让位置变化混淆断言
const center = await page.evaluate(() => {
  const ed = window.__pc.editor, ta = ed.ta;
  const line = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
  const padTop = parseFloat(getComputedStyle(ta).paddingTop) || 8;
  ta.scrollTop = Math.max(0, padTop + line * ed.lineHeight - ta.clientHeight / 2);
  ed.syncScroll();
  return { line, scrollTop: ta.scrollTop };
});
await page.waitForTimeout(250);
const p0 = await probe();
ok('弹窗贴住光标行', anchored(p0), JSON.stringify(p0) + ' ' + JSON.stringify(center));
ok('弹窗在编辑区内', p0.insideHost);

// 滚动代码：弹窗必须同步位移，且相对光标行的锚定关系不变
await page.evaluate(() => { window.__pc.editor.ta.scrollTop -= 60; });
await page.waitForTimeout(250);
const p1 = await probe();
ok('滚动后仍开', await acOpen());
ok('滚动后仍贴住光标行', anchored(p1) && p1.anchoredBelow === p0.anchoredBelow, 'd0=' + p0.delta + ' d1=' + p1.delta + ' scroll=' + p1.scrollTop);
ok('滚动后仍在编辑区内', p1.insideHost);

await page.evaluate(() => { window.__pc.editor.ta.scrollTop += 120; });
await page.waitForTimeout(250);
const p2 = await probe();
ok('再次滚动仍贴住光标行', anchored(p2), 'd2=' + p2.delta + ' scroll=' + p2.scrollTop);
ok('再次滚动仍在编辑区内', p2.insideHost);

// 弹窗绝不越出编辑区（窗口尺寸变化也算）
await page.setViewportSize({ width: 412, height: 640 });
await page.evaluate(() => window.dispatchEvent(new Event('resize')));
await page.waitForTimeout(300);
const p3 = await probe();
ok('窗口变矮后不越界', p3.insideHost, JSON.stringify(p3));
await page.screenshot({ path: SHOT + 'v5-03-ac.png' });
await page.setViewportSize({ width: 412, height: 915 });
await page.waitForTimeout(200);

await page.evaluate(() => window.__pc.editor.hideAc());
log('\nERRORS:', errors.length ? errors : 'none');
await browser.close();
