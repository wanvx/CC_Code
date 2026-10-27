// 代码编辑器：高亮镜像层 + 透明 textarea（原生光标/选区/输入法/撤销）
import { highlightHtml, splitHighlightLines } from './hl.js';
import { suggestions, snippetFor, lookup, extractSymbols } from './complete.js';

const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
const CLOSERS = new Set([')', ']', '}']);
const INDENT = '    ';

export class CodeEditor {
  constructor({ ta, hlCode, codeWrap, acEl, sigEl, onChange, onCaret, onRun, onSave }) {
    this.ta = ta;
    this.hlCode = hlCode;
    this.hlEl = hlCode.parentElement;
    this.wrap = codeWrap;
    this.acEl = acEl;
    this.sigEl = sigEl;
    this.onChange = onChange || (() => {});
    this.onCaret = onCaret || (() => {});
    this.onRun = onRun || (() => {});
    this.onSave = onSave || (() => {});
    this.lang = 'cpp';
    this.fontSize = 13;
    this.lineHeight = 20;
    this.symbols = [];
    this.diags = new Map();
    this.acItems = [];
    this.acIndex = 0;
    this.acOpen = false;
    this.acPrefix = '';
    this.acMember = false;
    this.acNavigated = false;
    this.mirror = null;
    this._bind();
    this.setFontSize(this.fontSize);
    this.render();
  }

  // ── 基础读写 ──────────────────────────
  get value() { return this.ta.value; }
  setValue(v, silent) {
    this.ta.value = v;
    // 换文件时回到顶部（否则沿用上一个文件的滚动位置，看起来像跳到了中间/末尾）
    this.ta.scrollTop = 0;
    this.ta.scrollLeft = 0;
    this._lastX = -1;
    this.render();
    if (!silent) this.onChange();
    this.emitCaret();
  }
  setLanguage(lang) { this.lang = lang; }

  focus() { this.ta.focus(); }

  setFontSize(px) {
    this.fontSize = Math.max(10, Math.min(30, Math.round(px)));
    // 行高取整像素：与 .gl 高度完全一致，杜绝逐行亚像素漂移
    this.lineHeight = Math.round(this.fontSize * 1.55);
    document.documentElement.style.setProperty('--code-fs', this.fontSize + 'px');
    document.documentElement.style.setProperty('--code-lh', this.lineHeight + 'px');
    this._padTop = null;
    this.syncScroll();
    return this.fontSize;
  }
  fontUp() { return this.setFontSize(this.fontSize + 1); }
  fontDown() { return this.setFontSize(this.fontSize - 1); }

  // ── 渲染 ─────────────────────────────
  // 行号不再是独立列：每行渲染成 "<div>行号+代码</div>"，两者共享同一行盒与基线，
  // 字体度量差异（Android WebView 中文回退、亚像素舍入）不可能再造成累积错位。
  render() {
    const v = this.ta.value;
    const src = splitHighlightLines(highlightHtml(v));
    const total = src.length;
    const digits = Math.max(2, String(total).length);
    // 行号占位 = 位数 + 2 个空格间隔；#ta 的 padding-left 用同一变量，输入层与显示层水平对齐
    document.documentElement.style.setProperty('--ln-pad', String(digits + 2));

    let html = '';
    for (let i = 0; i < total; i++) {
      const sev = this.diags.get(i + 1);
      html += '<div class="cl' + (sev === 'error' ? ' err' : sev === 'warning' ? ' warn' : '') + '">' +
        '<span class="ln">' + (i + 1) + '</span>' +
        '<span class="lt">' + (src[i] || '') + '</span></div>';
    }
    this.hlCode.innerHTML = html;
    this.syncScroll();
    this.symbols = extractSymbols(v);
  }

  syncScroll() {
    const x = this.ta.scrollLeft, y = this.ta.scrollTop;
    this.hlEl.style.transform = 'translateY(' + -y + 'px)';
    // 横向：代码列内部平移并被 overflow 裁剪，行号列固定不动
    if (x !== this._lastX) {
      this._lastX = x;
      this.hlEl.style.setProperty('--sx', x + 'px');
    }
    // 兜底：外层容器一旦被引擎"reveal caret"滚动过，代码视图就整块错位
    const w = this.wrap;
    if (w.scrollTop !== 0) w.scrollTop = 0;
    if (w.scrollLeft !== 0) w.scrollLeft = 0;
  }

  /**
   * 内容变化后的滚动收尾。
   * Android WebView 在「回车换行」「Ctrl+Z 撤销」时会把 textarea 滚到整个文件末尾
   * （模拟器实测 scrollTop 直接跳到 max），用户看到的就是"窗口跳到代码尾巴"。
   * 策略：先把变化前的滚动位置原样恢复，再只做「保证光标可见」的最小修正。
   * @param {{y:number,x:number}|null} pre 变化前记录的滚动位置
   * @param {boolean} force true=无条件恢复；false=只在出现极端跳变（跑到顶/底）时恢复
   */
  settleScroll(pre, force) {
    const ta = this.ta;
    if (pre) {
      const max = Math.max(0, ta.scrollHeight - ta.clientHeight);
      const extreme = (ta.scrollTop === 0 && pre.y > 4) || (max > 0 && ta.scrollTop >= max - 1 && pre.y < max - 4);
      if (force || extreme) {
        ta.scrollLeft = pre.x;
        ta.scrollTop = pre.y;
      }
    }
    this.ensureCaretVisible();
  }

  /**
   * 光标可见性兜底（最后一道不变量）：内容变化后光标必须留在视口内，
   * 且只在光标真的跑出视口时才滚动，幅度最小，不干扰正常翻页。
   */
  ensureCaretVisible() {
    const ta = this.ta;
    const lh = this.lineHeight || 20;
    if (this._padTop == null) this._padTop = parseFloat(getComputedStyle(ta).paddingTop) || 8;
    const v = ta.value;
    let line = 0;
    for (let i = ta.selectionStart - 1; i >= 0; i--) if (v.charCodeAt(i) === 10) line++;
    const y = this._padTop + line * lh;   // 本行在内容坐标里的顶边（wrap=off，无软换行）
    const viewH = ta.clientHeight;
    const top = ta.scrollTop;
    if (y < top) ta.scrollTop = Math.max(0, y - lh);
    else if (y + lh > top + viewH) ta.scrollTop = Math.max(0, y + lh * 2 - viewH);
    this.syncScroll();
  }

  // ── 诊断 ─────────────────────────────
  setDiagnostics(items) {
    this.diags.clear();
    for (const it of items || []) {
      if (!it.line) continue;
      const cur = this.diags.get(it.line);
      if (cur === 'error') continue;
      this.diags.set(it.line, it.severity === 'error' ? 'error' : 'warning');
    }
    this.render();
  }

  gotoLine(line, col) {
    const lines = this.ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    pos += Math.min((col || 1) - 1, (lines[line - 1] || '').length);
    this.ta.focus();
    this.ta.setSelectionRange(pos, pos);
    const lh = this.lineHeight || 20;
    this.ta.scrollTop = Math.max(0, (line - 3) * lh);
    this.syncScroll();
    this.emitCaret();
  }

  // ── 光标 / 行列 ──────────────────────
  emitCaret() {
    const pos = this.ta.selectionStart;
    const before = this.ta.value.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    this.onCaret(line, col, pos);
  }

  caretXY(pos) {
    if (!this.mirror) {
      const d = document.createElement('div');
      d.style.position = 'absolute';
      d.style.visibility = 'hidden';
      d.style.whiteSpace = 'pre';
      d.style.left = '-9999px';
      d.style.top = '0';
      document.body.appendChild(d);
      this.mirror = d;
    }
    const d = this.mirror;
    const cs = getComputedStyle(this.ta);
    d.style.fontFamily = cs.fontFamily;
    d.style.fontSize = cs.fontSize;
    d.style.lineHeight = cs.lineHeight;
    d.style.letterSpacing = cs.letterSpacing;
    d.style.tabSize = cs.tabSize;
    d.style.padding = cs.padding;
    d.textContent = this.ta.value.slice(0, pos);
    const span = document.createElement('span');
    span.textContent = '\u200b';
    d.appendChild(span);
    const r = span.getBoundingClientRect();
    const base = d.getBoundingClientRect();
    const cs2 = getComputedStyle(d);
    const lh = parseFloat(cs2.lineHeight) || this.fontSize * 1.55;
    d.textContent = '';
    return { x: r.left - base.left, y: r.top - base.top, lh };
  }

  // ── 事件绑定 ─────────────────────────
  _bind() {
    const ta = this.ta;
    ta.addEventListener('scroll', () => this.syncScroll(), { passive: true });
    // 记录变化前的滚动位置：回车 / 撤销后 WebView 会把 textarea 滚到文件末尾
    ta.addEventListener('beforeinput', () => {
      this._preScroll = { y: ta.scrollTop, x: ta.scrollLeft };
    });
    ta.addEventListener('input', () => {
      const pre = this._preScroll;
      this._preScroll = null;
      this.render();
      this.onChange();
      this.emitCaret();
      this.settleScroll(pre, true);
      // WebView 的滚动修正有时发生在 input 之后（布局完成后），下一帧再兜一次，
      // 这时只在真的跑到顶/底才恢复，避免干扰用户正常滚动
      if (this._caretRaf) cancelAnimationFrame(this._caretRaf);
      this._caretRaf = requestAnimationFrame(() => {
        this._caretRaf = 0;
        this.settleScroll(pre, false);
      });
      this.updateAutocomplete();
      this.updateSig();
    });
    ta.addEventListener('click', () => { this.emitCaret(); this.hideSig(); });
    ta.addEventListener('keyup', (e) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
        this.emitCaret();
        this.hideSig();
      }
    });
    ta.addEventListener('keydown', (e) => this._onKeyDown(e));
    ta.addEventListener('blur', () => setTimeout(() => { this.hideAc(); this.hideSig(); }, 120));
    // 触屏点选候选项（pointerdown + preventDefault 保持 textarea 焦点）
    this.acEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ac-close')) { e.preventDefault(); this.hideAc(); return; }
      const item = e.target.closest('.ac-item');
      if (!item) return;
      e.preventDefault();
      this.acIndex = Number(item.dataset.i) || 0;
      this.acceptAc();
    });
    this._bindZoom();
  }

  _onKeyDown(e) {
    const ta = this.ta;
    const k = e.key;

    if (this.acOpen) {
      // 左右键：直接收起补全，光标正常移动（方便切行 / 改方向）
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        this.hideAc();
      } else if (k === 'ArrowDown' || k === 'ArrowUp') {
        // 上下键：在列表内移动；已经到顶 / 到底再按就收起，交回光标移动
        if (this.moveAc(k === 'ArrowDown' ? 1 : -1)) {
          e.preventDefault();
          this.acNavigated = true;
          return;
        }
        this.hideAc();
      } else if (k === 'Tab') { e.preventDefault(); this.acceptAc(); return; }
      else if (k === 'Escape') { e.preventDefault(); this.hideAc(); return; }
      else if (k === 'Enter') {
        // 用方向键选过才确认；否则收起补全后继续走换行
        if (this.acNavigated) { e.preventDefault(); this.acceptAc(); return; }
        this.hideAc();
      }
    }

    if ((e.ctrlKey || e.metaKey) && k === ' ') { e.preventDefault(); this.showAc(true); return; }
    if ((e.ctrlKey || e.metaKey) && (k === 'Enter')) { e.preventDefault(); this.onRun(); return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 's') { e.preventDefault(); this.onSave(); return; }

    if (k === 'Tab') {
      e.preventDefault();
      if (ta.selectionStart !== ta.selectionEnd) this.indentSelection(e.shiftKey);
      else if (e.shiftKey) this.outdentLine();
      else this.insert(INDENT);
      return;
    }

    if (k === 'Enter') {
      e.preventDefault();
      const s = ta.selectionStart, val = ta.value;
      const lineStart = val.lastIndexOf('\n', s - 1) + 1;
      const line = val.slice(lineStart, s);
      let indent = (line.match(/^[ \t]*/) || [''])[0];
      const prev = val[s - 1], next = val[s];
      if (prev === '{' || (prev === ')' && next === '{')) indent += INDENT;
      if (prev === '{' && (next === '}' || next === ')' || next === ';')) {
        this.insert('\n' + indent + '\n' + indent.slice(0, -INDENT.length));
        const p = ta.selectionStart;
        ta.setSelectionRange(p - indent.length - 1, p - indent.length - 1);
        this.syncScroll();
        return;
      }
      this.insert('\n' + indent);
      return;
    }

    if (k === 'Backspace') {
      const s = ta.selectionStart, val = ta.value;
      if (s === ta.selectionEnd && s > 0 && val[s - 1] === ' ' && val[s] === ' ') {
        // 空缩进删除整级
        const ls = val.lastIndexOf('\n', s - 1) + 1;
        const lineTxt = val.slice(ls, s);
        if (/^[ \t]+$/.test(lineTxt)) {
          e.preventDefault();
          const n = lineTxt.length % 4 || 4;
          ta.setSelectionRange(s - n, s);
          this.insert('');
          return;
        }
      }
      return;
    }

    // 自动配对
    if (PAIRS[k] && ta.selectionStart === ta.selectionEnd) {
      const s = ta.selectionStart, val = ta.value;
      const next = val[s] || '';
      if ((k === '"' || k === "'") && next === k) { e.preventDefault(); ta.setSelectionRange(s + 1, s + 1); this.emitCaret(); return; }
      if (k === '"' || k === "'") {
        if (/[\w]/.test(val[s - 1] || '')) return;
      }
      if (CLOSERS.has(next) && k !== '"' && k !== "'") return;
      e.preventDefault();
      this.insert(k + PAIRS[k], -1);
      this.updateAutocomplete();
      this.updateSig();
      return;
    }
    if (CLOSERS.has(k) && ta.selectionStart === ta.selectionEnd) {
      if (ta.value[ta.selectionStart] === k) { e.preventDefault(); ta.setSelectionRange(ta.selectionStart + 1, ta.selectionStart + 1); this.emitCaret(); this.updateSig(); }
    }
  }

  // 通过 execCommand 插入以保留原生撤销栈
  insert(text, caretOffset) {
    const ta = this.ta;
    const pre = { y: ta.scrollTop, x: ta.scrollLeft };
    const ok = document.execCommand && document.execCommand('insertText', false, text);
    if (!ok) {
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
      ta.setSelectionRange(s + text.length, s + text.length);
    }
    if (caretOffset) {
      const p = ta.selectionStart + caretOffset;
      ta.setSelectionRange(p, p);
    }
    this.render();
    this.onChange();
    this.emitCaret();
    this.settleScroll(pre, true);
  }

  indentSelection(outdent) {
    const ta = this.ta;
    const val = ta.value;
    const s = val.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    const e = val.indexOf('\n', ta.selectionEnd);
    const block = val.slice(s, e === -1 ? val.length : e);
    const lines = block.split('\n');
    const changed = lines.map((l) => (outdent ? l.replace(/^ {1,4}/, '') : INDENT + l)).join('\n');
    ta.setSelectionRange(s, e === -1 ? val.length : e);
    this.insert(changed);
    ta.setSelectionRange(s, s + changed.length);
  }

  outdentLine() {
    const ta = this.ta;
    const val = ta.value;
    const s = val.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    const lineTxt = val.slice(s, ta.selectionStart);
    const m = lineTxt.match(/^ {1,4}/);
    if (!m) return;
    ta.setSelectionRange(s, s + m[0].length);
    this.insert('');
  }

  // ── 自动补全 ─────────────────────────
  wordPrefix() {
    const s = this.ta.selectionStart;
    const v = this.ta.value;
    const m = /[A-Za-z_]\w*$/.exec(v.slice(Math.max(0, s - 64), s));
    return m ? { word: m[0], from: s - m[0].length } : { word: '', from: s };
  }

  updateAutocomplete() {
    const v = this.ta.value, s = this.ta.selectionStart;
    const { word } = this.wordPrefix();
    // 刚接受补全后，同一词不重复弹出
    if (this.justAccepted) {
      if (word === this.justAccepted) { this.hideAc(); return; }
      this.justAccepted = null;
    }
    if (this.isMemberAccess(v, s)) { this.acMember = true; this.showAc(false, word); return; }
    this.acMember = false;
    if (word.length >= 2) { this.showAc(false, word); return; }
    this.hideAc();
  }

  // 仅 . / -> / :: 且左侧是合法表达式才算成员访问（排除 3.14、case 1:、a > b）
  isMemberAccess(v, s) {
    const p1 = v[s - 1] || '', p2 = v[s - 2] || '';
    if (p1 === '>' && p2 === '-') return true;
    if (p1 === ':' && p2 === ':') return true;
    if (p1 === '.' && p2 !== '.' && !/\d/.test(p2) && /[A-Za-z0-9_)\]]/.test(p2)) return true;
    return false;
  }

  showAc(manual, word) {
    const { word: w2, from } = this.wordPrefix();
    const prefix = word != null ? word : w2;
    const items = suggestions(prefix, this.symbols, this.acMember);
    if (!items.length) { this.hideAc(); return; }
    this.acItems = items;
    this.acIndex = 0;
    this.acNavigated = false;
    this.acPrefix = prefix;
    this.acFrom = from;
    this.acOpen = true;
    this.renderAc();
    const pos = this.ta.selectionStart;
    const { x, y, lh } = this.caretXY(pos);
    const rect = this.ta.getBoundingClientRect();
    const px = Math.min(window.innerWidth - 200, Math.max(6, rect.left + x - this.ta.scrollLeft));
    let py = rect.top + y - this.ta.scrollTop + lh + 2;
    const h = Math.min(240, items.length * 31 + 30);
    if (py + h > window.innerHeight - 30) py = Math.max(8, rect.top + y - this.ta.scrollTop - h - 2);
    this.acEl.style.left = px + 'px';
    this.acEl.style.top = py + 'px';
    this.acEl.classList.remove('hidden');
  }

  renderAc() {
    const html = this.acItems.map((it, i) => {
      const kindCls = it.kind === 'kw' ? 'kw' : it.kind === 'fn' || it.kind === 'mem' ? 'fn' : it.kind === 'ty' || it.kind === 'sym' ? 'ty' : 'sym';
      const kindTxt = it.kind === 'kw' ? 'K' : it.kind === 'fn' ? 'f' : it.kind === 'mem' ? 'm' : it.kind === 'sn' ? 'S' : 'T';
      const detail = (it.sig || it.doc || '').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
      return '<div class="ac-item' + (i === this.acIndex ? ' sel' : '') + '" data-i="' + i + '">' +
        '<span class="ac-kind ' + kindCls + '">' + kindTxt + '</span>' +
        '<span class="ac-label">' + it.label + '</span>' +
        '<span class="ac-detail">' + detail + '</span></div>';
    }).join('');
    this.acEl.innerHTML = html + '<div class="ac-close" title="关闭补全">✕</div>';
    const sel = this.acEl.querySelector('.ac-item.sel');
    // 不用 scrollIntoView：它会连带滚动所有可滚动祖先（会顶走代码视图），只滚弹窗自己
    if (sel) {
      const top = sel.offsetTop, bottom = top + sel.offsetHeight;
      const box = this.acEl;
      if (top < box.scrollTop) box.scrollTop = top;
      else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
    }
  }

  /** @returns {boolean} false 表示已到边界（调用方据此关闭补全） */
  moveAc(d) {
    const next = this.acIndex + d;
    if (next < 0 || next >= this.acItems.length) return false;
    this.acIndex = next;
    this.renderAc();
    return true;
  }

  hideAc() {
    this.acOpen = false;
    this.acNavigated = false;
    this.acEl.classList.add('hidden');
  }

  acceptAc() {
    if (!this.acOpen) return;
    const it = this.acItems[this.acIndex];
    this.hideAc();
    if (!it) return;
    this.justAccepted = it.label;
    const ta = this.ta;
    const s = ta.selectionStart;
    const from = Math.min(this.acFrom, s);
    ta.setSelectionRange(from, s);
    const sn = snippetFor(it.label);
    if (sn) {
      const lineStart = ta.value.lastIndexOf('\n', from - 1) + 1;
      const indent = (ta.value.slice(lineStart).match(/^[ \t]*/) || [''])[0];
      const body = sn.replace(/\n/g, '\n' + indent).replace(/\$0/g, '');
      this.insert(body);
      const p = ta.value.lastIndexOf(body) + body.length;
      void p;
      return;
    }
    this.insert(it.label);
  }

  // ── 参数签名提示 ─────────────────────
  callContext() {
    const v = this.ta.value, pos = this.ta.selectionStart;
    let depth = 0, i = pos - 1;
    for (; i >= 0; i--) {
      const c = v[i];
      if (c === ')') depth++;
      else if (c === '(') { if (depth === 0) break; depth--; }
      if (depth > 3) return null;
    }
    if (i < 0 || v[i] !== '(') return null;
    let j = i - 1;
    while (j >= 0 && /\s/.test(v[j])) j--;
    const end = j + 1;
    while (j >= 0 && /[\w:]/i.test(v[j])) j--;
    const name = v.slice(j + 1, end);
    if (!name || name.length < 2) return null;
    // 当前参数序号
    let idx = 0, d = 0;
    for (let k = i + 1; k < pos; k++) {
      const c = v[k];
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d--;
      else if (c === ',' && d === 0) idx++;
    }
    return { name, idx };
  }

  updateSig() {
    const ctx = this.callContext();
    if (!ctx) return this.hideSig();
    const item = lookup(ctx.name) || this.symbols.find((s) => s.label === ctx.name);
    if (!item) return this.hideSig();
    const sig = item.sig || '';
    const p0 = sig.indexOf('('), p1 = sig.lastIndexOf(')');
    if (p0 < 0 || p1 <= p0) return this.hideSig();
    const parts = sig.slice(p0 + 1, p1).split(',');
    const esc = (t) => t.replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
    const html = '<b>' + esc(item.label) + '</b>(' +
      parts.map((p, k) => (k === ctx.idx ? '<b>' + esc(p) + '</b>' : esc(p))).join(', ') + ')';
    this.sigEl.innerHTML = html;
    const { x, y, lh } = this.caretXY(this.ta.selectionStart);
    const rect = this.ta.getBoundingClientRect();
    this.sigEl.style.left = Math.max(6, Math.min(window.innerWidth - 240, rect.left + x - this.ta.scrollLeft)) + 'px';
    this.sigEl.style.top = Math.max(30, rect.top + y - this.ta.scrollTop - 26) + 'px';
    this.sigEl.classList.remove('hidden');
    void lh;
  }

  hideSig() { this.sigEl.classList.add('hidden'); }

  // ── 缩放：双指捏合（Ctrl+滚轮由 app 统一处理）──
  _bindZoom() {
    let startDist = 0, startFs = 0, pinching = false;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    this.wrap.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) { pinching = true; startDist = dist(e.touches); startFs = this.fontSize; }
    }, { passive: true });
    this.wrap.addEventListener('touchmove', (e) => {
      if (!pinching || e.touches.length !== 2) return;
      e.preventDefault();
      const ratio = dist(e.touches) / startDist;
      const next = Math.round(startFs * ratio);
      if (next !== this.fontSize) {
        this.setFontSize(next);
        this.onZoom && this.onZoom(this.fontSize);
      }
    }, { passive: false });
    this.wrap.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) pinching = false;
    }, { passive: true });
  }
}
