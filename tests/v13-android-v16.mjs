// Android WebView 实测 v1.6：VSCode 配色 + 括号配对颜色化（真机 CSS 变量 / 内联色是否生效）
import { execSync } from 'node:child_process';

const ADB = 'C:\\Users\\35283\\WorkBuddy\\2026-10-27-08-29-52\\android-build\\sdk\\platform-tools\\adb.exe';
const adb = (a) => execSync(`"${ADB}" -s emulator-5554 ${a}`, { encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('ok   ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

let pid = '';
for (let i = 0; i < 30 && !pid; i++) {
  try { pid = adb('shell pidof com.pocketcode.ide').trim(); } catch (e) { pid = ''; }
  if (!pid) await sleep(1500);
}
if (!pid) { console.log('应用没起来'); process.exit(1); }
try { adb('forward --remove tcp:9222'); } catch (e) { /* ignore */ }
adb(`forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) { console.log('  [eval error]', JSON.stringify(r.result.exceptionDetails).slice(0, 200)); return null; }
  return r.result && r.result.result ? r.result.result.value : null;
};

for (let i = 0; i < 40; i++) {
  if (await ev('typeof window.__pc !== "undefined" && !!window.__pc.editor')) break;
  await sleep(500);
}

ok('版本 1.6.0', (await ev('window.__pc.appInfo.version')) === '1.6.0', await ev('window.__pc.appInfo.version'));
ok('versionCode 11', (await ev('window.__pc.appInfo.code')) === 11, await ev('window.__pc.appInfo.code'));

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
await ev('window.__pc.editor.setValue(' + JSON.stringify(CODE) + ', true)');
await sleep(400);

// ① 复位到经典配色（跑过一遍后设置已被持久化，不能直接断言"默认"）
await ev('window.__pc.setCodeTheme("classic"); window.__pc.setBracketColors(false)');
await sleep(400);
ok('可以回到经典配色', (await ev('document.documentElement.dataset.codeTheme')) === 'classic');
ok('关掉括号着色后没有括号 span', (await ev('document.querySelectorAll("#hl .bk").length')) === 0);

// ② 切 VSCode 配色后，真机算出来的颜色必须和 Dark+ 一致
await ev('window.__pc.setCodeTheme("vscode")');
await sleep(400);
const colors = await ev(`(() => {
  const c = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).color : null; };
  const lt = document.querySelector('#hl .cl .lt');
  return {
    ctl: c('#hl .tk-ctl'), kwtype: c('#hl .tk-kwtype'), stl: c('#hl .tk-type'),
    fn: c('#hl .tk-fn'), str: c('#hl .tk-str'), num: c('#hl .tk-num'),
    pre: c('#hl .tk-pre'), inc: c('#hl .tk-inc'),
    id: lt ? getComputedStyle(lt).color : null
  };
})()`);
ok('控制流是紫红 #C586C0', colors.ctl === 'rgb(197, 134, 192)', colors.ctl);
ok('内置类型是蓝 #569CD6', colors.kwtype === 'rgb(86, 156, 214)', colors.kwtype);
ok('自定义类型是青 #4EC9B0', colors.stl === 'rgb(78, 201, 176)', colors.stl);
ok('函数名是黄 #DCDCAA', colors.fn === 'rgb(220, 220, 170)', colors.fn);
ok('字符串是橙 #CE9178', colors.str === 'rgb(206, 145, 120)', colors.str);
ok('数字是浅绿 #B5CEA8', colors.num === 'rgb(181, 206, 168)', colors.num);
ok('预处理是紫红', colors.pre === 'rgb(197, 134, 192)', colors.pre);
ok('include 目标是橙', colors.inc === 'rgb(206, 145, 120)', colors.inc);
ok('标识符是浅蓝 #9CDCFE', colors.id === 'rgb(156, 220, 254)', colors.id);

// ③ 括号着色：三色循环 + 深度正确
await ev('window.__pc.setBracketColors(true)');
await sleep(450);
const bk = await ev(`(() => {
  const rows = [...document.querySelectorAll('#hl .cl')];
  const get = (n) => [...rows[n].querySelectorAll('.bk')].map((b) => ({ ch: b.textContent, color: getComputedStyle(b).color }));
  return { n: document.querySelectorAll('#hl .bk').length, l4: get(4), l5: get(5), l6: get(6) };
})()`);
ok('括号已着色', bk.n > 0, 'bk=' + bk.n);
ok('最外层花括号是金色', bk.l4.some((b) => b.ch === '{' && b.color === 'rgb(255, 215, 0)'), JSON.stringify(bk.l4));
ok('第 1 层是紫色', bk.l5[0].color === 'rgb(218, 112, 214)', bk.l5[0].color + ' ' + bk.l5[0].ch);
ok('第 2 层是蓝色', bk.l6[0].color === 'rgb(23, 159, 255)', bk.l6[0].color + ' ' + bk.l6[0].ch);
ok('第 3 层回到金色', bk.l6[1] && bk.l6[1].color === 'rgb(255, 215, 0)', bk.l6[1] ? bk.l6[1].color : 'null');
ok('同一对括号同色', bk.l5[0].color === bk.l5[1].color, bk.l5[0].color + ' / ' + bk.l5[1].color);

// ④ 未匹配标红
await ev('window.__pc.editor.setValue("int f() {\\n    if (a] {\\n}\\n", true)');
await sleep(400);
const red = await ev(`(() => {
  const bad = [...document.querySelectorAll('#hl .bk')].filter((b) => b.style.color === 'var(--br-bad)');
  return { n: bad.length, chars: bad.map((b) => b.textContent), color: bad[0] ? getComputedStyle(bad[0]).color : null };
})()`);
ok('未匹配的括号标红', red.n > 0, JSON.stringify(red.chars));
ok('红色是 #FF1212', red.color === 'rgb(255, 18, 18)', red.color);

// ⑤ 光标配对高亮
await ev('window.__pc.editor.setValue(' + JSON.stringify(CODE) + ', true)');
await sleep(400);
const m = await ev(`(() => {
  const ta = document.querySelector('#ta');
  const i = ta.value.indexOf('(i * 2)');
  ta.focus();
  ta.setSelectionRange(i + 1, i + 1);
  window.__pc.editor.emitCaret();
  return [...document.querySelectorAll('#hl .bk.bkm')].map((e) => e.textContent);
})()`);
ok('光标括号与配对一起高亮', m && m.length === 2 && m[0] === '(' && m[1] === ')', JSON.stringify(m));

// ⑥ 浅色主题下括号颜色依然正确（CSS 变量换主题生效）
await ev('document.documentElement.dataset.theme = "light"');
await sleep(300);
const light = await ev(`(() => {
  const b = document.querySelector('#hl .bk');
  return { br0: getComputedStyle(b).color };
})()`);
ok('浅色下金色被压深（可读）', light.br0 !== 'rgb(255, 215, 0)', light.br0);
await ev('document.documentElement.dataset.theme = "dark"');
await sleep(200);

// ⑦ 设置项持久化
ok('设置已持久化', (await ev('JSON.parse(localStorage.getItem("pocketcode.settings.v2")).codeTheme')) === 'vscode');
ok('括号开关已持久化', (await ev('JSON.parse(localStorage.getItem("pocketcode.settings.v2")).bracketColors')) === true);

// ⑧ 行号与代码仍同行对齐
const align = await ev(`(() => {
  const r0 = document.querySelector('#hl .cl');
  const row = r0.getBoundingClientRect();
  const ln = r0.querySelector('.ln').getBoundingClientRect();
  const lt = r0.querySelector('.lt').getBoundingClientRect();
  return { h: Math.round(row.height), dMid: Math.abs((ln.top + ln.bottom) / 2 - (lt.top + lt.bottom) / 2), inside: ln.top >= row.top - 0.6 };
})()`);
ok('行高锁 20px', align.h === 20, align.h);
ok('行号与代码同一行', align.dMid < 2 && align.inside, JSON.stringify(align));

const errs = await ev('window.__pcErrs ? window.__pcErrs.length : 0');
ok('无页面报错', !errs, errs);

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
