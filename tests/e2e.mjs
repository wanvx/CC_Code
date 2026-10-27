// 端到端验证：手机视口打开 IDE → 补全 → 缩放 → 编译运行
import { chromium, devices } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8341';
const shot = (n) => `shots/${n}.png`;

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.screenshot({ path: shot('01-home'), fullPage: false });

// 1. 编辑器渲染
const hlLen = await page.locator('#hl-code span').count();
const gutter = await page.locator('#gutter-inner .gl').count();
console.log('highlight spans =', hlLen, '| gutter lines =', gutter);
if (hlLen < 20) throw new Error('语法高亮未生效');

// 2. 文件树 & 标签
console.log('tabs =', await page.locator('.tab').count(), '| tree rows =', await page.locator('.tree-row').count());

// 3. 自动补全：输入 "pr"
await page.click('#code-wrap');
await page.keyboard.press('Control+Home');
await page.keyboard.type('pri', { delay: 60 });
await page.waitForTimeout(400);
const acVisible = await page.locator('#ac:not(.hidden)').count();
const acItems = await page.locator('.ac-item').count();
console.log('autocomplete visible =', acVisible, '| items =', acItems);
await page.screenshot({ path: shot('02-autocomplete') });
if (!acVisible || acItems < 3) throw new Error('自动补全未触发');
// 选择 printf（Tab 确认；回车现在是换行）
await page.keyboard.press('Tab');
const val = await page.locator('#ta').inputValue();
if (!val.startsWith('printf')) throw new Error('补全插入失败');
// 撤销输入，还原源码（恢复到以 #include 开头为止）
for (let i = 0; i < 12; i++) {
  const v = await page.locator('#ta').inputValue();
  if (v.startsWith('#include')) break;
  await page.keyboard.press('Control+z');
}
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

// 4. Ctrl+滚轮缩放
const fs0 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--code-fs'));
await page.locator('#code-wrap').hover();
await page.keyboard.down('Control');
await page.mouse.wheel(0, -400);
await page.keyboard.up('Control');
await page.waitForTimeout(150);
const fs1 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--code-fs'));
console.log('font-size:', fs0, '→', fs1);
if (parseFloat(fs1) <= parseFloat(fs0)) throw new Error('Ctrl+滚轮缩放未生效');
await page.screenshot({ path: shot('03-zoom') });

// 5. 签名提示：输入 printf(
await page.click('#code-wrap');
await page.keyboard.press('Control+Home');
await page.keyboard.type('printf(', { delay: 40 });
await page.waitForTimeout(300);
const sigVisible = await page.locator('#sig:not(.hidden)').count();
console.log('signature help visible =', sigVisible);
await page.screenshot({ path: shot('04-sighelp') });
for (let i = 0; i < 12; i++) {
  const v = await page.locator('#ta').inputValue();
  if (v.startsWith('#include')) break;
  await page.keyboard.press('Control+z');
}
await page.keyboard.press('Escape');
await page.waitForTimeout(150);

// 6. 切到 hello.c 运行（真实编译）
await page.click('#btn-drawer');
await page.waitForTimeout(250);
await page.click('.tree-row[data-path="hello.c"]');
await page.waitForTimeout(200);
await page.click('#btn-run');
console.log('running compile...');
await page.waitForFunction(
  () => document.querySelector('#st-status').textContent.includes('退出码') || document.querySelector('#st-status').textContent.includes('失败'),
  null, { timeout: 180000, polling: 1000 }
);
const status = await page.locator('#st-status').textContent();
const term = await page.locator('#terminal').textContent();
console.log('status =', status);
console.log('terminal =', JSON.stringify(term.slice(0, 400)));
await page.screenshot({ path: shot('05-run-c') });
if (!/Hello, PocketCode!/.test(term) || !/1\.\.100 = 5050/.test(term)) throw new Error('C 编译运行输出不符');
if (!/退出码 0/.test(status)) throw new Error('C 退出码非 0');

// 7. C++ demo 运行（含本地头文件内联）
await page.click('.tab[data-tab="src/main.cpp"]');
await page.waitForTimeout(200);
await page.click('#btn-run');
await page.waitForFunction(
  () => document.querySelector('#st-status').textContent.includes('退出码') || document.querySelector('#st-status').textContent.includes('失败'),
  null, { timeout: 180000, polling: 1000 }
);
const status2 = await page.locator('#st-status').textContent();
const term2 = await page.locator('#terminal').textContent();
console.log('status2 =', status2);
console.log('terminal2 =', JSON.stringify(term2.slice(0, 500)));
await page.screenshot({ path: shot('06-run-cpp') });
if (!/面积排行/.test(term2) || !/退出码 0/.test(status2)) throw new Error('C++ 编译运行输出不符');

// 8. 错误检测
await page.click('#code-wrap');
await page.keyboard.press('Control+End');
await page.keyboard.type('\nint x = ;', { delay: 30 });
await page.click('#btn-run');
await page.waitForFunction(
  () => document.querySelector('#st-status').textContent.includes('失败') || document.querySelector('#st-status').textContent.includes('退出码'),
  null, { timeout: 180000, polling: 1000 }
);
const st3 = await page.locator('#st-status').textContent();
console.log('status3 =', st3);
await page.screenshot({ path: shot('07-problems') });
if (!/失败/.test(st3)) throw new Error('编译错误未被识别');
const problems = await page.locator('.prob').count();
console.log('problems listed =', problems);
await page.keyboard.press('Control+z');

console.log('\nPAGE ERRORS:', errors.length ? errors : 'none');
console.log('ALL PASSED');
await browser.close();
