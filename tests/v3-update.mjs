// 检查更新：真实网络 + 模拟新版本 + 断网失败
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:8341/';
const SHOT = new URL('../shots/', import.meta.url).pathname.replace(/^\//, '');
fs.mkdirSync(SHOT, { recursive: true });

const errors = [];
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// A. 真实网络：仓库里的版本与当前一致 => 已是最新
await page.evaluate(() => { localStorage.removeItem('cccode.update.checkedAt'); });
await page.evaluate(() => window.__pc.checkUpdate(true));
await page.waitForFunction(() => /已是最新|检查失败|有新版本/.test(document.querySelector('#st-status').textContent), null, { timeout: 30000 });
console.log('A status =', await page.locator('#st-status').innerText());
console.log('A toast  =', await page.locator('#toast').innerText());

// B. 模拟仓库有新版本
await page.route(/version\.json/, (route) => route.fulfill({
  status: 200,
  headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'CC_Code', version: '1.3.0', versionCode: 7, released: '2026-11-01',
    notes: '新增：主题切换\n修复：长行横向滚动时行号偏移',
    apk: 'https://github.com/wanvx/CC_Code/releases/latest/download/CC_Code.apk'
  })
}));
await page.evaluate(() => window.__pc.checkUpdate(true));
await page.waitForSelector('#modal:not(.hidden)', { timeout: 15000 });
console.log('B modal title =', await page.locator('#modal-title').innerText());
console.log('B modal body  =', (await page.locator('.modal-body').innerText()).replace(/\n/g, ' | '));
console.log('B button      =', await page.locator('#m-get').innerText());
await page.screenshot({ path: SHOT + 'v3-03-update.png' });

// 点「稍后」关闭
await page.locator('#m-cancel').click();
await page.waitForTimeout(300);
console.log('B closed =', await page.locator('#modal').evaluate((el) => el.classList.contains('hidden')));

// C. 三个源全失败 => 手动检查提示失败，且不改动其它功能
await page.unroute(/version\.json/);
await page.route(/version\.json|jsdelivr|contents\/version/, (route) => route.abort());
await page.evaluate(() => window.__pc.checkUpdate(true));
await page.waitForTimeout(1500);
console.log('C status =', await page.locator('#st-status').innerText());
console.log('C toast  =', await page.locator('#toast').innerText());

// D. 静默检查失败不打扰：清状态后直接跑一次自动检查
await page.evaluate(() => { localStorage.removeItem('cccode.update.checkedAt'); });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(6500);
console.log('D status after silent check =', await page.locator('#st-status').innerText());

console.log('\nERRORS:', errors.length ? errors : 'none');
await browser.close();
