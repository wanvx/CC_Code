// v1.3 安卓 WebView 内验证：补全浮层跟随 / 三 tab 面板 / 缩进参考线
import { execSync } from 'node:child_process';

const ADB = 'C:\\Users\\35283\\WorkBuddy\\2026-10-27-08-29-52\\android-build\\sdk\\platform-tools\\adb.exe';
const adb = (args) => execSync(`"${ADB}" -s emulator-5554 ${args}`, { encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });

let pid = '';
for (let i = 0; i < 25 && !pid; i++) {
  try { pid = adb('shell pidof com.pocketcode.ide').trim(); } catch (e) { pid = ''; }
  if (!pid) await new Promise((r) => setTimeout(r, 1500));
}
console.log('pid =', pid);
if (!pid) { console.log('app 没在跑'); process.exit(1); }
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
  if (r.result && r.result.exceptionDetails) {
    console.log('  [eval error]', JSON.stringify(r.result.exceptionDetails).slice(0, 240));
    return null;
  }
  return r.result && r.result.result ? r.result.result.value : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const ok = (k, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + k + (extra != null ? '  → ' + extra : ''));
  if (!cond) fail++;
};

await send('Runtime.enable');
await sleep(500);

// 0. 版本
const info = await evalJs('JSON.stringify(window.__pc && window.__pc.appInfo)');
ok('应用版本 1.3.0', /1\.3\.0/.test(String(info)) && /"code":8/.test(String(info)), info);

// 1. 三 tab 面板
const tabs = await evalJs('JSON.stringify([...document.querySelectorAll(".panel-tab")].map(e=>e.dataset.tab))');
ok('三 tab 同层', tabs === '["output","stdin","problems"]', tabs);
ok('旧下部输入条已移除', (await evalJs('document.querySelectorAll("#stdin-box").length')) === 0);
await evalJs('document.querySelector(\'.panel-tab[data-tab="stdin"]\').click()');
await sleep(300);
ok('切到输入页', (await evalJs('document.querySelector(".pane.active").id')) === 'stdin-pane');

// 2. 输入 → 运行 → 输出
const CODE = '#include <cstdio>\n\nint main() {\n    int a, b;\n    if (scanf("%d %d", &a, &b) != 2) return 1;\n    printf("%d\\n", a + b);\n    return 0;\n}\n';
await evalJs(`(() => {
  const c = ${JSON.stringify(CODE)};
  window.__pc.state.vfs.write('main.cpp', c);
  window.__pc.renderTree();
  window.__pc.openFile('main.cpp');
  return 1;
})()`);
await sleep(400);
await evalJs('document.querySelector(\'.panel-tab[data-tab="stdin"]\').click()');
await sleep(200);
await evalJs(`(() => { const t = document.querySelector('#stdin-ta'); t.value = '3 4'; t.dispatchEvent(new Event('input')); return 1; })()`);
await sleep(200);
ok('输入 tab 显示有内容', (await evalJs('!document.querySelector("#stdin-dot").classList.contains("hidden")')));
await evalJs('document.querySelector("#btn-run").click()');
for (let i = 0; i < 120; i++) {
  const s = await evalJs('document.querySelector("#st-status").textContent');
  if (/运行完成|编译失败|出错/.test(String(s))) break;
  await sleep(500);
}
const term = await evalJs('document.querySelector("#terminal").innerText');
ok('stdin 喂进程序并跑通', /(^|\n)7(\n|$)/.test(String(term)), JSON.stringify(String(term).slice(-50)));
ok('运行后回到输出页', (await evalJs('document.querySelector(".pane.active").id')) === 'terminal');

// 3. 缩进参考线
const gcount = await evalJs('document.querySelectorAll("#hl .gi").length');
ok('缩进参考线已画', gcount > 0, 'gi=' + gcount);
const gw = await evalJs(`(() => {
  const rows = [...document.querySelectorAll('#hl .cl')];
  const g = rows.map(r => r.querySelector('.gi')).filter(Boolean);
  return g.length ? Math.round(g[g.length - 1].getBoundingClientRect().width) : 0;
})()`);
ok('参考线宽度合理', gw > 0, 'w=' + gw);
await evalJs('window.__pc.editor.setIndentGuides(false)');
await sleep(250);
ok('关掉后消失', (await evalJs('document.querySelectorAll("#hl .gi").length')) === 0);
await evalJs('window.__pc.editor.setIndentGuides(true)');
await sleep(250);

// 4. 补全浮层：锚定 + 跟随滚动（这是桌面上不出现、只在 WebView 里乱跳的场景）
const LONG = Array.from({ length: 40 }, (_, i) => 'int v' + i + ' = ' + i + ';').join('\n') + '\n\nvoid f() {\nint pri';
await evalJs(`(() => {
  const ed = window.__pc.editor;
  ed.setValue(${JSON.stringify(LONG)}, true);
  ed.ta.focus();
  ed.ta.setSelectionRange(ed.ta.value.length, ed.ta.value.length);
  ed.updateAutocomplete();
  return 1;
})()`);
await sleep(600);
const acOpen = async () => !(await evalJs('document.querySelector("#ac").classList.contains("hidden")'));
ok('补全弹出', await acOpen());

const probe = () => evalJs(`(() => {
  const ed = window.__pc.editor, ta = ed.ta, v = ta.value, pos = ta.selectionStart;
  const line = v.slice(0, pos).split('\\n').length - 1;
  const padTop = parseFloat(getComputedStyle(ta).paddingTop) || 8;
  const lh = ed.lineHeight;
  const hostR = ed.host.getBoundingClientRect();
  const taR = ta.getBoundingClientRect();
  const acR = document.querySelector('#ac').getBoundingClientRect();
  const caretTop = (taR.top - hostR.top) + padTop + line * lh - ta.scrollTop;
  const delta = Math.round(acR.top - hostR.top - caretTop);
  return JSON.stringify({
    line, delta, ph: Math.round(acR.height),
    below: Math.abs(delta - (lh + 2)) <= 5,
    above: Math.abs(delta + (acR.height + 4)) <= 5,
    insideHost: acR.top >= hostR.top - 8 && acR.bottom <= hostR.bottom + 8 &&
      acR.left >= hostR.left - 8 && acR.right <= hostR.right + 8,
    hostH: Math.round(hostR.height), scrollTop: Math.round(ta.scrollTop)
  });
})()`).then((s) => JSON.parse(String(s)));

await evalJs(`(() => {
  const ed = window.__pc.editor, ta = ed.ta;
  const line = ta.value.slice(0, ta.selectionStart).split('\\n').length - 1;
  const padTop = parseFloat(getComputedStyle(ta).paddingTop) || 8;
  ta.scrollTop = Math.max(0, padTop + line * ed.lineHeight - ta.clientHeight / 2);
  ed.syncScroll();
  return 1;
})()`);
await sleep(400);
const p0 = await probe();
ok('浮层贴住光标行', p0.below || p0.above, JSON.stringify(p0));
ok('浮层在编辑区内', p0.insideHost);

await evalJs('window.__pc.editor.ta.scrollTop -= 60; 1');
await sleep(350);
const p1 = await probe();
ok('滚动后仍开', await acOpen());
ok('滚动后仍贴住光标行', p1.below || p1.above, JSON.stringify(p1));
ok('滚动后仍在编辑区内', p1.insideHost);

await evalJs('window.__pc.editor.ta.scrollTop += 120; 1');
await sleep(350);
const p2 = await probe();
ok('再次滚动仍贴住光标行', p2.below || p2.above, JSON.stringify(p2));

// 关键回归：回车/撤销后滚动不跳（v1.2.1 修过，别回退）
await evalJs('window.__pc.editor.hideAc(); 1');
await sleep(200);
const y0 = await evalJs('window.__pc.editor.ta.scrollTop');
await evalJs(`(() => { const ed = window.__pc.editor; ed.ta.focus(); ed.ta.setSelectionRange(ed.ta.value.length, ed.ta.value.length); document.execCommand('insertText', false, '\\n'); return 1; })()`);
await sleep(400);
const y1 = await evalJs('window.__pc.editor.ta.scrollTop');
ok('换行后滚动不跳到末尾', Math.abs(y1 - y0) < 60, 'y0=' + y0 + ' y1=' + y1);

console.log('\n结果：' + (fail ? fail + ' 项失败' : '全部通过'));
ws.close();
