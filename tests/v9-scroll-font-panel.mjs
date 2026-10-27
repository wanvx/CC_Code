// v1.5 验收：① 补全弹窗出现时编辑区绝对不动 ② 孤立点击不会把面板顶出来
//              ③ 面板开合时正在编辑的那一行不动 ④ 代码字体可切换且两层始终对齐
import { chromium } from 'playwright';

const URL0 = process.env.PC_URL || 'http://localhost:8341/';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('ok   ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 412, height: 915 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 160)); });
await p.goto(URL0, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__pc && !!window.__pc.editor, null, { timeout: 90000 });
await p.waitForTimeout(500);

// ── 准备一个能滚动的长文件 ──
const CODE = Array.from({ length: 120 }, (_, i) => (i % 10 === 0 ? '' : '    ') + 'int value' + i + ' = ' + i + ' * 2;').join('\n') + '\n\nvoid f() {\n    \n}\n';
await p.evaluate((c) => {
  const pc = window.__pc;
  pc.state.vfs.write('scroll.cpp', c);
  pc.renderTree();
  pc.openFile('scroll.cpp');
  pc.editor.hideAc();
}, CODE);
await p.waitForTimeout(400);

const snap = () => p.evaluate(() => {
  const ed = window.__pc.editor, ta = ed.ta;
  const line = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
  const row = document.querySelectorAll('#hl .cl')[line];
  const ac = document.querySelector('#ac');
  const host = document.querySelector('#editor-body').getBoundingClientRect();
  const acR = ac.getBoundingClientRect();
  return {
    scrollTop: Math.round(ta.scrollTop),
    line,
    rowTop: row ? Math.round(row.getBoundingClientRect().top) : -1,
    caretY: Math.round(ed.caretScreenY()),
    acOpen: ed.acOpen,
    acTop: Math.round(acR.top),
    acInside: acR.top >= host.top - 2 && acR.bottom <= host.bottom + 2,
    panelCollapsed: window.__pc.isPanelCollapsed(),
    sysScroll: Math.round(window.scrollY),
    docScroll: Math.round(document.documentElement.scrollTop)
  };
});

// 把光标放到第 n 行，并把该行滚到视口中间
const gotoLine = async (n, center) => {
  await p.evaluate(({ n, center }) => {
    const ed = window.__pc.editor, ta = ed.ta;
    ed.hideAc();
    ta.focus();
    const lines = ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < n; i++) pos += lines[i].length + 1;
    ta.setSelectionRange(pos + lines[n].length, pos + lines[n].length);
    const lh = ed.lineHeight;
    ta.scrollTop = Math.max(0, n * lh - (center ? Math.round(ta.clientHeight / 2) : 0));
    ed.syncScroll();
  }, { n, center });
  await p.waitForTimeout(200);
};

// ── ① 弹窗出现时编辑区不动 ──
console.log('── ① 补全弹窗不带动编辑区');
await gotoLine(60, true);
const a0 = await snap();
ok('初始没有弹窗', !a0.acOpen);
await p.keyboard.type('pr');
await p.waitForTimeout(400);
const a1 = await snap();
ok('补全弹窗已弹出', a1.acOpen && a1.acTop > 0, JSON.stringify({ acTop: a1.acTop }));
ok('滚动位置没动', a1.scrollTop === a0.scrollTop, a0.scrollTop + ' → ' + a1.scrollTop);
ok('编辑中的那一行没动', a1.rowTop === a0.rowTop, a0.rowTop + ' → ' + a1.rowTop);
ok('光标行屏幕位置没动', Math.abs(a1.caretY - a0.caretY) <= 1, a0.caretY + ' → ' + a1.caretY);
ok('弹窗在编辑区内', a1.acInside);
ok('页面没有整体滚动', a1.sysScroll === 0 && a1.docScroll === 0);

// 继续打字：弹窗实时更新，画面仍然不动
await p.keyboard.type('i');
await p.waitForTimeout(300);
const a2 = await snap();
ok('连续输入后滚动仍不变', a2.scrollTop === a0.scrollTop && a2.rowTop === a0.rowTop,
  'scroll ' + a2.scrollTop + ' row ' + a2.rowTop);
await p.keyboard.press('Escape');
await p.waitForTimeout(200);
const a3 = await snap();
ok('收起弹窗后滚动仍不变', a3.scrollTop === a0.scrollTop && a3.rowTop === a0.rowTop && !a3.acOpen);
// 清掉输入的字符
await p.keyboard.press('Backspace');
await p.keyboard.press('Backspace');

// ── ② 孤立点击不会展开面板 ──
console.log('── ② 孤立点击（无按下动作）被丢弃');
await p.evaluate(() => window.__pc.setPanelCollapsed(true, false));
const c0 = await snap();
ok('面板已收起', c0.panelCollapsed);
const orphan = await p.evaluate(() => {
  // 模拟设备重连时补发的 click：只有 click，没有 pointerdown
  document.querySelector('.panel-tab[data-tab="stdin"]').click();
  document.querySelector('#panel-toggle').click();
  return window.__pc.isPanelCollapsed();
});
ok('孤立点击没能展开面板', orphan === true, 'collapsed=' + orphan);
const orphanRun = await p.evaluate(() => {
  const before = window.__pc.isPanelCollapsed();
  document.querySelector('#btn-run').click();
  return { before, after: window.__pc.isPanelCollapsed() };
});
ok('孤立点击「运行」不会跑起来', orphanRun.after === true, JSON.stringify(orphanRun));

// 真实点按仍然有效
await p.locator('.panel-tab[data-tab="stdin"]').click();
await p.waitForTimeout(250);
ok('真实点按可以展开面板', (await snap()).panelCollapsed === false);
ok('真实点按后仍是输入页', await p.evaluate(() => document.querySelector('.panel-tab[data-tab="stdin"]').classList.contains('active')));

// ── ③ 面板开合时正在编辑的那一行不动 ──
console.log('── ③ 面板开合不带动代码');
await p.evaluate(() => window.__pc.setPanelCollapsed(false, false));
await gotoLine(60, true);
const b0 = await snap();
await p.locator('#panel-toggle').click();
await p.waitForTimeout(300);
const b1 = await snap();
ok('面板已收起', b1.panelCollapsed);
ok('收起面板后光标行原地不动', Math.abs(b1.caretY - b0.caretY) <= 2, b0.caretY + ' → ' + b1.caretY);
await p.locator('#panel-toggle').click();
await p.waitForTimeout(300);
const b2 = await snap();
ok('展开面板后光标行原地不动', Math.abs(b2.caretY - b0.caretY) <= 2, b0.caretY + ' → ' + b2.caretY);
ok('面板开合状态被记住', await p.evaluate(() => JSON.parse(localStorage.getItem('pocketcode.settings.v2')).panelCollapsed === false));

// ── ④ 字体 ──
console.log('── ④ 代码字体');
const fonts = await p.evaluate(() => {
  window.__pc.settingsModal();
  return [...document.querySelectorAll('#seg-font button')].map((b) => ({ id: b.dataset.v, name: b.textContent.trim() }));
});
ok('设置里至少有三种字体可选', fonts.length >= 3, JSON.stringify(fonts.map((f) => f.name)));
await p.locator('#seg-font button[data-v="jetbrains"]').click();
await p.waitForTimeout(600);
const f1 = await p.evaluate(() => {
  const ta = document.querySelector('#ta'), hl = document.querySelector('#hl');
  const badge = getComputedStyle(document.querySelector('#hl .ln'));
  return {
    ta: getComputedStyle(ta).fontFamily,
    hl: getComputedStyle(hl).fontFamily,
    lnW: Math.round(document.querySelector('#hl .ln').getBoundingClientRect().width),
    lh: Math.round(document.querySelector('#hl .cl').getBoundingClientRect().height),
    cssLh: Math.round(parseFloat(badge.lineHeight)),
    loaded: document.fonts ? document.fonts.check('13px "JetBrains Mono"') : true
  };
});
ok('代码字体已切到 JetBrains Mono', /JetBrains Mono/.test(f1.ta), f1.ta.slice(0, 40));
ok('高亮层与输入层用同一字体', f1.ta === f1.hl);
ok('字体文件真的加载了', f1.loaded !== false);
ok('行高没被字体带偏', f1.lh === f1.cssLh, f1.lh + ' vs ' + f1.cssLh);

await p.locator('#seg-font button[data-v="sourcecode"]').click();
await p.waitForTimeout(500);
ok('可切到 Source Code Pro', /Source Code Pro/.test(await p.evaluate(() => getComputedStyle(document.querySelector('#ta')).fontFamily)));

// 字体持久化
await p.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('pocketcode.settings.v2'));
  window.__fontSaved = s.fontFamily;
});
ok('字体选择已保存', (await p.evaluate(() => window.__fontSaved)) === 'sourcecode');

// 行号与代码仍然对齐（不因为换字体错位）
const align = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('#hl .cl')].slice(0, 40);
  const hs = new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height)));
  const first = rows[0];
  const lnR = first.querySelector('.ln').getBoundingClientRect();
  const ltR = first.querySelector('.lt').getBoundingClientRect();
  const ta = document.querySelector('#ta');
  const cs = getComputedStyle(ta);
  return { heights: [...hs], gap: Math.round(ltR.left - lnR.right), padLeft: Math.round(parseFloat(cs.paddingLeft)), padRight: 0 };
});
ok('换字体后每行高度一致', align.heights.length === 1, JSON.stringify(align.heights));

// 回到默认字体并关掉设置
await p.locator('#seg-font button[data-v="system"]').click();
await p.locator('#m-close').click();
await p.waitForTimeout(300);

// 流畅度见 test/v10-perf.mjs（需要干净的页面计时，单独跑）

ok('无控制台报错', errs.length === 0, errs.slice(0, 3).join(' | '));

await b.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
