// Android WebView 内验证：回车换行 / Ctrl+Z 撤销后编辑器滚动不跳变
import { execSync } from 'node:child_process';

const ADB = 'C:\\Users\\35283\\WorkBuddy\\2026-10-27-08-29-52\\android-build\\sdk\\platform-tools\\adb.exe';
const adb = (args) => execSync(`"${ADB}" -s emulator-5554 ${args}`, { encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });

const pid = adb('shell pidof com.pocketcode.ide').trim();
console.log('pid =', pid);
try { adb('forward --remove tcp:9222'); } catch (e) { /* ignore */ }
adb(`forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || list[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) return { error: JSON.stringify(r.result.exceptionDetails) };
  return r.result && r.result.result ? r.result.result.value : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const log = (k, ok, extra) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + k + (extra != null ? '  → ' + extra : ''));
  if (!ok) fail++;
};

const key = async (k, extra = {}) => {
  const base = { key: k, code: k, windowsVirtualKeyCode: extra.vk, nativeVirtualKeyCode: extra.vk, modifiers: extra.modifiers || 0 };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(extra.text ? {} : {}) });
  if (extra.text) await send('Input.dispatchKeyEvent', { type: 'char', ...base, text: extra.text, unmodifiedText: extra.text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
};

const STATE = `(() => {
  const ed = window.__pc.editor, v = ed.ta.value;
  let line = 0;
  for (let i = ed.ta.selectionStart - 1; i >= 0; i--) if (v.charCodeAt(i) === 10) line++;
  const y = 8 + line * ed.lineHeight, top = ed.ta.scrollTop, h = ed.ta.clientHeight;
  return JSON.stringify({
    scrollTop: Math.round(top), max: Math.round(ed.ta.scrollHeight - h), caretLine: line + 1,
    visible: y >= top - 1 && y + ed.lineHeight <= top + h + 1,
    wrapY: document.querySelector('#code-wrap').scrollTop,
    hlY: ed.hlEl.style.transform, lines: v.split('\\n').length
  });
})()`;

const state = async () => JSON.parse(await evalJs(STATE));

const setup = async (n) => {
  await evalJs(`(() => {
    const ed = window.__pc.editor;
    ed.setValue(Array.from({length:200},(_,i)=>'int a'+i+' = '+i+';').join('\\n'), true);
    ed.ta.focus();
    const pos = ed.ta.value.indexOf('int a${n} = ${n};') + ('int a${n} = ${n}').length;
    ed.ta.setSelectionRange(pos, pos);
    ed.ensureCaretVisible();
    ed.ta.scrollTop = Math.min(ed.ta.scrollHeight, ed.ta.scrollTop + 140);
    ed.syncScroll();
    return true;
  })()`);
  await sleep(250);
};

console.log('\n── 版本');
console.log(JSON.stringify(await evalJs('window.__pc.appInfo')));

console.log('\n── 1. 符号后回车');
await setup(100);
let before = await state();
await evalJs("window.__pc.editor.ta.focus(); window.__pc.editor.insert('=')");
await sleep(250);
await key('Enter', { vk: 13, text: '\r' });
await sleep(500);
let after = await state();
console.log('  before =', JSON.stringify(before));
console.log('  after  =', JSON.stringify(after));
log('回车后光标仍在视口内', after.visible, 'caretLine=' + after.caretLine);
log('回车后未跳到末尾', after.scrollTop < after.max - 5, 'top=' + after.scrollTop + ' max=' + after.max);
log('回车后外层容器未被滚动', after.wrapY === 0, 'wrapY=' + after.wrapY);

console.log('\n── 2. 连续回车 5 次');
for (let i = 0; i < 5; i++) { await key('Enter', { vk: 13, text: '\r' }); await sleep(160); }
await sleep(400);
after = await state();
log('连按回车光标仍可见', after.visible, JSON.stringify(after));
log('连按回车未跳到末尾', after.scrollTop < after.max - 5, 'top=' + after.scrollTop);

console.log('\n── 3. Ctrl+Z 撤销');
for (let i = 0; i < 5; i++) { await key('z', { vk: 90, modifiers: 2 }); await sleep(200); }
await sleep(500);
after = await state();
log('撤销后光标可见', after.visible, JSON.stringify(after));
log('撤销后未跳到顶部', after.scrollTop > 0, 'top=' + after.scrollTop);
log('撤销后回到原位置附近', Math.abs(after.scrollTop - before.scrollTop) <= 80, before.scrollTop + ' → ' + after.scrollTop);

console.log('\n── 4. 强制模拟引擎异常滚动（滚到末尾 / 滚到顶部）');
await setup(100);
await evalJs("window.__pc.editor.ta.addEventListener('input', () => { window.__pc.editor.ta.scrollTop = window.__pc.editor.ta.scrollHeight; }, { once: true })");
await key('Enter', { vk: 13, text: '\r' });
await sleep(500);
after = await state();
log('被滚到末尾后自动拉回光标', after.visible, JSON.stringify(after));
log('拉回后不在末尾', after.scrollTop < after.max - 5, 'top=' + after.scrollTop);

await evalJs("window.__pc.editor.ta.addEventListener('input', () => { window.__pc.editor.ta.scrollTop = 0; }, { once: true })");
await key('Backspace', { vk: 8 });
await sleep(500);
after = await state();
log('被滚到顶部后自动拉回光标', after.visible, JSON.stringify(after));

// 收尾：还原空文件，避免测试数据残留
await evalJs("window.__pc.editor.setValue('', true)");

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
