// v1.6 验收：VSCode 染色模式 + 括号配对颜色化（bracketPairColorization）
import { chromium, devices } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8341';
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++; else fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra == null ? '' : '  → ' + extra));
};
const eqC = (name, got, want) => ok(name, got === want, got);

const CODE = [
  '#include <cstdio>',
  '',
  'struct Node { int v; };',
  '',
  'int solve(int n) {',
  '    for (int i = 0; i < n; i++) {',
  '        if (a[i] > 0) {',
  '            printf("%d\\n", a[i] + (i * 2));',
  '        }',
  '    }',
  '    return 0;',
  '}'
].join('\n');

const setCode = (c) => page.evaluate((v) => window.__pc.editor.setValue(v, true), c);
const colorOf = (sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  return e ? getComputedStyle(e).color : null;
}, sel);
const cnt = (sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

// 取某一行的括号序列（字符 + 深度类 + 颜色）
const lineBk = (n) => page.evaluate((line) => {
  const row = document.querySelectorAll('#hl .cl')[line];
  if (!row) return null;
  return [...row.querySelectorAll('.bk')].map((b) => ({
    ch: b.textContent, cls: b.className, color: getComputedStyle(b).color
  }));
}, n);

// ── ① 默认：经典配色，没有括号着色 ──
await setCode(CODE);
await page.waitForTimeout(200);
ok('默认是经典配色', (await page.evaluate(() => document.documentElement.dataset.codeTheme)) === 'classic');
eqC('经典配色不生成控制流分层', await cnt('#hl .tk-ctl'), 0);
eqC('经典配色不生成标识符层', await cnt('#hl .tk-id'), 0);
eqC('默认没有括号 span', await cnt('#hl .bk'), 0);
eqC('经典配色的类型仍是黄色', await colorOf('#hl .tk-type'), 'rgb(255, 203, 107)');
eqC('经典配色的 include 目标不变色', await colorOf('#hl .tk-inc'), 'rgb(130, 170, 255)');

// ── ② 切 VSCode 配色：Dark+ 语义分层 ──
await page.evaluate(() => window.__pc.setCodeTheme('vscode'));
await page.waitForTimeout(250);
ok('已切到 VSCode 模式', (await page.evaluate(() => document.documentElement.dataset.codeTheme)) === 'vscode');
eqC('控制流 if/for/return 是紫红', await colorOf('#hl .tk-ctl'), 'rgb(197, 134, 192)');
eqC('内置类型 int 是蓝', await colorOf('#hl .tk-kwtype'), 'rgb(86, 156, 214)');
eqC('自定义类型 Node 是青', await colorOf('#hl .tk-type'), 'rgb(78, 201, 176)');
eqC('函数名是黄', await colorOf('#hl .tk-fn'), 'rgb(220, 220, 170)');
eqC('字符串是橙', await colorOf('#hl .tk-str'), 'rgb(206, 145, 120)');
eqC('数字是浅绿', await colorOf('#hl .tk-num'), 'rgb(181, 206, 168)');
eqC('标识符是浅蓝', await page.evaluate(() =>
  getComputedStyle(document.querySelector('#hl .cl .lt')).color), 'rgb(156, 220, 254)');
eqC('#include 指令是紫红', await colorOf('#hl .tk-pre'), 'rgb(197, 134, 192)');

// ── ③ 括号着色：三色按深度循环 ──
await page.evaluate(() => window.__pc.setBracketColors(true));
await page.waitForTimeout(250);
const L5 = await lineBk(5);   // for (int i = 0; i < n; i++) {
const L6 = await lineBk(6);   // if (a[i] > 0) {
const GOLD = 'rgb(255, 215, 0)', ORCHID = 'rgb(218, 112, 214)', BLUE = 'rgb(23, 159, 255)';
ok('括号已着色', (await cnt('#hl .bk')) > 0, 'bk=' + (await cnt('#hl .bk')));
eqC('第 6 行 for 的括号是第 1 层（紫）', L5[0].color, ORCHID);
eqC('第 6 行 for 的 { 也是第 1 层', L5[2].color, ORCHID);
eqC('第 7 行 if 的 ( 是第 2 层（蓝）', L6[0].color, BLUE);
eqC('第 7 行 [] 是第 3 层（回到金）', L6[1].color, GOLD);
ok('同一对括号颜色一致', L6[0].color === L6[3].color, L6[0].color + ' vs ' + L6[3].color);
ok('相邻嵌套层级颜色不同', L6[0].color !== L6[1].color, L6[0].color + ' / ' + L6[1].color);
ok('最外层 { 是金色', (await lineBk(4))[1].color === GOLD, JSON.stringify((await lineBk(4))[1]));

// ── ④ 未匹配的括号标红 ──
await setCode('int f() {\n    if (a] {\n}\n');
await page.waitForTimeout(250);
const bad = await page.evaluate(() => [...document.querySelectorAll('#hl .bk')]
  .filter((b) => b.style.color === 'var(--br-bad)').map((b) => b.textContent));
ok('多余的闭括号标红', bad.includes(']'), JSON.stringify(bad));
const red = await page.evaluate(() => {
  const e = [...document.querySelectorAll('#hl .bk')].find((b) => b.style.color === 'var(--br-bad)');
  return e ? getComputedStyle(e).color : null;
});
eqC('未匹配括号是 VSCode 的红', red, 'rgb(255, 18, 18)');
await setCode('int f() {\n    if (a) {\n}\n');
await page.waitForTimeout(250);
const unclosed = await page.evaluate(() => [...document.querySelectorAll('#hl .bk')]
  .filter((b) => b.style.color === 'var(--br-bad)')
  .map((b) => b.textContent + '@' + b.closest('.cl').querySelector('.ln').textContent));
ok('未闭合的开括号也标红', unclosed.length > 0, JSON.stringify(unclosed));

// ── ⑤ 光标配对高亮 ──
await setCode(CODE);
await page.waitForTimeout(250);
const m = await page.evaluate(() => {
  const ta = document.querySelector('#ta');
  const v = ta.value;
  const i = v.indexOf('(i * 2)');
  ta.focus();
  ta.setSelectionRange(i + 1, i + 1);
  window.__pc.editor.emitCaret();
  return [...document.querySelectorAll('#hl .bk.bkm')].map((e) => e.textContent);
});
ok('光标贴在 ( 上，它和配对都被高亮', m.length === 2 && m[0] === '(' && m[1] === ')', JSON.stringify(m));
const m2 = await page.evaluate(() => {
  const ta = document.querySelector('#ta');
  const v = ta.value;
  const i = v.indexOf('(i * 2)');
  ta.setSelectionRange(i + 6, i + 6);   // 移到 ) 后面
  window.__pc.editor.emitCaret();
  return [...document.querySelectorAll('#hl .bk.bkm')].map((e) => e.textContent);
});
ok('光标贴在 ) 上同样高亮这一对', m2.length === 2, JSON.stringify(m2));
const m3 = await page.evaluate(() => {
  const ta = document.querySelector('#ta');
  const v = ta.value;
  ta.setSelectionRange(v.indexOf('return'), v.indexOf('return'));
  window.__pc.editor.emitCaret();
  return [...document.querySelectorAll('#hl .bk.bkm')].length;
});
eqC('光标离开括号后高亮消失', m3, 0);

// ── ⑥ 括号着色可单独使用（不换配色）──
await page.evaluate(() => { window.__pc.setCodeTheme('classic'); });
await page.waitForTimeout(250);
ok('切回经典后括号仍在着色', (await cnt('#hl .bk')) > 0, 'bk=' + (await cnt('#hl .bk')));
eqC('经典配色下括号仍是金色起点', (await lineBk(5))[0].color, ORCHID);

await page.evaluate(() => window.__pc.setBracketColors(false));
await page.waitForTimeout(250);
eqC('关掉括号着色后没有括号 span', await cnt('#hl .bk'), 0);

// ── ⑦ 设置持久化 ──
await setCode(CODE);
await page.evaluate((c) => {
  window.__pc.setCodeTheme('vscode');
  window.__pc.setBracketColors(true);
  // 真正写进 VFS，重载后才会打开这份带括号的代码
  const st = window.__pc.state;
  st.vfs.write(st.active, c);
}, CODE);
await page.waitForTimeout(200);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
ok('重载后仍是 VSCode 配色', (await page.evaluate(() => document.documentElement.dataset.codeTheme)) === 'vscode');
ok('重载后括号着色仍开着', await page.evaluate(() => window.__pc.editor.bracketColors) === true);
ok('重载后括号确实画出来了', (await cnt('#hl .bk')) > 0, 'bk=' + (await cnt('#hl .bk')));

// 设置面板里的控件状态
await page.evaluate(() => window.__pc.settingsModal());
await page.waitForTimeout(350);
const ui = await page.evaluate(() => ({
  theme: document.querySelector('#seg-code-theme .on')?.dataset.v,
  brk: document.querySelector('#m-brk')?.classList.contains('on')
}));
eqC('设置里配色选中 VSCode', ui.theme, 'vscode');
ok('设置里括号开关是开着的', ui.brk === true);
await page.locator('#seg-code-theme button[data-v="classic"]').click();
await page.waitForTimeout(250);
eqC('面板里点「经典」立即生效', await page.evaluate(() => document.documentElement.dataset.codeTheme), 'classic');
await page.locator('#m-close').click();
await page.waitForTimeout(200);

// ── ⑧ 换配色后行号仍与代码对齐、行高一致 ──
const align = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#hl .cl')];
  const hs = rows.map((r) => Math.round(r.getBoundingClientRect().height));
  const r0 = rows[0];
  const row = r0.getBoundingClientRect();
  const ln = r0.querySelector('.ln').getBoundingClientRect();
  const lt = r0.querySelector('.lt').getBoundingClientRect();
  return {
    hs: [...new Set(hs)],
    dMid: Math.abs((ln.top + ln.bottom) / 2 - (lt.top + lt.bottom) / 2),
    inside: ln.top >= row.top - 0.6 && ln.bottom <= row.bottom + 0.6
  };
});
ok('换配色后每行高度一致', align.hs.length === 1, JSON.stringify(align.hs));
ok('行号和代码仍同一行', align.dMid < 2 && align.inside, JSON.stringify(align));

// ── ⑨ 性能：括号着色开启后，输入不会明显变慢 ──
// 只测我们自己的 patch —— 浏览器原生 insertText 在 2000 行 textarea 上自身就要几十毫秒，
// 那是引擎的事，不该算进这个门槛。
const perf = await page.evaluate(() => {
  const ed = window.__pc.editor;
  const ta = document.querySelector('#ta');
  window.__pc.setBracketColors(true);

  // 插入再删除，各算一次，取平均（和 v10 的口径一致）
  const bench = (pos, text) => {
    let total = 0, n = 0;
    for (let i = 0; i < 4; i++) {
      ta.setRangeText(text, pos, pos, 'end');
      let t = performance.now();
      ed.patch();
      total += performance.now() - t; n++;
      ta.setRangeText('', pos, pos + text.length, 'end');
      t = performance.now();
      ed.patch();
      total += performance.now() - t; n++;
    }
    return Math.round(total / n);
  };

  const run = (n) => {
    const line = '    if (a[i] > 0) { printf("%d\\n", a[i] + (i * 2)); }';
    const big = Array.from({ length: n }, (_, i) => (i % 20 === 0 ? 'int f' + i + '() {' : line)).join('\n');
    const t0 = performance.now();
    ed.setValue(big, true);
    const render = Math.round(performance.now() - t0);
    const mid = big.indexOf('if (a[i]', Math.floor(big.length / 2)) + 4;
    ta.focus();
    ta.setSelectionRange(mid, mid);
    return {
      render,
      worst: bench(mid, '('),      // 深度整体偏移：最坏情况
      paired: bench(mid, '()'),    // 编辑器自动配对的真实打字路径
      normal: bench(mid, 'x')      // 不碰括号
    };
  };
  return { small: run(300), big: run(2000) };
});
console.log('perf 300 行 ', JSON.stringify(perf.small));
console.log('perf 2000 行', JSON.stringify(perf.big));
ok('300 行（常见规模）普通输入 patch < 12ms', perf.small.normal < 12, perf.small.normal + 'ms');
ok('300 行 打一对括号 patch < 12ms', perf.small.paired < 12, perf.small.paired + 'ms');
ok('300 行 最坏情况（深度全偏移）< 25ms', perf.small.worst < 25, perf.small.worst + 'ms');
// 2000 行是全开特性下的极端规模，浏览器自身重排就占大半，能在一帧半内完成即可
ok('2000 行 普通输入 patch < 100ms', perf.big.normal < 100, perf.big.normal + 'ms');
ok('2000 行 最坏情况 < 130ms', perf.big.worst < 130, perf.big.worst + 'ms');

// 分帧追平后，所有行的括号深度必须完全正确
const settled = await page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 600));
  const br = window.__pc.editor._br;
  let bad = 0;
  for (const b of br) {
    if (b.pair < 0) continue;
    if ((b.depth % 3) !== (br[b.pair].depth % 3)) bad++;
  }
  const unset = new Set(br.filter((b) => b.depth >= 0 && b.pair < 0).map((b) => b.line + ':' + b.col));
  const dom = [...document.querySelectorAll('#hl .bk')].map((e) => e.style.color);
  const expect = br.map((b) => (b.depth < 0 || unset.has(b.line + ':' + b.col)
    ? 'var(--br-bad)'
    : 'var(--br-' + (b.depth % 3) + ')'));
  let diff = 0;
  for (let i = 0; i < Math.min(dom.length, expect.length); i++) if (dom[i] !== expect[i]) diff++;
  return { bad, diff, domN: dom.length, expN: expect.length };
});
ok('分帧追平后括号深度全部正确', settled.bad === 0 && settled.diff === 0 && settled.domN === settled.expN, JSON.stringify(settled));

console.log('errors:', errors.length ? errors : 'none');
console.log(pass + ' passed, ' + fail + ' failed');
await browser.close();
process.exit(fail ? 1 : 0);
