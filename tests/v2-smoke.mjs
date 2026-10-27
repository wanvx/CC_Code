// 新版快速冒烟：加载 → 建目录 → 建文件 → 运行 → cph
import { chromium, devices } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8341';
const shot = (n) => `shots/v2-${n}.png`;

const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
await page.screenshot({ path: shot('01-home') });

const step = (s) => console.log('── ' + s);

const openSide = async () => {
  await page.evaluate(() => { window.__pc.closeModal(); window.__pc.openFilesView(); window.__pc.openDrawer(); });
  await page.waitForTimeout(300);
};

// 1. 树结构
step('tree');
await openSide();
const rows = await page.locator('#filetree .tree-row').count();
const cols = await page.locator('#filetree .tree-row .act').count();
console.log('tree rows =', rows, '| act buttons =', cols);
console.log('root row text =', (await page.locator('#filetree .tree-row.is-root').innerText()).replace(/\n/g, ' '));

// 2. 新建文件夹（root 上）
step('mkdir');
await openSide();
await page.locator('#filetree .tree-row.is-root [data-mkdir]').click();
await page.locator('#m-name').fill('algo');
await page.locator('#m-ok').click();
await page.waitForTimeout(200);
console.log('has dir row =', await page.locator('#filetree .tree-row.dir[data-dir="algo"]').count());

// 3. 在新目录里建 cpp（不写后缀）
step('mkfile');
await openSide();
await page.locator('#filetree .tree-row.dir[data-dir="algo"] [data-mkfile]').click();
await page.locator('#m-name').fill('two_sum');
await page.locator('#m-ok').click();
await page.waitForTimeout(200);
console.log('has file row =', await page.locator('#filetree .tree-row.file[data-file="algo/two_sum.cpp"]').count());
console.log('title =', await page.locator('#title-file').innerText());

// 4. 写入代码并运行
step('run');
const code = `#include <cstdio>
int main(){int a,b;scanf("%d %d",&a,&b);printf("%d\\n",a+b);return 0;}`;
await page.evaluate((c) => { window.__pc.openFile('algo/two_sum.cpp'); window.__pc.editor.setValue(c, true); }, code);
await page.locator('#btn-run').click();
await page.waitForFunction(() => /运行完成|编译失败/.test(document.querySelector('#st-status').textContent), { timeout: 60000 });
console.log('status =', await page.locator('#st-status').innerText());
console.log('terminal tail =', (await page.locator('#terminal').innerText()).split('\n').slice(-3).join(' | '));

// 5. 打开 cph 插件
step('cph');
await page.locator('#plugin-rail [data-plug="cph"]').click();
await page.waitForTimeout(300);
console.log('side title =', await page.locator('#side-title').innerText());
await page.screenshot({ path: shot('02-cph-empty') });

// 6. 添加测试点并填内容
await page.locator('.cph-add').click();
await page.waitForTimeout(200);
const tas = page.locator('.cph-card .cph-ta');
console.log('test card =', await page.locator('.cph-card').count(), '| textareas =', await tas.count());
await tas.nth(0).fill('3 4\n');
await tas.nth(1).fill('7\n');
await page.locator('.cph-card .cph-mini').first().click();
await page.waitForFunction(() => !/运行中/.test(document.querySelector('.cph-badge') ? document.querySelector('.cph-badge').textContent : ''), { timeout: 60000 });
await page.waitForTimeout(500);
console.log('badge =', await page.locator('.cph-badge').first().innerText());
console.log('actual =', JSON.stringify(await page.locator('.cph-actual').first().innerText()));
console.log('score =', await page.locator('.cph-score').innerText());

// 7. 全部运行
await page.locator('.cph-run-all').click();
await page.waitForTimeout(1500);
console.log('score after runall =', await page.locator('.cph-score').innerText());
await page.screenshot({ path: shot('03-cph-pass') });

// 8. 失败用例
await page.locator('.cph-add').click();
await page.waitForTimeout(200);
await page.locator('.cph-card').nth(1).locator('.cph-ta').nth(0).fill('1 1\n');
await page.locator('.cph-card').nth(1).locator('.cph-ta').nth(1).fill('3\n');
await page.locator('.cph-run-all').click();
await page.waitForTimeout(2500);
console.log('badges =', await page.locator('.cph-badge').allInnerTexts());
console.log('score2 =', await page.locator('.cph-score').innerText());
await page.screenshot({ path: shot('04-cph-mixed') });

// 9. 持久化检查
const saved = await page.evaluate(() => localStorage.getItem('pocketcode.cph.v1'));
console.log('cph persisted keys =', Object.keys(JSON.parse(saved || '{}')));

// 10. 设置面板
step('settings');
await page.mouse.click(395, 400);
await page.waitForTimeout(250);
await page.locator('#btn-settings').click();
await page.waitForTimeout(300);
console.log('plugin rows =', await page.locator('.plug-row').count());
console.log('has prefill switch =', await page.locator('#m-prefill-on').count());
console.log('has import btn =', await page.locator('#m-import').count());
await page.screenshot({ path: shot('05-settings') });

// 11. 重命名 & 删除
step('rename/delete');
await openSide();
await page.locator('#filetree .tree-row.file[data-file="algo/two_sum.cpp"] [data-menu]').click();
await page.locator('#m-rename').click();
await page.locator('#m-name').fill('a_plus_b.cpp');
await page.locator('#m-ok').click();
await page.waitForTimeout(250);
console.log('renamed ok =', await page.locator('#filetree .tree-row.file[data-file="algo/a_plus_b.cpp"]').count());
console.log('title after rename =', await page.locator('#title-file').innerText());

await page.locator('#filetree .tree-row.dir[data-dir="algo"] [data-menu]').click();
await page.locator('#m-del').click();
await page.locator('#m-ok').click();
await page.waitForTimeout(300);
console.log('dir removed =', await page.locator('#filetree .tree-row.dir[data-dir="algo"]').count() === 0);

// 12. 预填内容开关
step('prefill');
await page.mouse.click(395, 400);
await page.waitForTimeout(200);
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('pocketcode.settings.v2') || '{}');
  s.prefillOn = true;
  s.prefillText = '// TEMPLATE\nint main(){}\n';
  localStorage.setItem('pocketcode.settings.v2', JSON.stringify(s));
});
await page.reload({ waitUntil: 'networkidle' });
await openSide();
await page.locator('#filetree .tree-row.is-root [data-mkfile]').click();
await page.locator('#m-name').fill('tpl_test');
await page.locator('#m-ok').click();
await page.waitForTimeout(300);
const filled = await page.evaluate(() => window.__pc.state.vfs.read('tpl_test.cpp'));
console.log('prefilled =', JSON.stringify(filled));

console.log('\nERRORS:', errors.length ? errors : 'none');
await browser.close();
