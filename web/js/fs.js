// 虚拟文件系统（localStorage 持久化）— root 为唯一根，支持任意深目录
const KEY = 'pocketcode.fs.v3';
const LEGACY_KEY = 'pocketcode.fs.v2';       // 上一版的存储（一次性迁移用）
const LEGACY_FLAG = 'pocketcode.fs.v2.seen'; // 用户已处理过旧数据，不再提示
export const ROOT = '';

// 首次启动只有空的 main.cpp：不是示例工程，只是给一个落点
const BOOTSTRAP = { files: { 'main.cpp': '' }, dirs: [] };

export class VFS {
  constructor() {
    this.files = new Map();
    this.dirSet = new Set([ROOT]);
    this.load();
  }

  // ── 持久化 ─────────────────────────────
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const obj = JSON.parse(raw) || {};
        for (const [k, v] of Object.entries(obj.files || {})) {
          const p = norm(k);
          if (p) this.files.set(p, String(v));
        }
        for (const d of obj.dirs || []) {
          const p = norm(d);
          if (p) { this.dirSet.add(p); this._addParents(p); }
        }
        for (const p of this.files.keys()) this._addParents(p);
      }
    } catch (e) { /* 损坏数据直接重建 */ }
    if (this.files.size === 0 && this.dirSet.size <= 1) {
      this._applyBootstrap();
      this._sniffLegacy();
    }
    this.dirSet.add(ROOT);
  }

  /** 首次启动时看一眼上一版有没有留下文件（只探测，不自动导入） */
  _sniffLegacy() {
    try {
      if (localStorage.getItem(LEGACY_FLAG)) return;
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      const keys = Object.keys(obj || {});
      if (!keys.length) return;
      this.legacy = {};
      for (const k of keys) this.legacy[norm(k)] = String(obj[k]);
    } catch (e) { /* 忽略 */ }
  }

  /** 把旧数据整包导进来，返回导入条数 */
  importLegacy() {
    if (!this.legacy) return 0;
    let n = 0;
    for (const [p, c] of Object.entries(this.legacy)) {
      if (!p || this.files.has(p)) continue;
      this.files.set(p, c);
      this._addParents(p);
      n++;
    }
    this.legacy = null;
    try { localStorage.setItem(LEGACY_FLAG, '1'); } catch (e) { /* 忽略 */ }
    this.save();
    return n;
  }

  dismissLegacy() {
    this.legacy = null;
    try { localStorage.setItem(LEGACY_FLAG, '1'); } catch (e) { /* 忽略 */ }
  }

  _applyBootstrap() {
    for (const [k, v] of Object.entries(BOOTSTRAP.files)) this.files.set(k, v);
    for (const d of BOOTSTRAP.dirs) this.dirSet.add(d);
    this.save();
  }

  save() {
    if (this._t) clearTimeout(this._t);
    this._t = setTimeout(() => {
      try {
        const files = {};
        for (const [k, v] of this.files) files[k] = v;
        localStorage.setItem(KEY, JSON.stringify({ files, dirs: [...this.dirSet].filter((d) => d) }));
      } catch (e) { /* 配额满时静默失败 */ }
    }, 200);
  }

  flush() {
    if (this._t) clearTimeout(this._t);
    const files = {};
    for (const [k, v] of this.files) files[k] = v;
    try {
      localStorage.setItem(KEY, JSON.stringify({ files, dirs: [...this.dirSet].filter((d) => d) }));
    } catch (e) { /* 忽略 */ }
  }

  // ── 查询 ───────────────────────────────
  paths() { return [...this.files.keys()].sort(); }
  dirs() { return [...this.dirSet].sort(); }
  read(p) { return this.files.get(p); }
  exists(p) { return this.files.has(p); }
  isDir(p) { return this.dirSet.has(p); }
  isEmpty() { return this.files.size === 0 && this.dirSet.size <= 1; }

  /** 直接子项：{ dirs: [...], files: [...] }，均已按名称排序 */
  children(dir) {
    const d = norm(dir);
    const out = { dirs: [], files: [] };
    for (const x of this.dirSet) {
      if (x && parentOf(x) === d && x !== d) out.dirs.push(x);
    }
    for (const x of this.files.keys()) {
      if (parentOf(x) === d) out.files.push(x);
    }
    const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), 'zh');
    out.dirs.sort(byName);
    out.files.sort(byName);
    return out;
  }

  // ── 变更 ───────────────────────────────
  write(p, content) {
    const path = norm(p);
    if (!path) return;
    this.files.set(path, content);
    this._addParents(path);
    this.save();
  }

  _addParents(p) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) this.dirSet.add(parts.slice(0, i).join('/'));
  }

  /** 建文件；同名自动加 _1、_2 后缀。返回最终路径 */
  createFile(dir, name, content = '') {
    const d = norm(dir);
    let base = norm(name);
    if (!base) return null;
    const full = d ? d + '/' + base : base;
    if (this.files.has(full) || this.dirSet.has(full)) {
      const m = /^(.*?)(\.[^.]+)?$/.exec(base);
      let i = 1;
      while (this.files.has((d ? d + '/' : '') + m[1] + '_' + i + (m[2] || '')) ||
             this.dirSet.has((d ? d + '/' : '') + m[1] + '_' + i + (m[2] || ''))) i++;
      base = m[1] + '_' + i + (m[2] || '');
    }
    const path = d ? d + '/' + base : base;
    this.files.set(path, content);
    if (d) this._addParents(d);
    this.save();
    return path;
  }

  /** 建目录；同名自动加 _1 后缀。返回最终路径 */
  mkdir(dir, name) {
    const d = norm(dir);
    let base = norm(name);
    if (!base) return null;
    let path = d ? d + '/' + base : base;
    if (this.files.has(path) || this.dirSet.has(path)) {
      let i = 1;
      while (this.files.has((d ? d + '/' : '') + base + '_' + i) || this.dirSet.has((d ? d + '/' : '') + base + '_' + i)) i++;
      path = (d ? d + '/' : '') + base + '_' + i;
    }
    this.dirSet.add(path);
    if (d) this._addParents(d);
    this.save();
    return path;
  }

  removeFile(p) {
    this.files.delete(p);
    this.save();
  }

  /** 递归删目录（含所有子孙文件与子目录） */
  removeDir(p) {
    const d = norm(p);
    if (!d) return;
    for (const k of [...this.files.keys()]) if (k === d || k.startsWith(d + '/')) this.files.delete(k);
    for (const k of [...this.dirSet]) if (k === d || k.startsWith(d + '/')) this.dirSet.delete(k);
    this.save();
  }

  /** 重命名文件或目录（目录连同子孙一起移动）。冲突时返回 false */
  rename(oldPath, newName) {
    const from = norm(oldPath);
    const nn = norm(newName);
    if (!from || !nn || nn.includes('/')) return false;
    const d = parentOf(from);
    const to = d ? d + '/' + nn : nn;
    if (to === from) return true;
    if (this.files.has(to) || this.dirSet.has(to)) return false;

    if (this.files.has(from)) {
      const c = this.files.get(from);
      this.files.delete(from);
      this.files.set(to, c);
    } else if (this.dirSet.has(from)) {
      for (const k of [...this.files.keys()]) {
        if (k.startsWith(from + '/')) { const c = this.files.get(k); this.files.delete(k); this.files.set(to + k.slice(from.length), c); }
      }
      for (const k of [...this.dirSet]) {
        if (k === from || k.startsWith(from + '/')) { this.dirSet.delete(k); this.dirSet.add(to + k.slice(from.length)); }
      }
    } else return false;

    this.save();
    return true;
  }

  /** 移动（拖拽/剪切粘贴预留） */
  move(fromPath, toDir) {
    const from = norm(fromPath);
    const to = norm(toDir);
    if (!from || from === to) return false;
    if (to === from || to.startsWith(from + '/')) return false;
    const base = nameOf(from);
    const dest = to ? to + '/' + base : base;
    if (this.files.has(dest) || this.dirSet.has(dest)) return false;

    if (this.files.has(from)) {
      const c = this.files.get(from);
      this.files.delete(from);
      this.files.set(dest, c);
    } else if (this.dirSet.has(from)) {
      for (const k of [...this.files.keys()]) {
        if (k.startsWith(from + '/')) { const c = this.files.get(k); this.files.delete(k); this.files.set(dest + k.slice(from.length), c); }
      }
      for (const k of [...this.dirSet]) {
        if (k === from || k.startsWith(from + '/')) { this.dirSet.delete(k); this.dirSet.add(dest + k.slice(from.length)); }
      }
    } else return false;
    this.save();
    return true;
  }

  /** 清空全部数据（设置里的「重置」用） */
  reset() {
    this.files.clear();
    this.dirSet = new Set([ROOT]);
    this.save();
    this.flush();
  }

  /** 粗略占用（字节） */
  bytes() {
    let n = 0;
    for (const [k, v] of this.files) n += k.length + v.length;
    return n;
  }
}

// ── 路径工具 ─────────────────────────────
export function norm(p) {
  return String(p == null ? '' : p)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}
export function parentOf(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? ROOT : p.slice(0, i);
}
export function nameOf(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}
export function join(dir, name) {
  const d = norm(dir);
  return d ? d + '/' + name : name;
}
export function displayPath(p) {
  return p ? 'root/' + p : 'root';
}

export function langOf(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (ext === 'c') return 'c';
  if (['h'].includes(ext)) return 'header';
  if (['cpp', 'cc', 'cxx', 'c++'].includes(ext)) return 'cpp';
  if (['hpp', 'hh', 'hxx'].includes(ext)) return 'header';
  return 'text';
}

export function isRunnable(path) {
  return ['c', 'cpp'].includes(langOf(path));
}

// 把工程内的 #include "x.h" 递归内联，交给单文件编译器
export function inlineLocalIncludes(code, fromPath, read, seen = new Set(), depth = 0) {
  if (depth > 12) return code;
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const fileKey = fromPath;
  if (seen.has(fileKey)) return '';
  seen.add(fileKey);

  return code.split('\n').map((line) => {
    const m = /^\s*#\s*include\s*"([^"]+)"\s*$/.exec(line);
    if (!m) return line;
    const inc = m[1];
    const candidates = [dir ? dir + '/' + inc : inc, inc];
    for (const cand of candidates) {
      const body = read(cand);
      if (body != null) {
        if (seen.has(cand)) return '// [已内联] ' + cand;
        const expanded = inlineLocalIncludes(body, cand, read, seen, depth + 1)
          .replace(/^[ \t]*#[ \t]*pragma[ \t]+once[ \t]*$/gm, '// [pragma once：内联时由去重保护替代]');
        return '// ── 内联 ' + cand + ' ──\n' + expanded;
      }
    }
    return line;
  }).join('\n');
}
