// 插件系统：注册表 / 启用状态 / JSON 插件包导入 / 面板挂载
const KEY = 'pocketcode.plugins.v1';

// ── 内置图标（24×24 线条）───────────────
export const ICONS = {
  cph: '<path d="M9 3h6M10 3v5.2L4.9 17a2 2 0 0 0 1.7 3h10.8a2 2 0 0 0 1.7-3L14 8.2V3"/><path d="M7.2 14h9.6"/>',
  flask: '<path d="M9 3h6M10 3v5.2L4.9 17a2 2 0 0 0 1.7 3h10.8a2 2 0 0 0 1.7-3L14 8.2V3"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8.5 12h0M12 12h0M15.5 12h0M8.5 16h0M12 16h0M15.5 16h0"/>',
  note: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  bug: '<path d="M8 6a4 4 0 0 1 8 0"/><rect x="7" y="6" width="10" height="12" rx="5"/><path d="M3 10h3M18 10h3M3 15h3M18 15h3M12 6v12"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 2.5 2.5L7 14M12.5 14.5H17"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  star: '<path d="m12 3.5 2.7 5.6 6.1.9-4.4 4.3 1 6.2-5.4-2.9-5.4 2.9 1-6.2L3.2 10l6.1-.9z"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  puzzle: '<path d="M10 3.5h4v2.2a1.8 1.8 0 1 0 3.6 0V3.5H21v6.3h-2.2a1.8 1.8 0 1 0 0 3.6H21v6.6h-6.4v-2.2a1.8 1.8 0 1 0-3.6 0V20H3.5v-6.6h2.2a1.8 1.8 0 1 0 0-3.6H3.5V3.5z"/>',
  speed: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="m12 14 4-4"/><circle cx="12" cy="18" r="1.4"/>'
};

export function iconSvg(name, cls) {
  const d = ICONS[name] || ICONS.puzzle;
  return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' viewBox="0 0 24 24">' + d + '</svg>';
}

// ── DOM 助手（也暴露给导入插件的脚本）──────
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
  }
  return el;
}

// ── 状态 ───────────────────────────────
function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    const o = raw ? JSON.parse(raw) : {};
    return { enabled: o.enabled || {}, imported: o.imported || {} };
  } catch (e) { return { enabled: {}, imported: {} }; }
}

class PluginManager {
  constructor() {
    this.builtins = new Map();   // id -> def
    this.state = loadState();
    this._cleanup = null;
    this._ctxFactory = null;
    this._hostEl = null;
    this._activeId = null;
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch (e) { /* 忽略 */ }
  }

  setContextFactory(fn) { this._ctxFactory = fn; }

  register(def) {
    if (!def || !def.id) return;
    this.builtins.set(def.id, { builtin: true, icon: 'puzzle', ...def });
  }

  /** 全部插件（内置 + 导入），带启用状态 */
  list() {
    const out = [];
    for (const d of this.builtins.values()) {
      out.push({ id: d.id, name: d.name || d.id, desc: d.desc || '', icon: d.icon || 'puzzle', builtin: true, enabled: this.isEnabled(d.id) });
    }
    for (const d of Object.values(this.state.imported)) {
      out.push({ id: d.id, name: d.name || d.id, desc: d.desc || '导入插件', icon: d.icon || 'puzzle', builtin: false, enabled: this.isEnabled(d.id) });
    }
    return out;
  }

  isEnabled(id) {
    const e = this.state.enabled;
    if (id in e) return !!e[id];
    return true; // 默认全部启用（自带插件开箱可用）
  }

  setEnabled(id, on) {
    this.state.enabled[id] = !!on;
    this.save();
  }

  get(id) {
    if (this.builtins.has(id)) return this.builtins.get(id);
    return this.state.imported[id] || null;
  }

  // ── 导入 / 删除 ─────────────────────────
  importFromJson(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: '不是合法的 JSON 文件' }; }
    const list = Array.isArray(obj) ? obj : [obj];
    const added = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') return { ok: false, error: '插件定义必须是对象' };
      const id = String(raw.id || '').trim();
      if (!/^[a-z0-9][a-z0-9._-]{1,39}$/i.test(id)) return { ok: false, error: '插件 id 不合法（需 2~40 位字母数字）' };
      if (this.builtins.has(id)) return { ok: false, error: '与内置插件重名：' + id };
      if (raw.script != null && typeof raw.script !== 'string') return { ok: false, error: 'script 必须是字符串' };
      if (raw.script && raw.script.length > 200000) return { ok: false, error: '脚本过大（上限 200KB）' };
      this.state.imported[id] = {
        id,
        name: String(raw.name || id).slice(0, 40),
        desc: String(raw.desc || '').slice(0, 200),
        icon: ICONS[raw.icon] ? raw.icon : 'puzzle',
        script: raw.script || '',
        ver: String(raw.version || raw.ver || '1.0').slice(0, 16)
      };
      added.push(id);
    }
    this.save();
    return { ok: true, added };
  }

  remove(id) {
    if (this.builtins.has(id)) return false;
    if (!this.state.imported[id]) return false;
    delete this.state.imported[id];
    delete this.state.enabled[id];
    this.save();
    return true;
  }

  // ── 挂载 ───────────────────────────────
  unmount() {
    if (this._cleanup) { try { this._cleanup(); } catch (e) { /* 忽略 */ } }
    this._cleanup = null;
    if (this._hostEl) this._hostEl.innerHTML = '';
    this._hostEl = null;
    this._activeId = null;
  }

  /** 把插件面板渲染进 host，返回是否成功 */
  mountInto(host, id, ctxExtra) {
    this.unmount();
    const def = this.get(id);
    if (!def) return false;
    this._hostEl = host;
    this._activeId = id;
    host.innerHTML = '';

    if (def.builtin && typeof def.mount === 'function') {
      const ctx = this._makeCtx(id, host, ctxExtra);
      try {
        const c = def.mount(host, ctx);
        this._cleanup = typeof c === 'function' ? c : null;
      } catch (e) {
        host.appendChild(h('div', { class: 'plug-err', text: '插件运行出错：' + (e && e.message) }));
      }
      return true;
    }

    // 导入插件：执行内嵌脚本
    const ctx = this._makeCtx(id, host, ctxExtra);
    if (!def.script) {
      host.appendChild(h('div', { class: 'plug-empty' },
        h('div', { class: 'plug-empty-t', text: def.name }),
        h('div', { class: 'plug-empty-d', text: def.desc || '这个插件没有提供面板内容。' })
      ));
      return true;
    }
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('ctx', '"use strict";\n' + def.script + '\n');
      const c = fn(ctx);
      this._cleanup = typeof c === 'function' ? c : null;
    } catch (e) {
      host.appendChild(h('div', { class: 'plug-err', text: '插件脚本出错：' + (e && e.message) }));
    }
    return true;
  }

  _makeCtx(id, host, extra) {
    const base = this._ctxFactory ? this._ctxFactory(id) : {};
    const NS = 'pocketcode.plug.' + id + '.';
    const storage = {
      get(k, dflt) {
        try { const v = localStorage.getItem(NS + k); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; }
      },
      set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) { /* 忽略 */ } },
      del(k) { try { localStorage.removeItem(NS + k); } catch (e) { /* 忽略 */ } }
    };
    return {
      id, root: host, h,
      ...base,
      storage,
      section(title, ...kids) {
        const sec = h('div', { class: 'plug-sec' });
        if (title) sec.appendChild(h('div', { class: 'plug-sec-t', text: title }));
        for (const k of kids.flat()) if (k) sec.appendChild(k);
        return sec;
      },
      button(label, onClick, cls) {
        return h('button', { class: 'plug-btn' + (cls ? ' ' + cls : ''), text: label, onclick: onClick });
      },
      textarea(opts) {
        const ta = h('textarea', {
          class: 'plug-ta' + (opts && opts.mono === false ? ' ui' : ''),
          placeholder: (opts && opts.placeholder) || '',
          rows: (opts && opts.rows) || 3,
          spellcheck: 'false'
        });
        if (opts && opts.value != null) ta.value = opts.value;
        if (opts && opts.onInput) ta.addEventListener('input', () => opts.onInput(ta.value));
        return ta;
      },
      input(opts) {
        const inp = h('input', {
          class: 'plug-inp',
          type: 'text',
          placeholder: (opts && opts.placeholder) || ''
        });
        if (opts && opts.value != null) inp.value = opts.value;
        if (opts && opts.onInput) inp.addEventListener('input', () => opts.onInput(inp.value));
        return inp;
      }
    };
  }
}

export const plugins = new PluginManager();
