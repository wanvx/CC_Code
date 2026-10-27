import { chromium } from 'playwright';
const URL0 = 'https://pocketcode-ide.app.workbuddy.host/?sharecode=S62VZQDDME';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 412, height: 915 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(URL0, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__pc, null, { timeout: 90000 });
const info = await p.evaluate(() => window.__pc.appInfo);
const hasLint = await p.evaluate(async () => {
  const pc = window.__pc;
  pc.state.vfs.write('main.cpp', 'int main() {\n    int a = 1\n    return 0;\n}\n');
  pc.renderTree();
  pc.openFile('main.cpp');
  await new Promise((r) => setTimeout(r, 600));
  return {
    warnLines: [...document.querySelectorAll('#hl .cl.warn')].map((e) => +e.querySelector('.ln').textContent),
    probs: [...document.querySelectorAll('#problems .prob .p-msg')].map((e) => e.textContent),
    badge: (document.querySelector('#st-lint') || {}).textContent
  };
});
/* 补全首项 */
const ac = await p.evaluate(async () => {
  const ed = window.__pc.editor;
  ed.setValue('int main() {\n    \n    return 0;\n}\n', true);
  ed.ta.focus();
  const pos = ed.ta.value.indexOf('    \n') + 4;
  ed.ta.setSelectionRange(pos, pos);
  ed.insert('pr');
  ed.updateAutocomplete();
  const before = { idx: ed.acIndex, pre: [...document.querySelectorAll('#ac .ac-item')].findIndex((e) => e.classList.contains('pre')) };
  ed.moveAc(1);
  const after = { idx: ed.acIndex, sel: [...document.querySelectorAll('#ac .ac-item')].findIndex((e) => e.classList.contains('sel')) };
  ed.hideAc();
  return { before, after };
});
console.log('online version =', JSON.stringify(info));
console.log('lint =', JSON.stringify(hasLint));
console.log('ac =', JSON.stringify(ac));
console.log('errors =', errs.length ? errs.slice(0, 2) : 'none');
await p.screenshot({ path: 'shots/online-v14.png' });
await b.close();
