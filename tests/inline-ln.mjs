import { chromium, devices } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
const p = await (await b.newContext({ ...devices['Pixel 7'] })).newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.goto('http://localhost:8341/?debug=1', { waitUntil: 'networkidle' });
await p.waitForTimeout(600);
await p.evaluate(() => {
  const ta = document.getElementById('ta');
  const arr = [];
  for (let i = 1; i <= 150; i++) {
    arr.push(i % 3 === 0
      ? '    int value_' + i + ' = ' + i * 2 + '; // 中文注释 第' + i + '行'
      : 'int a' + i + ' = ' + i + ';');
  }
  ta.value = arr.join('\n');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await p.waitForTimeout(500);
const r = await p.evaluate(() => {
  const cls = [...document.querySelectorAll('#hl .cl')];
  const rows = [];
  for (const cl of cls) {
    const ln = cl.querySelector('.ln');
    const lt = cl.querySelector('.lt');
    const lnR = ln.getBoundingClientRect();
    const clR = cl.getBoundingClientRect();
    let cTop = null, cBot = null, cH = null;
    const tn = lt && lt.firstChild;
    if (tn && tn.nodeType === 3 && tn.nodeValue.trim()) {
      const rg = document.createRange();
      rg.selectNodeContents(tn);
      const rc = rg.getBoundingClientRect();
      cTop = rc.top; cBot = rc.bottom; cH = rc.height;
    }
    rows.push({ h: +clR.height.toFixed(3), top: +clR.top.toFixed(3),
      dT: cTop == null ? null : +(lnR.top - cTop).toFixed(2),
      dB: cBot == null ? null : +(lnR.bottom - cBot).toFixed(2),
      cH: cH == null ? null : +cH.toFixed(2) });
  }
  const ds = rows.map((x) => x.dT).filter((v) => v != null);
  const db = rows.map((x) => x.dB).filter((v) => v != null);
  const span = +(rows[rows.length - 1].top - rows[0].top).toFixed(3);
  return {
    lines: rows.length,
    heights: [...new Set(rows.map((x) => x.h))],
    codeTextHeights: [...new Set(rows.map((x) => x.cH))],
    dTopRange: [Math.min(...ds), Math.max(...ds)],
    dBotRange: [Math.min(...db), Math.max(...db)],
    span, expect: (rows.length - 1) * 20, err: +(span - (rows.length - 1) * 20).toFixed(3),
  };
});
console.log(JSON.stringify(r, null, 2));
await p.screenshot({ path: 'shots/flex-ln.png', clip: { x: 0, y: 100, width: 340, height: 220 } });
await b.close();
