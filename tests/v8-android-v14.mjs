// 安卓 WebView 实测：① 补全首项 ② 实时检查（括号/分号）
import { execSync } from 'node:child_process';

const ADB = 'C:\\Users\\35283\\WorkBuddy\\2026-10-27-08-29-52\\android-build\\sdk\\platform-tools\\adb.exe';
const adb = (a) => execSync(`"${ADB}" -s emulator-5554 ${a}`, { encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('ok   ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')); }
};

let pid = '';
for (let i = 0; i < 30 && !pid; i++) {
  try { pid = adb('shell pidof com.pocketcode.ide').trim(); } catch (e) { pid = ''; }
  if (!pid) await new Promise((r) => setTimeout(r, 1500));
}
ok('应用进程存在', !!pid, 'pid=' + pid);
if (!pid) process.exit(1);

try { adb('forward --remove tcp:9222'); } catch (e) { /* 无则忽略 */ }
adb(`forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target = list.find((x) => x.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
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
  if (r.result && r.result.exceptionDetails) {
    console.log('  [eval error]', JSON.stringify(r.result.exceptionDetails).slice(0, 240));
    return null;
  }
  return r.result && r.result.result ? r.result.result.value : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 等页面初始化完成（应用刚启动时 __pc 还没挂上）
for (let i = 0; i < 40; i++) {
  const ready = await ev('typeof window.__pc !== "undefined" && !!window.__pc.editor');
  if (ready) break;
  await sleep(500);
}

const CODE = [
  'int main() {',
  '    int a = 1',
  '    return 0;',
  '}',
  ''
].join('\n');

await ev(`(() => {
  const pc = window.__pc;
  pc.state.vfs.write('main.cpp', ${JSON.stringify(CODE)});
  pc.renderTree();
  pc.openFile('main.cpp');
  return 1;
})()`);
await sleep(900);

const st = () => ev(`(() => ({
  badge: (document.querySelector('#st-lint') || {}).textContent,
  warnLines: [...document.querySelectorAll('#hl .cl.warn')].map((e) => +e.querySelector('.ln').textContent),
  errLines: [...document.querySelectorAll('#hl .cl.err')].map((e) => +e.querySelector('.ln').textContent),
  probs: [...document.querySelectorAll('#problems .prob .p-msg')].map((e) => e.textContent),
  version: window.__pc.appInfo.version
}))()`);

const s1 = await st();
ok('版本 1.4.0', s1.version === '1.4.0', 'v=' + s1.version);
ok('漏分号：行号标黄', s1.warnLines.includes(2), JSON.stringify(s1.warnLines));
ok('漏分号：问题面板列出', s1.probs.some((p) => p.includes('分号')), JSON.stringify(s1.probs));

// 括号没闭合
await ev(`(() => {
  const pc = window.__pc;
  pc.editor.setValue(${JSON.stringify('int main() {\n    if (1) {\n        f();\n    return 0;\n')}, true);
  pc.state.vfs.write('main.cpp', pc.editor.value);
  pc.runLintNow();
  return 1;
})()`);
await sleep(900);
const s2 = await st();
ok('括号没闭合：报 error', s2.errLines.length > 0 && s2.probs.some((p) => p.includes('没有闭合')), JSON.stringify(s2.errLines) + ' ' + JSON.stringify(s2.probs));

// 补全：第一下 ↓ 落在第一项
await ev(`(() => {
  const pc = window.__pc;
  pc.editor.setValue('int main() {\\n    \\n    return 0;\\n}\\n', true);
  pc.state.vfs.write('main.cpp', pc.editor.value);
  const ed = pc.editor;
  ed.ta.focus();
  const pos = ed.ta.value.indexOf('    \\n') + 4;
  ed.ta.setSelectionRange(pos, pos);
  ed.insert('pr');
  ed.updateAutocomplete();
  return 1;
})()`);
await sleep(400);
const ac0 = await ev(`(() => {
  const ed = window.__pc.editor;
  return { open: ed.acOpen, idx: ed.acIndex, count: ed.acItems.length,
    pre: [...document.querySelectorAll('#ac .ac-item')].findIndex((e) => e.classList.contains('pre')) };
})()`);
ok('补全弹出且未选中', ac0 && ac0.open && ac0.idx === -1 && ac0.pre === 0, JSON.stringify(ac0));

// 直接触发 keydown（WebView 没有物理键盘，用 CDP Input 发送真实按键）
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
await sleep(300);
const ac1 = await ev(`(() => {
  const ed = window.__pc.editor;
  return { idx: ed.acIndex,
    sel: [...document.querySelectorAll('#ac .ac-item')].findIndex((e) => e.classList.contains('sel')),
    first: ed.acItems[0] && ed.acItems[0].label };
})()`);
ok('第一下 ↓ 落在第 1 项', ac1 && ac1.idx === 0 && ac1.sel === 0, JSON.stringify(ac1));

await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
await sleep(300);
const ac2 = await ev(`(() => {
  const ed = window.__pc.editor;
  return { idx: ed.acIndex, sel: [...document.querySelectorAll('#ac .ac-item')].findIndex((e) => e.classList.contains('sel')) };
})()`);
ok('第二下 ↓ 到第 2 项', ac2 && ac2.sel === 1, JSON.stringify(ac2));

await ev('window.__pc.editor.hideAc(); 1');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
ws.close();
process.exit(fail ? 1 : 0);
