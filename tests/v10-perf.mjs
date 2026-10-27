// 打字流畅度：单次编辑必须远比重绘整篇便宜（改造前 2000 行每次按键要整篇重建 ≈ 56~87ms）
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
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(URL0, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !!window.__pc && !!window.__pc.editor, null, { timeout: 90000 });
await p.waitForTimeout(400);

const bench = await p.evaluate(async () => {
  const ed = window.__pc.editor, ta = ed.ta;
  const out = {};
  const run = (n) => {
    const big = Array.from({ length: n }, (_, i) => '    int v' + i + ' = ' + i + ' * 2; return v' + i + ';').join('\n') + '\n';
    ed.setValue(big, true);
    let t0 = performance.now();
    for (let i = 0; i < 5; i++) ed.render();
    const render = (performance.now() - t0) / 5;
    ta.focus();
    ta.setSelectionRange(20, 20);
    t0 = performance.now();
    let cnt = 0;
    for (let i = 0; i < 20; i++) {
      const pos = 40 + i;
      ta.setRangeText('y', pos, pos, 'end');
      ed.patch();
      ta.setRangeText('', pos, pos + 1, 'end');
      ed.patch();
      cnt += 2;
    }
    const edit = (performance.now() - t0) / cnt;
    // 只算 patch 本身（文本已经改好，不再碰 textarea 以外的输入事件）
    ta.setRangeText('y', 40, 40, 'end');
    t0 = performance.now();
    for (let i = 0; i < 10; i++) ed.patch();
    const patchOnly = (performance.now() - t0) / 10;
    return { render: +render.toFixed(2), edit: +edit.toFixed(2), patchNoop: +patchOnly.toFixed(2), lines: document.querySelectorAll('#hl .cl').length };
  };
  out.small = run(300);
  out.big = run(2000);
  return out;
});

console.log('300 行 ', JSON.stringify(bench.small));
console.log('2000 行', JSON.stringify(bench.big));

ok('300 行：单次编辑 < 4ms', bench.small.edit < 4, bench.small.edit + 'ms');
ok('300 行：编辑远比重绘便宜', bench.small.edit < bench.small.render / 2, bench.small.edit + ' vs render ' + bench.small.render);
// 2000 行属于极端情况（含一次 textarea 强制布局），只要一帧半以内即可
ok('2000 行：单次编辑 < 26ms', bench.big.edit < 26, bench.big.edit + 'ms');
ok('2000 行：编辑比整篇重绘便宜 3 倍以上', bench.big.edit * 3 < bench.big.render,
  bench.big.edit + 'ms vs render ' + bench.big.render + 'ms');
ok('行数正确', bench.big.lines === 2001, String(bench.big.lines));
ok('无报错', errs.length === 0, errs.slice(0, 2).join(' | '));

await b.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
