// v1.4 验收：① 补全首项选择 ② 实时检查（括号 / 分号）
import { chromium } from 'playwright';

const URL = 'http://localhost:8341/';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('ok   ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const b = await chromium.launch({ channel: 'chrome' });
const page = await b.newPage({ viewport: { width: 1024, height: 768 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__pc, null, { timeout: 60000 });

// ── ① 补全首项 ──────────────────────────
const setCode = (code) => page.evaluate((c) => {
  const pc = window.__pc;
  pc.state.vfs.write('main.cpp', c);
  pc.renderTree();
  pc.openFile('main.cpp');
  pc.editor.focus();
}, code);

await setCode('int main() {\n    \n    return 0;\n}\n');
await page.evaluate(() => {
  const ed = window.__pc.editor;
  const pos = ed.ta.value.indexOf('    \n') + 4;
  ed.ta.setSelectionRange(pos, pos);
  ed.updateAutocomplete();
});
// 手动输入两个字符触发补全
await page.keyboard.type('pr');
await page.waitForTimeout(220);
const acOpen = () => page.evaluate(() => window.__pc.editor.acOpen && !document.querySelector('#ac').classList.contains('hidden'));
ok('补全弹窗已弹出', await acOpen());

const acState = () => page.evaluate(() => {
  const ed = window.__pc.editor;
  return {
    index: ed.acIndex,
    sel: [...document.querySelectorAll('#ac .ac-item')].findIndex((e) => e.classList.contains('sel')),
    pre: [...document.querySelectorAll('#ac .ac-item')].findIndex((e) => e.classList.contains('pre')),
    count: ed.acItems.length,
    first: ed.acItems[0] && ed.acItems[0].label
  };
});

const s0 = await acState();
ok('弹出时未选中任何项', s0.index === -1 && s0.sel === -1, JSON.stringify(s0));
ok('第一项显示为预选（淡底）', s0.pre === 0, 'pre=' + s0.pre);

await page.keyboard.press('ArrowDown');
await page.waitForTimeout(120);
const s1 = await acState();
ok('第一下 ↓ 落在第 1 项（不跳到第 2 项）', s1.sel === 0 && s1.index === 0, JSON.stringify(s1));

await page.keyboard.press('ArrowDown');
await page.waitForTimeout(120);
const s2 = await acState();
ok('第二下 ↓ 到第 2 项', s2.sel === 1, 'sel=' + s2.sel);

await page.keyboard.press('ArrowUp');
await page.waitForTimeout(120);
const s3 = await acState();
ok('↑ 回到第 1 项', s3.sel === 0, 'sel=' + s3.sel);

await page.keyboard.press('Enter');
await page.waitForTimeout(200);
const after = await page.evaluate(() => ({
  open: window.__pc.editor.acOpen,
  line: window.__pc.editor.ta.value.split('\n')[1]
}));
ok('回车插入第 1 项', !after.open && after.line.trim() === 'printf', JSON.stringify(after));

// ── ② 实时检查 ──────────────────────────
const lintState = () => page.evaluate(() => ({
  badge: document.querySelector('#st-lint').textContent.trim(),
  hidden: document.querySelector('#st-lint').classList.contains('hidden'),
  errLines: [...document.querySelectorAll('#hl .cl.err')].map((e) => +e.querySelector('.ln').textContent),
  warnLines: [...document.querySelectorAll('#hl .cl.warn')].map((e) => +e.querySelector('.ln').textContent),
  probs: [...document.querySelectorAll('#problems .prob .p-msg')].map((e) => e.textContent)
}));

// 漏分号
await setCode('int main() {\n    int a = 1\n    return 0;\n}\n');
await page.waitForTimeout(400);
const l1 = await lintState();
ok('漏分号：状态栏出计数', !l1.hidden && /▲/.test(l1.badge), l1.badge);
ok('漏分号：行号栏标黄', l1.warnLines.includes(2), JSON.stringify(l1.warnLines));
ok('漏分号：问题面板列出', l1.probs.some((p) => p.includes('分号')), JSON.stringify(l1.probs));

// 括号没闭合
await setCode('int main() {\n    if (1) {\n        f();\n\n    return 0;\n');
await page.waitForTimeout(400);
const l2 = await lintState();
ok('括号没闭合：报 error', l2.errLines.length > 0 && /✕/.test(l2.badge), l2.badge + ' err=' + JSON.stringify(l2.errLines));
ok('括号没闭合：问题面板有提示', l2.probs.some((p) => p.includes('没有闭合')), JSON.stringify(l2.probs));

// 修好后提示消失
await setCode('int main() {\n    int a = 1;\n    return 0;\n}\n');
await page.waitForTimeout(400);
const l3 = await lintState();
ok('改对后提示自动消失', l3.hidden && l3.errLines.length === 0 && l3.warnLines.length === 0, JSON.stringify(l3));

// 干净代码不打扰
await setCode('#include <cstdio>\n\nstruct Node {\n    int id;\n};\n\nint main() {\n    for (int i = 0; i < 3; i++) {\n        printf("%d\\n", i);\n    }\n    return 0;\n}\n');
await page.waitForTimeout(400);
const l4 = await lintState();
ok('正常代码零提示', l4.hidden && l4.probs.length === 0, JSON.stringify(l4));

// 设置里关掉
await page.evaluate(() => window.__pc.settingsModal());
await page.waitForTimeout(250);
await page.click('#m-lint');
await page.waitForTimeout(150);
await page.evaluate(() => window.__pc.closeModal());
await setCode('int main() {\n    int a = 1\n    return 0;\n}\n');
await page.waitForTimeout(400);
const l5 = await lintState();
ok('设置里关闭后不再提示', l5.hidden && l5.warnLines.length === 0, JSON.stringify(l5));

// 再打开
await page.evaluate(() => window.__pc.settingsModal());
await page.waitForTimeout(250);
await page.click('#m-lint');
await page.waitForTimeout(150);
await page.evaluate(() => window.__pc.closeModal());
await page.waitForTimeout(400);
const l6 = await lintState();
ok('重新开启后恢复提示', !l6.hidden && l6.warnLines.includes(2), JSON.stringify(l6.warnLines));

// 开关持久化
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pocketcode.settings.v2') || '{}').realtimeLint);
ok('开关状态已持久化', saved === true, 'realtimeLint=' + saved);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
ok('无控制台报错', errs.length === 0, errs.slice(0, 3).join(' | '));
await b.close();
process.exit(fail ? 1 : 0);
