// Android WebView 内验证 v1.2：stdin 输入框 / 补全关闭 / 更新检查 / 原生 openUrl
import { execSync } from 'node:child_process';

const ADB = 'C:\\Users\\35283\\WorkBuddy\\2026-10-27-08-29-52\\android-build\\sdk\\platform-tools\\adb.exe';
const adb = (args) => execSync(`"${ADB}" -s emulator-5554 ${args}`, { encoding: 'utf-8', env: { ...process.env, NO_PROXY: '*' } });

const pid = adb('shell pidof com.pocketcode.ide').trim();
console.log('pid =', pid);
try { adb('forward --remove tcp:9222'); } catch (e) { /* ignore */ }
adb(`forward tcp:9222 localabstract:webview_devtools_remote_${pid}`);

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || list[0];
console.log('TARGET:', target.type, target.url);

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
  if (r.result && r.result.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result && r.result.result ? r.result.result.value : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n── 环境');
console.log('native bridge =', await evalJs('typeof window.PocketCodeNative === "object" && typeof window.PocketCodeNative.openUrl === "function"'));
console.log('app info =', JSON.stringify(await evalJs('window.__pc.appInfo')));
console.log('stdin box =', await evalJs('!!document.querySelector("#stdin-ta")'));

console.log('\n── stdin 直输 + 运行');
await evalJs(`(() => {
  const v = window.__pc.state.vfs;
  const d = v.mkdir('', 'v3test');
  const p = v.createFile(d, 'sum.cpp', '#include <cstdio>\\nint main(){int a,b;if(scanf("%d %d",&a,&b)!=2)return 1;printf("%d\\\\n",a+b);return 0;}\\n');
  window.__pc.renderTree();
  window.__pc.openFile(p);
  return p;
})()`);
await sleep(400);
console.log('stdin disabled (should be false) =', await evalJs('document.querySelector("#stdin-ta").disabled'));
await evalJs(`(() => {
  const ta = document.querySelector('#stdin-ta');
  ta.value = '12 30';
  ta.dispatchEvent(new Event('input'));
  return ta.value;
})()`);
console.log('meta =', await evalJs('(document.querySelector('.panel-tab[data-tab="stdin"]').title||"")'));
await evalJs('document.querySelector("#btn-run").click()');
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  const st = await evalJs('document.querySelector("#st-status").textContent');
  if (/运行完成|编译失败|出错/.test(st)) break;
}
await sleep(500);
const term = await evalJs('document.querySelector("#terminal").innerText');
console.log('terminal =', JSON.stringify(term));
console.log('PASS 42 =', /(^|\n)42(\n|$)/.test(term || ''));

console.log('\n── 补全左右键关闭');
console.log('ac closed by ArrowLeft =', await evalJs(`(() => {
  const ed = window.__pc.editor;
  ed.setValue('int pri', true);
  ed.ta.focus();
  ed.ta.setSelectionRange(7, 7);
  ed.updateAutocomplete();
  const opened = !document.querySelector('#ac').classList.contains('hidden');
  ed._onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
  const closed = document.querySelector('#ac').classList.contains('hidden');
  return opened && closed;
})()`));

console.log('\n── 检查更新（真实网络）');
await evalJs('window.__pc.checkUpdate(true)');
for (let i = 0; i < 20; i++) {
  await sleep(1000);
  const st = await evalJs('document.querySelector("#st-status").textContent');
  if (/已是最新|有新版本|检查失败/.test(st)) break;
}
console.log('update status =', await evalJs('document.querySelector("#st-status").textContent'));

try {
  // 直接截到本地文件（走 Git Bash 的 redirect，别写进 adb 命令里）
  execSync(`"${ADB}" -s emulator-5554 exec-out screencap -p > "C:/Users/35283/WorkBuddy/2026-10-27-08-29-52/android-build/smoke/v3-02-run.png"`, { shell: 'C:/Program Files/Git/bin/bash.exe', env: { ...process.env, NO_PROXY: '*' } });
  console.log('screenshot saved');
} catch (e) { console.log('screenshot skipped:', e.message.split('\n')[0]); }

ws.close();
