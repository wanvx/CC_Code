// 代码编辑器：高亮镜像层 + 透明 textarea（原生光标/选区/输入法/撤销）
import { highlightLines } from './hl.js';
import { suggestions, snippetFor, lookup, extractSymbols } from './complete.js';

const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
const CLOSERS = new Set([')', ']', '}']);
const INDENT = '    ';
const MAX_GUIDES = 16;
// 差异窗口外需要重绘的行数超过这个值，整篇重建一次反而更快（括号着色时会触发）
const PATCH_REBUILD_LIMIT = 400;
// 括号重着色：同步阶段只处理可见那一小段，其余分帧追平。
// 改 className 会让浏览器重算这一片的样式，一次改几千个 class 要 40ms+，绝不能同步做完。
const BR_SYNC_MAX = 40;
const BR_CHUNK = 200;
const EMPTY_ARR = [];
const BRK_CHARS = { '(': 1, ')': 1, '[': 1, ']': 1, '{': 1, '}': 1 };
// 括号颜色写成 style.color：改 color 只会触发重绘，改 className 会让浏览器按"可能影响布局"处理，
// 2000 行上要整块重排 40ms+。值仍是 CSS 变量，主题切换照常生效。
const BR_COLOR = { d0: 'var(--br-0)', d1: 'var(--br-1)', d2: 'var(--br-2)', bku: 'var(--br-bad)' };

/** 一行前导空白 = 几个缩进层级（空格 1 列，Tab 补到 4 的整数倍） */
function indentLevels(line) {
  let cols = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') cols++;
    else if (c === '\t') cols += 4 - (cols % 4);
    else break;
  }
  const n = Math.ceil(cols / 4);
  return n > MAX_GUIDES ? MAX_GUIDES : n;
}

// 每行的括号 class 摘要（"d0,d1,bku"）由 hl.js 顺带产出，
// 比较两版代码时用它低成本判断"这行只是括号颜色变了，还是结构也变了"


export class CodeEditor {
  constructor({ ta, hlCode, codeWrap, acEl, sigEl, onChange, onCaret, onRun, onSave }) {
    this.ta = ta;
    this.hlCode = hlCode;
    this.hlEl = hlCode.parentElement;
    this.wrap = codeWrap;
    this.acEl = acEl;
    this.sigEl = sigEl;
    // 浮层锚在编辑区容器里（绝对定位），位置由编辑器算，不依赖视口坐标
    this.host = (acEl && acEl.parentElement) || codeWrap.parentElement;
    this.guides = true;
    this.onChange = onChange || (() => {});
    this.onCaret = onCaret || (() => {});
    this.onRun = onRun || (() => {});
    this.onSave = onSave || (() => {});
    this.lang = 'cpp';
    this.fontSize = 13;
    this.lineHeight = 20;
    this.codeTheme = 'classic';    // classic（默认）| vscode（经典）| 2026（新版）
    this.bracketColors = false;    // 括号配对颜色化
    this._br = [];                 // 括号位置：[{line, col, idx, ch, depth, pair}]
    this._brUn = [];               // 未闭合的开括号
    this._brRow = [];              // 每行括号 class 摘要（"d0,d1,bku"）
    this._brMap = null;            // 每行一个数组：该行的括号在 _br 里的下标（懒建）
    this._bkmEls = null;           // 当前挂着"配对高亮"的元素
    this._symCache = null;        // 符号表懒计算
    this._rows = null;            // 当前渲染出的行元素
    this._src = null;             // 每行的高亮 HTML
    this._lines = null;           // 每行的纯文本
    this.diags = new Map();       // 编译诊断：行号 → error / warning
    this.lintMap = new Map();     // 实时检查：行号 → error / warning
    this.acItems = [];
    this.acIndex = -1;            // -1 = 还没用方向键挑，第一下 ↓ 落在预选项上
    this.acPreIdx = 0;            // 预选下标：默认第 1 项；前缀记忆命中时是上次选的那项
    this._acWord = '';            // 上一次过滤用的词（打字追加时走增量过滤）
    this._acMem = null;           // 前缀记忆：{ 词 → {label,t} }，懒加载 localStorage
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
    this._rows = null;
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
  /** 高亮层参数：配色模式 + 括号着色 */
  _hlOpts() {
    const br = this.bracketColors;
    return {
      vscode: this.codeTheme !== 'classic',
      brackets: br,
      brOut: br ? this._br : null,
      unmatchedOut: br ? this._brUn : null,
      rowClsOut: br ? this._brRow : null
    };
  }

  /** 配色 / 括号着色切换：整篇重算（切设置是低频操作，全量重绘更省心） */
  setCodeTheme(theme) {
    const next = theme === 'vscode' || theme === '2026' ? theme : 'classic';
    if (next === this.codeTheme) return;
    this.codeTheme = next;
    this.render();
  }

  setBracketColors(on) {
    const next = !!on;
    if (next === this.bracketColors) return;
    this.bracketColors = next;
    this.render();
  }

  render() {
    // 整篇重建会覆盖所有行，之前排队的分帧重着色直接作废
    if (this._brRaf) { cancelAnimationFrame(this._brRaf); this._brRaf = 0; }
    this._brFrom = null;
    const v = this.ta.value;
    this._brRow = [];
    const src = highlightLines(v, this._hlOpts());
    const lines = v.split('\n');
    const total = src.length;
    this._setLnPad(total);

    let html = '';
    for (let i = 0; i < total; i++) html += this._rowHtml(i, src[i], lines[i]);
    this.hlCode.innerHTML = html;
    this._rows = Array.from(this.hlCode.children);
    this._src = src;
    this._lines = lines;
    this._symCache = null;
    this._brMap = null;
    this.syncScroll();
    this._recolorAll();
    this._afterPaint();
  }

  /** 整篇按行摘要刷一遍括号 class（换配色 / 首次渲染用，2000 行约 15ms） */
  _recolorAll() {
    if (!this.bracketColors || !this._rows) return;
    for (let i = 0; i < this._rows.length; i++) this._recolorRow(i);
  }

  /**
   * 输入时的增量重绘：只改真正动过的行。
   * 整篇 innerHTML 重建在 2000 行文件上要 40~90ms（手机上成倍），每敲一个字来一遍
   * 就是肉眼可见的卡顿和视图抖动；按行打补丁后单行更新约 0.5ms。
   */
  patch() {
    if (!this._rows || !this._lines) { this.render(); return; }
    const v = this.ta.value;
    const lines = v.split('\n');
    const olds = this._lines;
    if (lines.length === olds.length && lines.every((s, i) => s === olds[i])) { this.syncScroll(); return; }

    const prevBrRow = this._brRow;
    this._brRow = [];
    const src = highlightLines(v, this._hlOpts());
    const oldSrc = this._src;
    const total = src.length;
    this._setLnPad(total);

    // 文本差异窗口：公共前缀 + 公共后缀（打字时通常只覆盖一行）
    const minLen = Math.min(total, olds.length);
    let lo = 0;
    while (lo < minLen && lines[lo] === olds[lo]) lo++;
    let hiN = total, hiO = olds.length;
    while (hiN > lo && hiO > lo && lines[hiN - 1] === olds[hiO - 1]) { hiN--; hiO--; }

    this._src = src;
    this._lines = lines;
    this._symCache = null;
    this._brMap = null;
    this._replaceRows(lo, hiN, hiO);
    // 新插入的行只有占位 class，深度得按摘要补上
    if (this.bracketColors) for (let i = lo; i < hiN; i++) this._recolorRow(i);

    // 差异窗口外：文本没变但高亮可能变（例如刚敲下 /* 让后面整段变注释；
    // 开了括号着色时，敲一个 ( 也会让后续所有行的括号颜色整体偏移）
    const dirty = [];
    const brOnly = [];
    const shift = total - olds.length;
    const check = (i) => {
      const o = i - shift;
      if (o < 0 || o >= oldSrc.length) { dirty.push(i); return; }
      if (src[i] !== oldSrc[o]) { dirty.push(i); return; }
      // 文本没变，但括号深度整体偏移了 → 只要换 class
      if (this.bracketColors && this._brRow[i] !== prevBrRow[o]) brOnly.push(i);
    };
    for (let i = 0; i < lo; i++) check(i);
    for (let i = hiN; i < total; i++) check(i);

    // 上千行逐个改 innerHTML 比整篇重建还慢，超过阈值就换一条路
    if (dirty.length > PATCH_REBUILD_LIMIT) {
      let html = '';
      for (let i = 0; i < total; i++) html += this._rowHtml(i, src[i], lines[i]);
      this.hlCode.innerHTML = html;
      this._rows = Array.from(this.hlCode.children);
    } else {
      for (const i of dirty) this._paintRow(i);
    }
    // 括号层：先同步处理可见区（brOnly 升序，靠前就是光标附近），剩下的分帧追
    const syncN = Math.min(brOnly.length, BR_SYNC_MAX);
    for (let k = 0; k < syncN; k++) {
      const i = brOnly[k];
      if (!this._recolorRow(i)) this._paintRow(i);
    }
    if (brOnly.length > syncN) this._queueBrTail(brOnly[syncN]);
    this.syncScroll();
    this._afterPaint();
  }

  /** 括号重着色的尾巴：分帧处理，每帧 BR_CHUNK 行，不阻塞输入 */
  _queueBrTail(from) {
    if (this._brFrom == null || from < this._brFrom) this._brFrom = from;
    if (this._brRaf) return;
    const step = () => {
      this._brRaf = 0;
      const total = this._rows ? this._rows.length : 0;
      const start = this._brFrom == null ? 0 : this._brFrom;
      const end = Math.min(total, start + BR_CHUNK);
      for (let i = start; i < end; i++) {
        if (!this._recolorRow(i)) this._paintRow(i);
      }
      if (end < total) { this._brFrom = end; this._brRaf = requestAnimationFrame(step); }
      else { this._brFrom = null; this._afterPaint(); }
    };
    this._brRaf = requestAnimationFrame(step);
  }

  /**
   * 只把一行的括号 class 换掉（括号深度整体偏移时的高频路径）。
   * 2000 行文件里敲一个 ( 会让后面每一行的括号层都变，逐行重建 innerHTML 要 260ms；
   * 括号 span 都是 .lt 的直接子元素，按 children 扫一遍只改 className，量级低一个数量级。
   * @returns {boolean} false 表示行内括号个数变了，得整行重绘
   */
  _recolorRow(i) {
    const row = this._rows[i];
    const lt = row && row.children[2];
    if (!lt) return false;
    const want = this._brRow[i];
    const arr = want ? want.split(',') : EMPTY_ARR;
    const kids = lt.children;
    let j = 0;
    for (let k = 0; k < kids.length; k++) {
      const el = kids[k];
      const c = el.className;
      if (c.charCodeAt(0) !== 98 || c.charCodeAt(1) !== 107) continue;   // 不是 .bk
      if (j >= arr.length) return false;                                  // 多了括号，交给整行重绘
      const col = BR_COLOR[arr[j]] || BR_COLOR.d0;
      if (el.style.color !== col) el.style.color = col;
      j++;
    }
    return j === arr.length;
  }

  /** 重绘之后的收尾：未闭合括号标红 + 重挂光标配对高亮（innerHTML 重建会丢掉它们） */
  _afterPaint() {
    if (!this.bracketColors) { this._bkmEls = null; return; }
    for (const u of this._brUn) {
      const el = this._bkEl(u.line, u.idx);
      if (el && el.style.color !== BR_COLOR.bku) el.style.color = BR_COLOR.bku;
    }
    this.updateBrMatch();
  }

  /** 第 line 行第 idx 个括号 span */
  _bkEl(line, idx) {
    const row = this._rows && this._rows[line];
    if (!row) return null;
    const lt = row.children[2];
    if (!lt) return null;
    return lt.querySelectorAll('.bk')[idx] || null;
  }

  /** 光标紧邻的括号 + 它的配对一起高亮（VSCode 的 matchBrackets） */
  updateBrMatch() {
    const old = this._bkmEls;
    if (old) {
      for (const el of old) if (el) el.classList.remove('bkm');
      this._bkmEls = null;
    }
    if (!this.bracketColors || !this._rows || !this._br.length) return;
    const ta = this.ta;
    if (ta.selectionStart !== ta.selectionEnd) return;
    // 先做最便宜的判断：光标左右都不是括号就直接退出，别为一次按键重建整行索引
    const v = ta.value, p = ta.selectionStart;
    const cL = v[p - 1] || '', cR = v[p] || '';
    if (!BRK_CHARS[cL] && !BRK_CHARS[cR]) return;
    const { line, col } = this._posToLineCol(p);
    const arr = this._brMapOf()[line];
    if (!arr) return;
    // 光标左右各试一个位置（点在括号前 / 括号后都算贴住）
    let hit = -1;
    for (const bi of arr) {
      const b = this._br[bi];
      if (b.col === col) { hit = bi; break; }
      if (b.col === col - 1) hit = bi;
    }
    if (hit < 0) return;
    const a = this._br[hit];
    const els = [];
    const ea = this._bkEl(a.line, a.idx);
    if (ea) { ea.classList.add('bkm'); els.push(ea); }
    if (a.pair >= 0) {
      const b = this._br[a.pair];
      const eb = this._bkEl(b.line, b.idx);
      if (eb) { eb.classList.add('bkm'); els.push(eb); }
    }
    if (els.length) this._bkmEls = els;
  }

  _brMapOf() {
    if (!this._brMap) {
      const byLine = [];
      for (let i = 0; i < this._br.length; i++) {
        const l = this._br[i].line;
        (byLine[l] || (byLine[l] = [])).push(i);
      }
      this._brMap = byLine;
    }
    return this._brMap;
  }

  /** 文档偏移 → 行号（0 基）+ 行内列（0 基） */
  _posToLineCol(pos) {
    const v = this.ta.value;
    let line = 0, lineStart = 0;
    for (let i = pos - 1; i >= 0; i--) {
      if (v.charCodeAt(i) === 10) { line++; if (!lineStart) lineStart = i + 1; }
    }
    return { line, col: pos - lineStart };
  }

  _setLnPad(total) {
    const digits = Math.max(2, String(total).length);
    if (digits === this._digits) return;
    this._digits = digits;
    // 行号占位 = 位数 + 2 个空格间隔；#ta 的 padding-left 用同一变量，输入层与显示层水平对齐
    document.documentElement.style.setProperty('--ln-pad', String(digits + 2));
    this._padTop = null;
  }

  _rowHtml(i, srcHtml, rawLine) {
    const sev = this.diags.get(i + 1) || this.lintMap.get(i + 1);
    // .gi 始终存在（缩进 0 时宽 0），这样 .ln/.lt 的下标恒为 1/2，补丁可以 O(1) 取到
    const n = this.guides ? indentLevels(rawLine || '') : 0;
    return '<div class="cl' + (sev === 'error' ? ' err' : sev === 'warning' ? ' warn' : '') + '">' +
      '<span class="gi" style="width:' + n * 4 + 'ch"></span>' +
      '<span class="ln">' + (i + 1) + '</span>' +
      '<span class="lt">' + (srcHtml || '') + '</span></div>';
  }

  _rowEl(i) {
    const box = document.createElement('div');
    box.innerHTML = this._rowHtml(i, this._src[i], this._lines[i]);
    return box.firstElementChild;
  }

  /** 用新行替换 [lo, hiOld) 这段旧行 */
  _replaceRows(lo, hiNew, hiOld) {
    const rows = this._rows;
    const added = hiNew - lo, removed = hiOld - lo;
    const keep = Math.min(added, removed);
    for (let k = 0; k < keep; k++) this._paintRow(lo + k);

    if (added > removed) {
      const made = [];
      const frag = document.createDocumentFragment();
      for (let k = keep; k < added; k++) {
        const el = this._rowEl(lo + k);
        made.push(el);
        frag.appendChild(el);
      }
      this.hlCode.insertBefore(frag, rows[hiOld] || null);
      rows.splice(lo + keep, 0, ...made);
      this._renumber(lo + keep);
    } else if (removed > added) {
      for (let k = added; k < removed; k++) rows[lo + k].remove();
      rows.splice(lo + added, removed - added);
      this._renumber(lo + added);
    }
  }

  /** 行号重排：只有在插入/删除行之后才需要 */
  _renumber(from) {
    const rows = this._rows;
    for (let i = from; i < rows.length; i++) {
      const ln = rows[i].children[1];
      const want = String(i + 1);
      if (ln && ln.textContent !== want) ln.textContent = want;
    }
  }

  _paintRow(i) {
    const row = this._rows[i];
    if (!row) return;
    const sev = this.diags.get(i + 1) || this.lintMap.get(i + 1);
    const cls = 'cl' + (sev === 'error' ? ' err' : sev === 'warning' ? ' warn' : '');
    if (row.className !== cls) row.className = cls;
    const lt = row.children[2];
    const html = this._src[i] || '';
    if (lt && lt.innerHTML !== html) {
      lt.innerHTML = html;
      if (this.bracketColors) this._recolorRow(i);
    }
    const gi = row.children[0];
    if (gi) {
      const w = (this.guides ? indentLevels(this._lines[i] || '') : 0) * 4 + 'ch';
      if (gi.style.width !== w) gi.style.width = w;
    }
  }

  /** 只刷新行号颜色（诊断/实时检查用），不碰代码 DOM */
  paintMarks() {
    if (!this._rows || this._rows.length !== this._lines.length) { this.render(); return; }
    for (let i = 0; i < this._rows.length; i++) {
      const sev = this.diags.get(i + 1) || this.lintMap.get(i + 1);
      const cls = 'cl' + (sev === 'error' ? ' err' : sev === 'warning' ? ' warn' : '');
      if (this._rows[i].className !== cls) this._rows[i].className = cls;
    }
  }

  /** 符号表懒计算：输入时不重复扫全文 */
  get syms() {
    if (!this._symCache) this._symCache = extractSymbols(this.ta.value);
    return this._symCache;
  }

  /** 缩进参考线开关 */
  setIndentGuides(on) {
    const next = !!on;
    if (next === this.guides) return;
    this.guides = next;
    if (!this._rows) { this.render(); return; }
    for (let i = 0; i < this._rows.length; i++) this._paintRow(i);
  }

  /** 字体（设置里切换），CSS 变量一变两层同时换，永远保持对齐 */
  setFontFamily(css) {
    document.documentElement.style.setProperty('--code-font', css);
    this._padTop = null;
    this._padLeft = null;
    if (this._mirrorEl) this._mirrorEl.style.fontFamily = css;
    this.syncScroll();
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
    const host = this.host;
    if (host && host.scrollTop !== 0) host.scrollTop = 0;
    // 浮层跟着代码一起走
    if (this.acOpen) this.placeAc();
    if (!this.sigEl.classList.contains('hidden')) this.placeSig();
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
    if (y < top) ta.scrollTop = Math.max(0, y);
    else if (y + lh > top + viewH) ta.scrollTop = Math.max(0, y + lh - viewH);
    this.syncScroll();
  }

  /** 光标行当前在屏幕上的 y（用于面板开合时保持画面不动） */
  caretScreenY() {
    const ta = this.ta;
    const lh = this.lineHeight || 20;
    if (this._padTop == null) this._padTop = parseFloat(getComputedStyle(ta).paddingTop) || 8;
    let line = 0;
    const v = ta.value;
    for (let i = ta.selectionStart - 1; i >= 0; i--) if (v.charCodeAt(i) === 10) line++;
    return ta.getBoundingClientRect().top + this._padTop + line * lh - ta.scrollTop;
  }

  /** 面板开合后把光标行拉回原来的屏幕位置：界面看起来是"面板盖上来"，代码不跟着跳 */
  keepCaretScreenY(y) {
    const ta = this.ta;
    const now = this.caretScreenY();
    const dy = now - y;
    if (Math.abs(dy) < 0.5) return;
    ta.scrollTop = Math.max(0, ta.scrollTop + dy);
    this.syncScroll();
  }

  /**
   * 在"编辑区滚动位置不变"的前提下执行一段 DOM 操作。
   * WebView 在布局变化后可能替我们把 textarea 滚一下（reveal caret），
   * 表现就是"补全弹窗一出来，正在编辑的那一行动了"。这里做完立刻还原，
   * 下一帧再兜一次（引擎的滚动修正常发生在布局之后）。
   */
  _lockScroll(fn) {
    const ta = this.ta;
    const y = ta.scrollTop, x = ta.scrollLeft;
    fn();
    if (ta.scrollTop !== y || ta.scrollLeft !== x) { ta.scrollTop = y; ta.scrollLeft = x; this.syncScroll(); }
    if (!this._lockRaf) {
      this._lockRaf = requestAnimationFrame(() => {
        this._lockRaf = 0;
        if (ta.scrollTop !== y || ta.scrollLeft !== x) { ta.scrollTop = y; ta.scrollLeft = x; this.syncScroll(); }
      });
    }
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
    this.paintMarks();
  }

  /** 实时检查结果（不编译）：只影响行号栏染色，编译诊断优先 */
  setLint(items) {
    const next = new Map();
    for (const it of items || []) {
      if (!it.line) continue;
      const cur = next.get(it.line);
      if (cur === 'error') continue;
      next.set(it.line, it.severity === 'error' ? 'error' : 'warning');
    }
    // 没变化就别重绘：输入时每 220ms 都会调一次，大文件上重绘不便宜
    let same = next.size === this.lintMap.size;
    if (same) for (const [k, v] of next) if (this.lintMap.get(k) !== v) { same = false; break; }
    this.lintMap = next;
    if (!same) this.paintMarks();
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
    this.updateBrMatch();
  }

  /**
   * 光标在内容坐标里的位置（含 padding，未扣滚动）。
   * y 直接用行号算（wrap=off，每行固定 lineHeight），x 只把「当前行光标前的内容」放进测量盒。
   * 早先是把整个文件都塞进 mirror：2000 行时要 8~20ms，还让 WebView 反复重排，
   * 是输入卡顿和视图晃动的来源之一。
   */
  caretXY(pos) {
    const ta = this.ta, v = ta.value;
    let line = 0, lineStart = 0;
    for (let i = pos - 1; i >= 0; i--) {
      if (v.charCodeAt(i) === 10) { line++; if (!lineStart) lineStart = i + 1; }
    }
    if (this._padTop == null) this._padTop = parseFloat(getComputedStyle(ta).paddingTop) || 8;
    if (this._padLeft == null) this._padLeft = parseFloat(getComputedStyle(ta).paddingLeft) || 0;

    const d = this._mirror();
    const cs = getComputedStyle(ta);
    if (d.style.fontFamily !== cs.fontFamily) d.style.fontFamily = cs.fontFamily;
    d.style.fontSize = cs.fontSize;
    d.style.lineHeight = cs.lineHeight;
    d.style.letterSpacing = cs.letterSpacing;
    d.style.tabSize = cs.tabSize;
    d.textContent = v.slice(lineStart, pos);
    const w = d.getBoundingClientRect().width;
    d.textContent = '';
    return { x: this._padLeft + w, y: this._padTop + line * (this.lineHeight || 20), lh: this.lineHeight || 20 };
  }

  /** 测量盒：放在 #code-wrap 里（overflow: clip），量完即清空，绝不影响页面布局 */
  _mirror() {
    if (!this._mirrorEl) {
      const d = document.createElement('div');
      d.setAttribute('aria-hidden', 'true');
      d.style.cssText = 'position:absolute;left:0;top:0;white-space:pre;visibility:hidden;' +
        'pointer-events:none;contain:layout paint;tab-size:4;padding:0;margin:0;border:0;';
      this.wrap.appendChild(d);
      this._mirrorEl = d;
    }
    return this._mirrorEl;
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
      this.patch();
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
    this.patch();
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
    // 增量过滤（VS Code Refilter.Incr）：前缀在旧词上追加时，只在旧结果里再筛，
    // 集合只收窄不引入新项 —— 打字时列表不「洗牌」
    const inc = this.acOpen && this.acItems.length > 0 && prefix.startsWith(this._acWord) && prefix.length > this._acWord.length;
    const cursorLine = this.ta.value.slice(0, this.ta.selectionStart).split('\n').length;
    const items = suggestions(prefix, this.syms, this.acMember, {
      prevItems: inc ? this.acItems : null,
      prevWord: this._acWord,
      cursorLine
    });
    this._acWord = prefix;
    if (!items.length) { this.hideAc(); return; }
    // 前缀记忆（VS Code recentlyUsedByPrefix）：上次在这个词下选中的项，这次仍作预选
    this.acPreIdx = this._acMemHit(prefix, items);
    // 候选列表没变就别重建 DOM（连续打字时列表通常只是整体不变）
    const sig = prefix + '\u0001' + this.acMember + '\u0001' + items.map((it) => it.label).join('\u0001');
    const sameList = this.acOpen && sig === this._acSig;
    this.acItems = items;
    this._acSig = sig;
    this.acPrefix = prefix;
    this.acFrom = from;
    this.acOpen = true;
    // 浮层的所有 DOM 操作都在"锁定编辑区滚动"的范围内做：
    // WebView 布局变化后可能替我们滚 textarea，这里立刻还原，保证正在编辑的那一行不动。
    this._lockScroll(() => {
      if (!sameList) {
        this.acIndex = -1;        // 未选中：第一项只作为"预选"提示，第一下 ↓ 才落到它上面
        this.acNavigated = false;
        this.renderAc();
      }
      // 光标位置只在弹出时测一次；滚动时用缓存值重算，避免滚动里反复做 DOM 测量
      this._acPos = this.caretContentPos();
      this.acEl.classList.remove('hidden');
      this.placeAc();
    });
  }

  /** 光标在"内容坐标"里的位置（含 padding，未扣滚动） */
  caretContentPos() {
    const { x, y, lh } = this.caretXY(this.ta.selectionStart);
    return { x, y, lh };
  }

  _hostOffset() {
    const hr = this.host.getBoundingClientRect();
    const tr = this.ta.getBoundingClientRect();
    return { ox: tr.left - hr.left, oy: tr.top - hr.top };
  }

  /**
   * 把浮层摆到光标处：容器相对定位 + 可视区钳制。
   * 早先用 position:fixed 直接吃 getBoundingClientRect，软键盘弹出/视口平移时
   * 坐标系一变整块就飞走（表现为"乱跳"）；现在锚在编辑区容器内，位置只跟代码滚动有关。
   * 下方优先；放不下就按可用高度收缩而不是整块翻走，只有下方实在没地方才翻到光标上方。
   */
  placeAc() {
    if (!this.acOpen || !this._acPos) return;
    const el = this.acEl, host = this.host, p = this._acPos;
    const { ox, oy } = this._hostOffset();
    const hw = host.clientWidth, hh = host.clientHeight;
    const caretTop = oy + p.y - this.ta.scrollTop;
    const belowY = caretTop + p.lh + 2;
    const spaceBelow = hh - 4 - belowY;
    const spaceAbove = caretTop - 6;
    const below = spaceBelow >= 120 || spaceBelow >= spaceAbove;
    el.style.maxHeight = Math.max(72, Math.min(220, below ? spaceBelow : spaceAbove)) + 'px';

    const pw = el.offsetWidth || 190, ph = el.offsetHeight || 120;
    let left = ox + p.x - this.ta.scrollLeft;
    let top = below ? belowY : caretTop - ph - 4;
    left = Math.min(Math.max(4, hw - pw - 4), Math.max(4, left));
    top = Math.min(Math.max(4, hh - ph - 4), Math.max(4, top));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  renderAc() {
    const html = this.acItems.map((it, i) => {
      const kindCls = it.kind === 'kw' ? 'kw' : it.kind === 'fn' || it.kind === 'mem' ? 'fn' : it.kind === 'ty' || it.kind === 'sym' ? 'ty' : 'sym';
      const kindTxt = it.kind === 'kw' ? 'K' : it.kind === 'fn' ? 'f' : it.kind === 'mem' ? 'm' : it.kind === 'sn' ? 'S' : 'T';
      const detail = (it.sig || it.doc || '').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
      // acIndex = -1 时预选项带 pre（淡色预选）：说明 Tab 会插它，但方向键还没挑
      const cls = i === this.acIndex ? ' sel' : (this.acIndex < 0 && i === this.acPreIdx ? ' pre' : '');
      return '<div class="ac-item' + cls + '" data-i="' + i + '">' +
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

  /**
   * 方向键移动选择。
   * 还没选中时（acIndex = -1），第一下不管上还是下都落在第 1 项 —— 用户按 ↓ 就是想要第一项，
   * 不能一按就跳到第二项。
   * @returns {boolean} false 表示已到边界（调用方据此关闭补全）
   */
  moveAc(d) {
    const n = this.acItems.length;
    if (!n) return false;
    if (this.acIndex < 0) {
      this.acIndex = Math.min(this.acPreIdx, n - 1);   // 第一下落在预选项（记忆命中时不足第 1 项）
      this._lockScroll(() => this.renderAc());
      return true;
    }
    const next = this.acIndex + d;
    if (next < 0 || next >= n) return false;
    this.acIndex = next;
    this._lockScroll(() => this.renderAc());
    return true;
  }

  /** 当前会被接受的候选（未挑过就是预选项；越界保护防列表变化后越界） */
  currentAcItem() {
    const i = this.acIndex < 0 ? Math.min(this.acPreIdx, this.acItems.length - 1) : this.acIndex;
    return this.acItems[i];
  }

  hideAc() {
    this.acOpen = false;
    this.acNavigated = false;
    this.acEl.classList.add('hidden');
  }

  // ── 前缀记忆（VS Code suggestMemory 的 recentlyUsedByPrefix 简化版）──
  _acMemAll() {
    if (!this._acMem) {
      let m = {};
      try { m = JSON.parse(localStorage.getItem('pocketcode.acmem.v1') || '{}') || {}; } catch (e) { /* 忽略 */ }
      this._acMem = m;
    }
    return this._acMem;
  }
  _acMemHit(prefix, items) {
    if (!prefix) return 0;
    const rec = this._acMemAll()[prefix];
    if (!rec) return 0;
    const i = items.findIndex((it) => it.label === rec.label);
    return i > 0 ? i : 0;   // 命中且不在首位才需要换预选；找不到（比如这次没匹配上）就回第 1 项
  }
  _acMemRemember(prefix, label) {
    if (!prefix) return;
    const mem = this._acMemAll();
    mem[prefix] = { label, t: Date.now() };
    const keys = Object.keys(mem);
    if (keys.length > 100) {
      keys.sort((a, b) => mem[a].t - mem[b].t).slice(0, keys.length - 100).forEach((k) => delete mem[k]);
    }
    try { localStorage.setItem('pocketcode.acmem.v1', JSON.stringify(mem)); } catch (e) { /* 忽略 */ }
  }

  acceptAc() {
    if (!this.acOpen) return;
    const it = this.currentAcItem();
    this.hideAc();
    if (!it) return;
    this._acMemRemember(this.acPrefix, it.label);
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
    const item = lookup(ctx.name) || this.syms.find((s) => s.label === ctx.name);
    if (!item) return this.hideSig();
    const sig = item.sig || '';
    const p0 = sig.indexOf('('), p1 = sig.lastIndexOf(')');
    if (p0 < 0 || p1 <= p0) return this.hideSig();
    const parts = sig.slice(p0 + 1, p1).split(',');
    const esc = (t) => t.replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
    const html = '<b>' + esc(item.label) + '</b>(' +
      parts.map((p, k) => (k === ctx.idx ? '<b>' + esc(p) + '</b>' : esc(p))).join(', ') + ')';
    this._lockScroll(() => {
      this.sigEl.innerHTML = html;
      this._sigPos = this.caretContentPos();
      this.sigEl.classList.remove('hidden');
      this.placeSig();
    });
  }

  placeSig() {
    if (!this._sigPos) return;
    const el = this.sigEl, host = this.host, p = this._sigPos;
    const { ox, oy } = this._hostOffset();
    const hw = host.clientWidth, hh = host.clientHeight;
    const pw = el.offsetWidth || 160, ph = el.offsetHeight || 24;
    let left = ox + p.x - this.ta.scrollLeft;
    let top = oy + p.y - this.ta.scrollTop - ph - 4;
    left = Math.min(Math.max(4, hw - pw - 4), Math.max(4, left));
    top = Math.min(Math.max(4, hh - ph - 4), Math.max(4, top));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
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
