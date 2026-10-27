// 应用外壳：文件树 / 标签 / 编译运行 / 插件 / 导出 / 设置
import { CodeEditor } from './editor.js';
import { VFS, ROOT, langOf, isRunnable, inlineLocalIncludes, norm, parentOf, nameOf, join, displayPath } from './fs.js';
import { plugins, iconSvg } from './plugins.js';
import { cphPlugin, resetCphStore } from './plugins/cph.js';

const $ = (s) => document.querySelector(s);

// ── 应用信息（检查更新用，发版时同步 version.json） ──
const APP_NAME = 'CC_Code';
const APP_VERSION = '1.2.0';
const APP_VERSION_CODE = 6;
const REPO_OWNER = 'wanvx';
const REPO_NAME = 'CC_Code';
const REPO_URL = 'https://github.com/' + REPO_OWNER + '/' + REPO_NAME;
const AUTHOR_URL = 'https://github.com/' + REPO_OWNER;
const VERSION_SOURCES = [
  'https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/main/version.json',
  'https://cdn.jsdelivr.net/gh/' + REPO_OWNER + '/' + REPO_NAME + '@main/version.json',
  'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/contents/version.json'
];
const UPDATE_SEEN_KEY = 'cccode.update.seen';

const SETTINGS_KEY = 'pocketcode.settings.v2';
const DEFAULTS = {
  theme: 'dark',
  stdC: 'gnu17',
  stdCpp: 'gnu++17',
  args: '-Wall',
  fontSize: 13,
  stdin: '',
  prefillOn: false,
  prefillText: '#include <cstdio>\n\nint main() {\n    \n    return 0;\n}\n'
};
const VALID_STD = { stdC: ['gnu11', 'gnu17', 'gnu23'], stdCpp: ['gnu++11', 'gnu++14', 'gnu++17', 'gnu++20', 'gnu++23'] };

const state = {
  vfs: new VFS(),
  tabs: [],
  active: null,
  busy: false,
  settings: { ...DEFAULTS },
  open: new Set(),        // 展开的目录
  activePlugin: null,
  view: 'files'
};

let editor = null;
let worker = null;
let filePickCb = null;

// ── 工具 ───────────────────────────────
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) state.settings = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) { state.settings = { ...DEFAULTS }; }
  for (const k of Object.keys(VALID_STD)) {
    if (!VALID_STD[k].includes(state.settings[k])) state.settings[k] = DEFAULTS[k];
  }
  if (typeof state.settings.prefillOn !== 'boolean') state.settings.prefillOn = DEFAULTS.prefillOn;
  if (typeof state.settings.prefillText !== 'string') state.settings.prefillText = DEFAULTS.prefillText;
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) { /* 忽略 */ }
}

// ── 标准输入（跟文件走） ────────────────
const STDIN_KEY = 'pocketcode.stdin.v1';
let stdinMap = {};

function loadStdinStore() {
  try { stdinMap = JSON.parse(localStorage.getItem(STDIN_KEY) || '{}') || {}; } catch (e) { stdinMap = {}; }
}

/** 兼容旧版：settings.stdin 一次性迁到首个打开的文件 */
function migrateLegacyStdin(path) {
  const legacy = state.settings.stdin;
  if (!legacy || !path || stdinMap[path]) return;
  stdinMap[path] = legacy;
  saveStdinStore();
  state.settings.stdin = '';
  saveSettings();
}
function saveStdinStore() {
  try { localStorage.setItem(STDIN_KEY, JSON.stringify(stdinMap)); } catch (e) { /* 忽略 */ }
}
function stdinFor(path) { return (path && stdinMap[path]) || ''; }
function setStdinFor(path, text) {
  if (!path) return;
  if (text) stdinMap[path] = text;
  else delete stdinMap[path];
  saveStdinStore();
  updateStdinMeta();
}
function moveStdinKeys(from, to) {
  let changed = false;
  for (const k of Object.keys(stdinMap)) {
    if (k === from) { stdinMap[to] = stdinMap[k]; delete stdinMap[k]; changed = true; }
    else if (k.startsWith(from + '/')) {
      stdinMap[to + k.slice(from.length)] = stdinMap[k];
      delete stdinMap[k];
      changed = true;
    }
  }
  if (changed) saveStdinStore();
}
function dropStdinKeys(path) {
  let changed = false;
  for (const k of Object.keys(stdinMap)) {
    if (k === path || k.startsWith(path + '/')) { delete stdinMap[k]; changed = true; }
  }
  if (changed) saveStdinStore();
}

function stdinTa() { return $('#stdin-ta'); }

/** 把输入框切到指定文件的内容 */
function syncStdinBox(path) {
  const ta = stdinTa();
  if (!ta) return;
  ta.value = stdinFor(path);
  ta.disabled = !path || !isRunnable(path);
  updateStdinMeta();
}

function updateStdinMeta() {
  const el = $('#stdin-meta');
  if (!el) return;
  const path = state.active;
  if (!path || !isRunnable(path)) { el.textContent = '仅 .c/.cpp 可用'; return; }
  const v = stdinFor(path);
  if (!v) { el.textContent = '空'; return; }
  const lines = v.split(/\r?\n/).length;
  const bytes = new TextEncoder().encode(v).length;
  el.textContent = lines + ' 行 · ' + (bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KB');
}

function toast(msg, ms = 1900) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}
function setStatus(text, cls) {
  const el = $('#st-status');
  el.textContent = text;
  el.className = 'st-status' + (cls ? ' ' + cls : '');
}

// ── 外部链接 / 检查更新 ────────────────
const UPDATE_AT_KEY = 'cccode.update.checkedAt';
const UPDATE_TTL = 12 * 3600e3;

/** 原生环境走系统浏览器，网页版走新标签页 */
function openExternal(url) {
  const nat = window.PocketCodeNative;
  if (nat && typeof nat.openUrl === 'function') {
    try { nat.openUrl(url); return; } catch (e) { /* 回退到网页方式 */ }
  }
  const w = window.open(url, '_blank', 'noopener');
  if (!w) location.href = url;
}

/** 依次尝试 raw / jsDelivr / API 三个源，哪个通用哪个（网络环境差异较大） */
async function fetchUpdateInfo() {
  let lastErr = null;
  for (const src of VERSION_SOURCES) {
    try {
      const isApi = src.includes('api.github.com');
      const res = await fetch(src + (isApi ? '' : '?t=' + Date.now()), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (isApi) {
        // contents 接口把文件内容 base64 包在 content 字段里
        const b64 = String(data.content || '').replace(/\s/g, '');
        if (!b64) throw new Error('empty content');
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes));
      }
      if (data && data.versionCode != null) return data;
      throw new Error('bad payload');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('unreachable');
}

async function checkUpdate(manual) {
  if (manual) setStatus('检查更新…', 'busy');
  try {
    const info = await fetchUpdateInfo();
    try { localStorage.setItem(UPDATE_AT_KEY, String(Date.now())); } catch (e) { /* 忽略 */ }
    if ((Number(info.versionCode) || 0) > APP_VERSION_CODE) {
      if (manual) { setStatus('有新版本', 'ok'); showUpdateModal(info); }
      else notifyUpdate(info);
    } else if (manual) {
      setStatus('已是最新', 'ok');
      toast('已是最新版本 v' + APP_VERSION);
    }
  } catch (e) {
    // 静默检查失败不打扰（离线是正常状态），只有用户主动点才提示
    if (manual) {
      setStatus('检查失败', 'err');
      toast('检查失败：这个功能需要联网，离线时其它功能不受影响', 2800);
    }
  }
}

/** 静默检查：同一个版本只提醒一次 */
function notifyUpdate(info) {
  try {
    if (localStorage.getItem(UPDATE_SEEN_KEY) === String(info.version)) return;
    localStorage.setItem(UPDATE_SEEN_KEY, String(info.version));
  } catch (e) { /* 忽略 */ }
  toast(APP_NAME + ' v' + info.version + ' 可用，设置里可更新', 3200);
}

/** 启动后静默检查，12 小时节流，离线静默失败 */
function scheduleUpdateCheck() {
  let last = 0;
  try { last = Number(localStorage.getItem(UPDATE_AT_KEY) || 0); } catch (e) { /* 忽略 */ }
  if (Date.now() - last < UPDATE_TTL) return;
  setTimeout(() => { checkUpdate(false); }, 4000);
}

function showUpdateModal(info) {
  const isNative = !!window.PocketCodeNative;
  const notes = String(info.notes || '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => '<div class="upd-line">· ' + escapeHtml(l) + '</div>').join('');
  const body = '<div class="upd">' +
    '<div class="upd-head">当前 v' + APP_VERSION + ' → 最新 v' + escapeHtml(String(info.version)) + '</div>' +
    (notes ? '<div class="upd-notes">' + notes + '</div>' : '') +
    '<div class="hint">' + (isNative
      ? '下载后在平板上覆盖安装即可，已写的代码和设置都会保留。'
      : '网页版会清掉旧外壳缓存再刷新，编译器缓存保留，不会重下 28MB。') + '</div>' +
    '<div class="hint">版本记录：' + escapeHtml(String(info.released || '')) + '</div></div>';
  openModal('发现新版本', body,
    '<button class="btn" id="m-cancel">稍后</button>' +
    '<button class="btn primary" id="m-get">' + (isNative ? '下载新版本' : '重新加载') + '</button>');

  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-get').addEventListener('click', async () => {
    if (isNative) {
      openExternal(info.apk || (REPO_URL + '/releases/latest'));
      closeModal();
      return;
    }
    // 网页版：注销 SW + 清外壳缓存后重载，clang 资源保留
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => !/clang/.test(k)).map((k) => caches.delete(k)));
      }
    } catch (e) { /* 忽略 */ }
    location.reload();
  });
}
function setBusy(b) {
  state.busy = b;
  $('#btn-run').classList.toggle('busy', b);
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function isMobile() { return window.innerWidth <= 720; }
function splitArgs(s) { return (s || '').split(/\s+/).filter(Boolean); }

// ── 文件树 ─────────────────────────────
const SVG_FOLDER = '<svg class="ico" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const SVG_FILE = '<svg class="ico" viewBox="0 0 24 24"><path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/></svg>';
const SVG_MKDIR = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v4.5M9.8 13.2h4.4"/></svg>';
const SVG_MKFILE = '<svg viewBox="0 0 24 24"><path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/><path d="M12.5 11.5v5M10 14h5"/></svg>';
const SVG_MORE = '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.1" fill="currentColor" stroke="none"/></svg>';

function ensureOpenState() {
  for (const d of state.vfs.dirs()) {
    if (d && !state.open.has(d) && !state._seen) state.open.add(d);
  }
  state.open.add(ROOT);
  state._seen = true;
}

function actBtn(attr, val, title, svg) {
  return '<button class="act" data-' + attr + '="' + escapeHtml(val) + '" title="' + title + '" aria-label="' + title + '">' + svg + '</button>';
}

function renderTree() {
  ensureOpenState();
  const rows = [];
  rows.push({ kind: 'dir', path: ROOT, depth: 0, open: true, isRoot: true });
  const walk = (dir, depth) => {
    const ch = state.vfs.children(dir);
    for (const d of ch.dirs) {
      const open = state.open.has(d);
      rows.push({ kind: 'dir', path: d, depth, open });
      if (open) walk(d, depth + 1);
    }
    for (const f of ch.files) rows.push({ kind: 'file', path: f, depth });
  };
  walk(ROOT, 1);

  const html = rows.map((r) => {
    const pad = 6 + Math.min(r.depth, 6) * 11;
    const style = ' style="padding-left:' + pad + 'px"';
    if (r.kind === 'dir') {
      const caret = r.isRoot ? '<span class="caret-spacer"></span>' : '<span class="caret' + (r.open ? ' open' : '') + '"></span>';
      const name = r.isRoot ? 'root' : nameOf(r.path);
      const acts = actBtn('mkdir', r.path, '新建文件夹', SVG_MKDIR) +
                   actBtn('mkfile', r.path, '新建 .cpp 文件', SVG_MKFILE) +
                   (r.isRoot ? '' : actBtn('menu', r.path, '更多', SVG_MORE));
      return '<div class="tree-row dir' + (r.isRoot ? ' is-root' : '') + '" data-dir="' + escapeHtml(r.path) + '" data-toggle="' + escapeHtml(r.path) + '"' + style + '>' +
        caret + SVG_FOLDER + '<span class="name">' + escapeHtml(name) + '</span>' +
        '<span class="acts">' + acts + '</span></div>';
    }
    const active = r.path === state.active ? ' active' : '';
    return '<div class="tree-row file' + active + '" data-file="' + escapeHtml(r.path) + '"' + style + '>' +
      SVG_FILE + '<span class="name">' + escapeHtml(nameOf(r.path)) + '</span>' +
      '<span class="acts">' + actBtn('menu', r.path, '更多', SVG_MORE) + '</span></div>';
  }).join('');

  $('#filetree').innerHTML = html;
}

function bindTree() {
  $('#filetree').addEventListener('click', (e) => {
    const t = e.target.closest('button, .tree-row');
    if (!t) return;

    if (t.dataset.mkdir !== undefined) { e.stopPropagation(); newFolderModal(t.dataset.mkdir); return; }
    if (t.dataset.mkfile !== undefined) { e.stopPropagation(); newCppModal(t.dataset.mkfile); return; }
    if (t.dataset.menu !== undefined) { e.stopPropagation(); itemMenu(t.dataset.menu); return; }

    const row = e.target.closest('.tree-row');
    if (!row) return;
    if (row.dataset.dir !== undefined) {
      const p = row.dataset.dir;
      if (!p) return;               // root 无折叠
      if (state.open.has(p)) state.open.delete(p); else state.open.add(p);
      renderTree();
      return;
    }
    if (row.dataset.file !== undefined) {
      openFile(row.dataset.file);
      if (isMobile()) closeDrawer();
    }
  });
}

function itemMenu(path) {
  const isDir = state.vfs.isDir(path);
  const name = nameOf(path) || 'root';
  openModal(isDir ? '文件夹操作' : '文件操作',
    '<div class="field"><label>' + escapeHtml(displayPath(path)) + '</label>' +
    '<div class="hint">' + (isDir ? '重命名只改这一层，内部内容跟着走。' : '') + '</div></div>',
    '<button class="btn" id="m-cancel">取消</button>' +
    '<button class="btn" id="m-rename">重命名</button>' +
    '<button class="btn danger" id="m-del">删除</button>');
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-rename').addEventListener('click', () => {
    closeModal();
    renameModal(path);
  });
  $('#m-del').addEventListener('click', () => {
    closeModal();
    if (isDir) {
      const ch = state.vfs.children(path);
      const n = ch.files.length + ch.dirs.length;
      confirmModal('删除文件夹', '将删除「' + name + '」及其内部 ' + n + ' 项内容，无法恢复。确定？', () => {
        state.vfs.removeDir(path);
        afterDelete(path);
      });
    } else {
      confirmModal('删除文件', '确定删除 ' + displayPath(path) + ' ？', () => {
        state.vfs.removeFile(path);
        afterDelete(path);
      });
    }
  });
}

function afterDelete(path) {
  dropStdinKeys(path);
  state.tabs = state.tabs.filter((t) => t !== path && !t.startsWith(path + '/'));
  if (state.active && (state.active === path || state.active.startsWith(path + '/'))) {
    state.active = state.tabs[0] || null;
    if (state.active) openFile(state.active);
    else blankEditor();
  }
  renderTree(); renderTabs(); refreshPluginPanel();
  toast('已删除');
}

function blankEditor() {
  state.active = null;
  editor.setValue('');
  syncStdinBox(null);
  $('#title-file').textContent = '未打开文件';
  $('#st-lang').textContent = '';
  $('#st-std').textContent = '—';
  editor.setDiagnostics([]);
}

function renameModal(path) {
  const old = nameOf(path);
  openModal('重命名',
    '<div class="field"><label>新名称</label><input id="m-name" type="text" value="' + escapeHtml(old) + '">' +
    '<div class="hint">只改名称，不改变所在位置。</div></div>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-ok">确定</button>');
  const input = $('#m-name');
  input.focus(); input.select();
  const done = () => {
    const nn = input.value.trim();
    if (!nn) { toast('名称不能为空'); return; }
    if (nn.includes('/')) { toast('名称不能包含 /'); return; }
    if (!state.vfs.rename(path, nn)) { toast('该名称已存在'); return; }
    const np = join(parentOf(path), nn);
    moveStdinKeys(path, np);
    state.tabs = state.tabs.map((t) => (t === path ? np : t.startsWith(path + '/') ? np + t.slice(path.length) : t));
    if (state.active === path) state.active = np;
    else if (state.active && state.active.startsWith(path + '/')) state.active = np + state.active.slice(path.length);
    if (state.active) {
      const lang = langOf(state.active);
      $('#title-file').textContent = nameOf(state.active);
      $('#st-lang').textContent = lang === 'c' ? 'C' : lang === 'cpp' ? 'C++' : lang === 'header' ? 'Header' : 'Text';
      $('#st-std').textContent = lang === 'c' ? state.settings.stdC : lang === 'cpp' ? state.settings.stdCpp : '—';
    }
    closeModal(); renderTree(); renderTabs(); refreshPluginPanel();
    toast('已重命名');
  };
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-ok').addEventListener('click', done);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
}

function newFolderModal(dir) {
  openModal('新建文件夹',
    '<div class="field"><label>文件夹名称</label><input id="m-name" type="text" placeholder="新建文件夹">' +
    '<div class="hint">位置：' + escapeHtml(displayPath(dir)) + '</div></div>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-ok">创建</button>');
  const input = $('#m-name');
  input.focus();
  const done = () => {
    const name = input.value.trim();
    if (!name) { toast('请输入文件夹名称'); return; }
    if (name.includes('/')) { toast('名称不能包含 /'); return; }
    const p = state.vfs.mkdir(dir, name);
    if (!p) { toast('创建失败'); return; }
    state.open.add(dir); state.open.add(p);
    closeModal(); renderTree();
    toast('已创建 ' + nameOf(p));
  };
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-ok').addEventListener('click', done);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
}

// 新建源文件：不写后缀默认 .cpp
function newCppModal(dir) {
  openModal('新建 C++ 文件',
    '<div class="field"><label>文件名</label><input id="m-name" type="text" placeholder="solution">' +
    '<div class="hint">不写后缀自动补 .cpp。位置：' + escapeHtml(displayPath(dir)) + '</div></div>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-ok">创建</button>');
  const input = $('#m-name');
  input.focus();
  const done = () => {
    let name = input.value.trim();
    if (!name) name = 'untitled';
    if (name.includes('/')) { toast('名称不能包含 /'); return; }
    if (!/\.[A-Za-z0-9+#]+$/.test(name)) name += '.cpp';
    const ext = (name.split('.').pop() || '').toLowerCase();
    const useTpl = ext === 'cpp' && state.settings.prefillOn;
    const content = useTpl ? state.settings.prefillText : '';
    const p = state.vfs.createFile(dir, name, content);
    if (!p) { toast('创建失败'); return; }
    state.open.add(dir);
    closeModal(); renderTree();
    openFile(p);
    if (isMobile()) closeDrawer();
  };
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-ok').addEventListener('click', done);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
}

// ── 标签 ───────────────────────────────
function renderTabs() {
  const html = state.tabs.map((p) => {
    const on = p === state.active ? ' active' : '';
    return '<div class="tab' + on + '" data-tab="' + escapeHtml(p) + '">' +
      '<span>' + escapeHtml(nameOf(p)) + '</span>' +
      '<span class="t-close" data-close="' + escapeHtml(p) + '">✕</span></div>';
  }).join('');
  $('#tabs').innerHTML = html;
}

function bindTabs() {
  $('#tabs').addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) { e.stopPropagation(); closeTab(closeBtn.dataset.close); return; }
    const tab = e.target.closest('.tab');
    if (tab) openFile(tab.dataset.tab);
  });
}

function closeTab(p) {
  state.tabs = state.tabs.filter((t) => t !== p);
  if (state.active === p) {
    const next = state.tabs[state.tabs.length - 1] || null;
    if (next) openFile(next);
    else blankEditor();
  }
  renderTabs(); renderTree();
}

function openFile(path) {
  if (!state.vfs.exists(path)) return;
  const content = state.vfs.read(path);
  state.active = path;
  if (!state.tabs.includes(path)) state.tabs.push(path);
  editor.setValue(content, true);
  const lang = langOf(path);
  editor.setLanguage(lang === 'c' ? 'c' : 'cpp');
  $('#title-file').textContent = nameOf(path);
  $('#st-lang').textContent = lang === 'c' ? 'C' : lang === 'cpp' ? 'C++' : lang === 'header' ? 'Header' : 'Text';
  $('#st-std').textContent = lang === 'c' ? state.settings.stdC : lang === 'cpp' ? state.settings.stdCpp : '—';
  editor.setDiagnostics([]);
  renderTabs(); renderTree();
  migrateLegacyStdin(path);
  syncStdinBox(path);
  refreshPluginPanel();
  requestAnimationFrame(() => editor.focus());
}

// ── 编译运行 ───────────────────────────
let runSeq = 0;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url));
  const ch = new MessageChannel();
  ch.port1.onmessage = onProxyFetch;
  worker.postMessage({ type: 'init', port: ch.port2 }, [ch.port2]);
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => {
    setBusy(false);
    setStatus('Worker 错误', 'err');
    termLine('[worker] ' + (e.message || '未知错误'), 't-err');
    for (const [, p] of pending) p.reject(new Error('Worker 异常'));
    pending.clear();
  };
  return worker;
}

function onProxyFetch(e) {
  const { id, url } = e.data || {};
  fetch(url, { credentials: 'include' })
    .then(async (res) => {
      const buf = await res.arrayBuffer();
      e.target.postMessage({ id, ok: res.ok, status: res.status, buf }, [buf]);
    })
    .catch((err) => {
      e.target.postMessage({ id, error: String((err && err.message) || err) });
    });
}

function onWorkerMessage(e) {
  const m = e.data || {};
  const p = pending.get(m.id);
  if (!p) return;
  if (m.type === 'progress') { if (p.onProgress) p.onProgress(m.value); return; }
  if (m.type === 'status') {
    if (m.phase === 'loading') setStatus('加载编译器…', 'busy');
    if (m.phase === 'compiling') setStatus('编译中…', 'busy');
    return;
  }
  if (m.type === 'error') { pending.delete(m.id); p.reject(new Error(m.message)); return; }
  if (m.type === 'result') { pending.delete(m.id); p.resolve(m); }
}

function runProgram(opts) {
  const id = ++runSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress: opts.onProgress });
    ensureWorker().postMessage({
      type: 'run', id,
      code: opts.code,
      language: opts.language,
      std: opts.std,
      fileName: opts.fileName,
      compileArgs: opts.compileArgs || [],
      args: opts.args || [],
      stdin: opts.stdin || ''
    });
  });
}

/** 当前文件的源码（含本地 #include 内联） */
function buildSource(path) {
  const code = path === state.active ? editor.value : (state.vfs.read(path) || '');
  return inlineLocalIncludes(code, path, (p) => state.vfs.read(p));
}

function runOptions(path) {
  const lang = langOf(path);
  return {
    language: lang,
    std: lang === 'c' ? state.settings.stdC : state.settings.stdCpp,
    fileName: nameOf(path),
    compileArgs: splitArgs(state.settings.args)
  };
}

async function runActive() {
  if (state.busy) return;
  const path = state.active;
  if (!path) { toast('先打开一个源文件'); return; }
  if (!isRunnable(path)) { toast('请选择一个 .c 或 .cpp 源文件'); return; }

  setBusy(true);
  setStatus('准备中…', 'busy');
  showPanel('output');
  termClear();
  const o = runOptions(path);
  termLine('▶ ' + nameOf(path) + '   [' + (o.language === 'c' ? 'clang C' : 'clang C++') + ' · ' + o.std + ']', 't-cmd');
  const stdinText = stdinFor(path);
  if (stdinText) termLine('⌨ 输入 ' + stdinText.split(/\r?\n/).length + ' 行', 't-dim');
  else termLine('⌨ 无输入（可在下方输入框填写）', 't-dim');
  try {
    const r = await runProgram({ code: buildSource(path), ...o, stdin: stdinText });
    renderResult(r);
  } catch (err) {
    setStatus('出错', 'err');
    termLine('[错误] ' + ((err && err.message) || err), 't-err');
  } finally {
    setBusy(false);
  }
}

/** 供插件调用：不写终端，只把结果交给插件 */
async function pluginRun(stdin) {
  const path = state.active;
  if (!path || !isRunnable(path)) throw new Error('当前文件不可编译（需要 .c / .cpp）');
  const o = runOptions(path);
  setStatus('编译中…', 'busy');
  try {
    const r = await runProgram({ code: buildSource(path), ...o, stdin: stdin || '' });
    const bad = r.errors && r.errors.length;
    setStatus(bad ? '编译失败' : '运行完成', bad ? 'err' : 'ok');
    return r;
  } catch (e) {
    setStatus('出错', 'err');
    throw e;
  }
}

function parseProblems(errors) {
  const out = [];
  for (const line of errors) {
    const m = /^(.+?):(\d+):(\d+):\s*(error|warning|fatal error|note):\s*(.*)$/.exec(line);
    if (m) out.push({ file: m[1], line: +m[2], col: +m[3], severity: m[4], message: m[5] });
  }
  return out;
}

function renderResult(r) {
  const problems = parseProblems(r.errors || []);
  const errs = problems.filter((p) => p.severity !== 'note');
  renderProblems(errs);
  editor.setDiagnostics(errs);

  if (r.errors && r.errors.length) {
    setStatus('编译失败 · ' + errs.length + ' 个问题', 'err');
    termLine('✕ 编译失败  (' + r.compileMs + ' ms)', 't-err');
    for (const line of r.errors) {
      const isErr = /error:/.test(line);
      if (/^\s*(\d+\s*\||\s*\|)/.test(line)) termLine(line, 't-dim');
      else termLine(line, isErr ? 't-err' : /warning:/.test(line) ? 't-warn' : 't-dim');
    }
    if (errs.length) showPanel('problems');
    return;
  }

  setStatus('运行完成 · 退出码 ' + r.exitCode, r.exitCode === 0 ? 'ok' : 'err');
  termLine('✓ 编译通过  (' + r.compileMs + ' ms)', 't-ok');
  if (r.output) termLine(r.output.replace(/\n$/, ''), 't-out');
  termLine('— 进程结束，退出码 ' + r.exitCode + (r.runMs != null ? '，用时 ' + r.runMs + ' ms' : ''), 't-dim');
  showPanel('output');
}

function renderProblems(list) {
  const chip = $('#problem-count');
  chip.textContent = list.length;
  chip.classList.toggle('has', list.length > 0);

  if (!list.length) {
    $('#problems').innerHTML = '<div class="prob-empty">没有发现问题 ✓</div>';
    return;
  }
  $('#problems').innerHTML = list.map((p) =>
    '<div class="prob ' + (p.severity === 'warning' ? 'warning' : 'error') + '" data-line="' + p.line + '" data-col="' + p.col + '">' +
    '<span class="p-ico">' + (p.severity === 'warning' ? '▲' : '✕') + '</span>' +
    '<div><div class="p-msg">' + escapeHtml(p.message) + '</div>' +
    '<div class="p-loc">' + escapeHtml(p.file) + ':' + p.line + ':' + p.col + '</div></div></div>'
  ).join('');
  $('#problems').querySelectorAll('.prob').forEach((el) => {
    el.addEventListener('click', () => {
      editor.gotoLine(+el.dataset.line, +el.dataset.col);
      if (isMobile()) $('#panel').classList.add('collapsed');
    });
  });
}

// ── 输出面板 ───────────────────────────
function termClear() { $('#terminal').innerHTML = ''; }
function termLine(text, cls) {
  const el = document.createElement('div');
  if (cls) el.className = cls;
  el.textContent = text;
  $('#terminal').appendChild(el);
  $('#terminal').scrollTop = $('#terminal').scrollHeight;
}
function showPanel(tab) {
  $('#panel').classList.remove('collapsed');
  switchPanelTab(tab || 'output');
}
function switchPanelTab(tab) {
  document.querySelectorAll('.panel-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === (tab === 'problems' ? 'problems' : 'terminal')));
}

// ── 导出 ───────────────────────────────
function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

window.__pcExportResult = function (ok, msg) {
  if (ok) toast('已导出' + (msg ? '：' + msg : ''));
  else toast('导出失败：' + (msg || '未知错误'), 2600);
};

function exportActive() {
  const path = state.active;
  if (!path) { toast('先打开一个文件'); return; }
  const content = path === state.active ? editor.value : (state.vfs.read(path) || '');
  const name = nameOf(path);
  const nat = window.PocketCodeNative;
  if (nat && typeof nat.exportFile === 'function') {
    try {
      nat.exportFile(name, toB64(content));
      setStatus('选择保存位置…', 'busy');
      return;
    } catch (e) { /* 落到网页方案 */ }
  }
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('已下载 ' + name);
}

// ── 弹窗 ───────────────────────────────
function openModal(title, bodyHtml, footHtml) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-foot').innerHTML = footHtml;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }

function confirmModal(title, text, onOk) {
  openModal(title, '<div class="field"><div class="hint">' + escapeHtml(text) + '</div></div>',
    '<button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-ok">确定</button>');
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-ok').addEventListener('click', () => { closeModal(); onOk(); });
}

// ── 插件 ───────────────────────────────
function pluginCtxBase() {
  return {
    path: () => state.active,
    code: () => (state.active ? buildSource(state.active) : ''),
    read: (p) => state.vfs.read(p),
    write: (p, t) => state.vfs.write(p, t),
    setFile: (text) => {
      if (!state.active) return;
      state.vfs.write(state.active, text);
      editor.setValue(text, true);
    },
    listFiles: () => state.vfs.paths(),
    files: () => state.vfs.paths(),
    dirs: () => state.vfs.dirs(),
    openFile,
    toast,
    confirm: confirmModal,
    run: pluginRun,
    setStatus
  };
}

function renderPluginRail() {
  const rail = $('#plugin-rail');
  const list = plugins.list().filter((p) => p.enabled);
  rail.innerHTML = list.map((p) =>
    '<button class="rail-btn" data-plug="' + escapeHtml(p.id) + '" title="' + escapeHtml(p.name) + '" aria-label="' + escapeHtml(p.name) + '">' +
    iconSvg(p.icon) + '</button>'
  ).join('');
  rail.querySelectorAll('[data-plug]').forEach((b) => {
    b.classList.toggle('active', state.activePlugin === b.dataset.plug && state.view === 'plugin');
  });
}

function showView(v) {
  state.view = v;
  $('#view-files').classList.toggle('active', v === 'files');
  $('#view-plugin').classList.toggle('active', v === 'plugin');
  $('#side-close').classList.toggle('hidden', !isMobile());
  renderPluginRail();
}

function openFilesView() {
  state.activePlugin = null;
  plugins.unmount();
  $('#side-title').textContent = '资源管理器';
  showView('files');
  renderTree();
}

function openPlugin(id) {
  const def = plugins.get(id);
  if (!def) return;
  if (state.activePlugin === id && state.view === 'plugin') {
    // 再次点击同一个图标 → 收起
    openFilesView();
    return;
  }
  state.activePlugin = id;
  $('#side-title').textContent = def.name || id;
  showView('plugin');
  plugins.mountInto($('#view-plugin'), id);
  if (isMobile()) openDrawer();
}

/** 文件切换 / 内容大改后让插件刷新面板 */
function refreshPluginPanel() {
  if (state.view === 'plugin' && state.activePlugin) {
    plugins.mountInto($('#view-plugin'), state.activePlugin);
  }
}

// ── 设置 ───────────────────────────────
function settingsBody() {
  const s = state.settings;
  const seg = (id, list, cur, labelFn) => '<div class="seg" id="' + id + '">' +
    list.map((v) => '<button data-v="' + v + '" class="' + (v === cur ? 'on' : '') + '">' + (labelFn ? labelFn(v) : v) + '</button>').join('') + '</div>';

  const plugs = plugins.list();
  const plugRows = plugs.map((p) =>
    '<div class="plug-row" data-pid="' + escapeHtml(p.id) + '">' +
      '<span class="plug-ico">' + iconSvg(p.icon) + '</span>' +
      '<span class="plug-meta"><b>' + escapeHtml(p.name) + '</b>' +
        '<span class="plug-sub">' + escapeHtml(p.desc || '') + (p.builtin ? '' : ' · 导入') + '</span></span>' +
      '<button class="switch' + (p.enabled ? ' on' : '') + '" data-toggle-plug="' + escapeHtml(p.id) + '"></button>' +
      (p.builtin ? '' : '<button class="mini-btn danger" data-del-plug="' + escapeHtml(p.id) + '" title="删除插件">✕</button>') +
    '</div>').join('') || '<div class="hint">暂无插件</div>';

  const kb = Math.max(1, Math.round(state.vfs.bytes() / 1024));
  const fileCount = state.vfs.paths().length;

  return '<div class="field"><label>主题</label>' + seg('seg-theme', ['dark', 'light'], s.theme, (v) => (v === 'dark' ? '深色' : '浅色')) + '</div>' +
    '<div class="field"><label>C 标准</label>' + seg('seg-stdc', VALID_STD.stdC, s.stdC) + '</div>' +
    '<div class="field"><label>C++ 标准</label>' + seg('seg-stdcpp', VALID_STD.stdCpp, s.stdCpp) + '</div>' +
    '<div class="field"><label>编译参数</label><input id="m-args" type="text" value="' + escapeHtml(s.args) + '">' +
      '<div class="hint">例如 -Wall -O2 -Wextra</div></div>' +
    '<div class="field"><label>标准输入</label>' +
      '<div class="hint">输入数据直接在编辑器下方的「输入」框里填写，按文件独立保存，点「运行」自动传入。</div></div>' +

    '<div class="sec-title">新建文件</div>' +
    '<div class="field"><div class="row-between"><label style="margin:0">预填入内容</label>' +
      '<button class="switch' + (s.prefillOn ? ' on' : '') + '" id="m-prefill-on"></button></div>' +
      '<div class="hint">开启后，新建 .cpp 文件会自动填入下面这段模板。</div></div>' +
    '<div class="field"><label>预填模板</label><textarea id="m-prefill-text" class="tall">' + escapeHtml(s.prefillText) + '</textarea></div>' +

    '<div class="sec-title">插件</div>' +
    '<div class="plug-list">' + plugRows + '</div>' +
    '<div class="field"><button class="ghost-btn" id="m-import">导入插件包（.json）</button>' +
      '<div class="hint">插件脚本在本机运行，只导入你信任的文件。</div></div>' +

    '<div class="sec-title">数据</div>' +
    '<div class="field"><div class="hint">' + fileCount + ' 个文件 · 约 ' + kb + ' KB（存在本机，不上传）</div>' +
      '<button class="ghost-btn danger" id="m-wipe" style="margin-top:8px">清空全部数据</button></div>' +
    '<div class="sec-title">关于</div>' +
    '<div class="about-card">' +
      '<div class="about-head"><b>' + APP_NAME + '</b><span class="about-ver">v' + APP_VERSION + '</span></div>' +
      '<div class="about-sub">本地 Clang 22 (WASM) 编译 · 离线可用</div>' +
      '<button class="link-row" id="m-github"><span>项目仓库</span>' +
        '<span class="link-url">' + escapeHtml(REPO_OWNER + '/' + REPO_NAME) + ' ↗</span></button>' +
      '<button class="link-row" id="m-author"><span>我的 GitHub</span>' +
        '<span class="link-url">' + escapeHtml('github.com/' + REPO_OWNER) + ' ↗</span></button>' +
    '</div>' +
    '<button class="ghost-btn" id="m-check-update" style="margin-top:8px">检查更新</button>' +
    '<div class="field"><div class="hint">检查更新是唯一需要联网的功能，只读一个版本号文件；失败也不影响编译使用。' +
      '首次编译需加载约 28MB 编译器，之后走本机缓存。</div></div>';
}

function settingsModal() {
  openModal('设置', settingsBody(), '<button class="btn primary" id="m-close">完成</button>');
  const s = state.settings;

  const bindSeg = (id, key) => {
    document.querySelectorAll('#' + id + ' button').forEach((b) => {
      b.addEventListener('click', () => {
        s[key] = b.dataset.v;
        document.querySelectorAll('#' + id + ' button').forEach((x) => x.classList.toggle('on', x === b));
        applySettings();
      });
    });
  };
  bindSeg('seg-theme', 'theme');
  bindSeg('seg-stdc', 'stdC');
  bindSeg('seg-stdcpp', 'stdCpp');

  $('#m-args').addEventListener('input', (e) => { s.args = e.target.value; saveSettings(); });

  $('#m-prefill-on').addEventListener('click', (e) => {
    s.prefillOn = !s.prefillOn;
    e.currentTarget.classList.toggle('on', s.prefillOn);
    saveSettings();
  });
  $('#m-prefill-text').addEventListener('input', (e) => { s.prefillText = e.target.value; saveSettings(); });

  document.querySelectorAll('[data-toggle-plug]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.togglePlug;
      const on = !plugins.isEnabled(id);
      plugins.setEnabled(id, on);
      if (!on && state.activePlugin === id) openFilesView();
      b.classList.toggle('on', on);
      renderPluginRail();
    });
  });
  document.querySelectorAll('[data-del-plug]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.delPlug;
      confirmModal('删除插件', '将删除导入的插件「' + id + '」，确定？', () => {
        plugins.remove(id);
        renderPluginRail();
        if (state.activePlugin === id) openFilesView();
        settingsModal();
        toast('插件已删除');
      });
    });
  });

  $('#m-import').addEventListener('click', () => {
    pickFile('.json,application/json', async (file) => {
      const text = await file.text();
      const r = plugins.importFromJson(text);
      if (!r.ok) { toast(r.error, 2600); return; }
      plugins.list().forEach((p) => { if (r.added.includes(p.id)) plugins.setEnabled(p.id, true); });
      renderPluginRail();
      settingsModal();
      toast('已导入 ' + r.added.length + ' 个插件');
    });
  });

  $('#m-github').addEventListener('click', () => openExternal(REPO_URL));
  $('#m-author').addEventListener('click', () => openExternal(AUTHOR_URL));
  $('#m-check-update').addEventListener('click', () => checkUpdate(true));

  $('#m-wipe').addEventListener('click', () => {
    confirmModal('清空全部数据', '所有文件、测试点、设置都会被删除，且无法恢复。确定？', () => {
      state.vfs.reset();
      resetCphStore();
      stdinMap = {};
      saveStdinStore();
      try { localStorage.removeItem(SETTINGS_KEY); } catch (e) { /* 忽略 */ }
      state.tabs = []; state.active = null; state.open = new Set([ROOT]);
      state.settings = { ...DEFAULTS };
      applySettings();
      const first = state.vfs.paths()[0];
      if (first) openFile(first); else blankEditor();
      renderTree(); renderTabs(); closeModal();
      toast('已清空');
    });
  });

  $('#m-close').addEventListener('click', closeModal);
}

function applySettings() {
  document.documentElement.dataset.theme = state.settings.theme;
  editor.setFontSize(state.settings.fontSize);
  $('#st-font').textContent = editor.fontSize;
  const lang = state.active ? langOf(state.active) : 'cpp';
  $('#st-std').textContent = lang === 'c' ? state.settings.stdC : lang === 'cpp' ? state.settings.stdCpp : '—';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', state.settings.theme === 'light' ? '#ffffff' : '#14161c');
  saveSettings();
}

// ── 抽屉 ───────────────────────────────
function openDrawer() { $('#sidebar').classList.add('open'); $('#mask').classList.remove('hidden'); }
function closeDrawer() { $('#sidebar').classList.remove('open'); $('#mask').classList.add('hidden'); }

// ── 文件选择 ───────────────────────────
function pickFile(accept, cb) {
  const inp = $('#file-pick');
  inp.accept = accept;
  filePickCb = cb;
  inp.click();
}

// ── 启动 ───────────────────────────────
function init() {
  loadSettings();
  loadStdinStore();

  plugins.register(cphPlugin);
  plugins.setContextFactory(pluginCtxBase);

  editor = new CodeEditor({
    ta: $('#ta'),
    hlCode: $('#hl-code'),
    codeWrap: $('#code-wrap'),
    acEl: $('#ac'),
    sigEl: $('#sig'),
    onChange: () => {
      if (!state.active) return;
      state.vfs.write(state.active, editor.value);
    },
    onCaret: (line, col) => { $('#st-pos').textContent = '行 ' + line + ', 列 ' + col; },
    onRun: runActive,
    onSave: () => { if (state.active) { state.vfs.write(state.active, editor.value); toast('已保存'); } }
  });
  editor.onZoom = (fs) => { state.settings.fontSize = fs; $('#st-font').textContent = fs; saveSettings(); };
  if (new URLSearchParams(location.search).has('debug')) window.__ed = editor;
  window.__pc = {
    state, plugins, openFile, renderTree, runActive, editor,
    openPlugin, openFilesView, openDrawer, closeDrawer, openModal, closeModal,
    settingsModal, checkUpdate, openExternal,
    appInfo: { name: APP_NAME, version: APP_VERSION, code: APP_VERSION_CODE, repo: REPO_URL }
  };

  document.documentElement.dataset.theme = state.settings.theme;
  editor.setFontSize(state.settings.fontSize);
  $('#st-font').textContent = editor.fontSize;

  renderTree();
  renderPluginRail();
  showView('files');

  const first = state.vfs.paths()[0];
  if (first) openFile(first);
  else blankEditor();

  setStatus('就绪', '');
  termLine(APP_NAME + ' v' + APP_VERSION + ' · 本地 Clang 22 (WASM) · 完全离线编译', 't-dim');
  termLine('输入数据写在编辑器下方的输入框里；测题用左栏的 cph 插件。', 't-dim');
  scheduleUpdateCheck();

  bindTree();
  bindTabs();

  $('#btn-run').addEventListener('click', runActive);
  $('#btn-export').addEventListener('click', exportActive);
  $('#btn-settings').addEventListener('click', settingsModal);
  $('#side-close').addEventListener('click', () => { closeDrawer(); if (!isMobile()) $('#sidebar').style.display = 'none'; });
  $('#btn-drawer').addEventListener('click', () => {
    if (isMobile()) {
      if ($('#sidebar').classList.contains('open')) closeDrawer();
      else openDrawer();
    } else {
      $('#sidebar').style.display = $('#sidebar').style.display === 'none' ? '' : 'none';
    }
  });
  $('#mask').addEventListener('click', closeDrawer);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  $('#panel-toggle').addEventListener('click', () => $('#panel').classList.toggle('collapsed'));
  $('#btn-clear').addEventListener('click', termClear);

  const sTa = $('#stdin-ta');
  sTa.addEventListener('input', () => setStdinFor(state.active, sTa.value));
  $('#stdin-clear').addEventListener('click', () => {
    sTa.value = '';
    setStdinFor(state.active, '');
    updateStdinMeta();
  });
  $('#stdin-fold').addEventListener('click', () => $('#stdin-box').classList.toggle('folded'));
  document.querySelectorAll('.panel-tab').forEach((b) => b.addEventListener('click', () => switchPanelTab(b.dataset.tab)));

  $('#plugin-rail').addEventListener('click', (e) => {
    const b = e.target.closest('[data-plug]');
    if (b) openPlugin(b.dataset.plug);
  });

  document.querySelectorAll('.rail-btn[data-view]').forEach((b) => {
    b.addEventListener('click', () => {
      const v = b.dataset.view;
      document.querySelectorAll('.rail-btn[data-view]').forEach((x) => x.classList.toggle('active', x === b));
      if (v === 'files') {
        openFilesView();
        if (isMobile()) openDrawer();
      }
    });
  });

  $('#file-pick').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    const cb = filePickCb;
    filePickCb = null;
    if (f && cb) await cb(f);
  });

  $('#font-inc').addEventListener('click', () => { editor.fontUp(); state.settings.fontSize = editor.fontSize; $('#st-font').textContent = editor.fontSize; saveSettings(); });
  $('#font-dec').addEventListener('click', () => { editor.fontDown(); state.settings.fontSize = editor.fontSize; $('#st-font').textContent = editor.fontSize; saveSettings(); });

  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    editor.setFontSize(editor.fontSize + (e.deltaY < 0 ? 1 : -1));
    state.settings.fontSize = editor.fontSize;
    $('#st-font').textContent = editor.fontSize;
    saveSettings();
  }, { passive: false });

  window.addEventListener('resize', () => {
    editor.syncScroll();
    $('#side-close').classList.toggle('hidden', !isMobile());
  });

  if ('serviceWorker' in navigator && !/PocketCodeNative/.test(navigator.userAgent)) {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});
  }

  // 上一版（v2 存储）如果有文件，问一次要不要搬过来
  if (state.vfs.legacy) {
    const n = Object.keys(state.vfs.legacy).length;
    setTimeout(() => {
      openModal('发现上一版的文件',
        '<div class="field"><div class="hint">检测到上一版保存的 ' + n + ' 个文件。要导入到 root 下吗？<br>导入不会覆盖已有文件；选「忽略」之后不再提示。</div></div>',
        '<button class="btn" id="m-ignore">忽略</button><button class="btn primary" id="m-import-old">导入</button>');
      $('#m-ignore').addEventListener('click', () => {
        state.vfs.dismissLegacy();
        closeModal();
      });
      $('#m-import-old').addEventListener('click', () => {
        const got = state.vfs.importLegacy();
        closeModal();
        state.open = new Set(state.vfs.dirs());
        renderTree();
        const first = state.vfs.paths()[0];
        if (first && !state.active) openFile(first);
        toast('已导入 ' + got + ' 个文件');
      });
    }, 400);
  }
}

init();
