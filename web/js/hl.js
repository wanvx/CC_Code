// C / C++ 语法高亮（正则分词，够快够用）
//
// 两套染色：
//   classic（默认，Material 风）—— 输出与旧版逐字节一致
//   vscode（Dark+ / Light+ 语义映射）—— 关键字拆控制流 / 存储修饰、内置类型与 STL 分色、
//                                        标识符浅蓝、#include 目标串色，全靠 CSS 变量落地
// 括号着色（VSCode 的 bracketPairColorization）：按嵌套深度 0/1/2 循环，多余的闭括号标红。

// 控制流关键字（VSCode: keyword.control → #C586C0）
const KW_CTL = new Set([
  'break','case','continue','default','do','else','for','goto','if','return','switch','while',
  'new','delete','this','try','catch','throw','co_await','co_return','co_yield'
]);
// 存储 / 修饰 / 其它关键字（VSCode: keyword / storage → #569CD6）
const KW_STOR = new Set([
  'auto','const','enum','extern','inline','register','restrict','sizeof','static','struct','typedef',
  'union','volatile','class','namespace','template','typename','public','private','protected',
  'virtual','override','final','using','noexcept','constexpr','consteval','constinit','decltype',
  'nullptr','static_cast','dynamic_cast','reinterpret_cast','const_cast','operator','friend',
  'explicit','mutable','thread_local','alignas','alignof','static_assert','export','concept',
  'requires','typeid','and','or','not'
]);
const KW = new Set([...KW_CTL, ...KW_STOR]);

// 内置基本类型（VSCode: storage.type → #569CD6）
const TY_BASIC = new Set([
  'void','bool','char','wchar_t','char8_t','char16_t','char32_t','short','int','long','float','double',
  'signed','unsigned','size_t','ssize_t','ptrdiff_t','int8_t','int16_t','int32_t','int64_t','uint8_t',
  'uint16_t','uint32_t','uint64_t','intptr_t','uintptr_t'
]);
// 库 / 模板类型名（VSCode: entity.name.type → #4EC9B0）
const TY_STL = new Set([
  'FILE','string','vector','map','set','pair','array','deque','queue','stack','list','unordered_map',
  'unordered_set','stringstream','ifstream','ofstream','shared_ptr','unique_ptr','weak_ptr','function',
  'tuple','optional','variant','iterator','std','cout','cin','cerr','endl','string_view','span',
  'initializer_list'
]);
// 字面量常量（VSCode: constant.language → #569CD6）
const CONST_LIT = new Set(['true', 'false', 'NULL']);
const TY = new Set([...TY_BASIC, ...TY_STL, ...CONST_LIT]);

const RE_STR = String.raw`(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|^[ \t]*#[ \t]*[a-zA-Z_]+[^\n]*|"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?|` + '`[^`]*`?' + String.raw`|\b\d[\w.]*\b|[A-Za-z_]\w*)`;
const RE = new RegExp(RE_STR, 'gm');
// 预处理行里的目标部分：<cstdio> / "my.h"（VSCode 里是字符串色，classic 下与指令同色）
const RE_INC = /(<[^>\n]*>|"[^"\n]*")/g;

const BRK_OPEN = { '(': ')', '[': ']', '{': '}' };
const BRK_CLOSE = { ')': '(', ']': '[', '}': '{' };

// 转义是热路径上最频繁的调用（每个 token 一次），先做一次廉价探测再决定要不要 replace
function esc(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1) return s;
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 定义类型的那些关键字：紧跟其后的标识符按类型名染色（VSCode 里是 #4EC9B0）
const TAG_KW = new Set(['struct', 'class', 'enum', 'union', 'typedef', 'typename', 'using']);

/** classic 模式下的分类（与旧版完全一致） */
function clsClassic(t, next) {
  if (KW.has(t)) return 'tk-key';
  if (TY.has(t)) return 'tk-type';
  if (next === '(') return 'tk-fn';
  return null;
}

/**
 * vscode 模式：按 VSCode 的 TextMate scope 近似分层。
 * 普通标识符返回 null —— 不给每个变量包 span（2000 行会多出上万个节点，拖慢增量重绘），
 * 改由 .lt 继承 --tk-id 的颜色，视觉一致。
 */
function clsVscode(t, next, prevKw) {
  if (KW_CTL.has(t)) return 'tk-ctl';
  if (KW_STOR.has(t)) return 'tk-key';
  if (TY_BASIC.has(t)) return 'tk-kwtype';
  if (TY_STL.has(t)) return 'tk-type';
  if (CONST_LIT.has(t)) return 'tk-const';
  if (prevKw && TAG_KW.has(prevKw)) return 'tk-type';   // struct Node / using Vec = ...
  if (next === '(') return 'tk-fn';
  return null;
}

export function highlightHtml(code) {
  const out = [];
  let last = 0;
  RE.lastIndex = 0;
  let m;
  while ((m = RE.exec(code)) !== null) {
    if (m.index > last) out.push(esc(code.slice(last, m.index)));
    const t = m[0];
    const c = t[0];
    if (t.startsWith('//') || t.startsWith('/*')) {
      out.push('<span class="tk-com">' + esc(t) + '</span>');
    } else if (c === '#') {
      out.push('<span class="tk-pre">' + esc(t) + '</span>');
    } else if (c === '"' || c === "'" || c === '`') {
      out.push('<span class="tk-str">' + esc(t) + '</span>');
    } else if (c >= '0' && c <= '9') {
      out.push('<span class="tk-num">' + esc(t) + '</span>');
    } else {
      const next = code.slice(m.index + t.length, m.index + t.length + 1);
      const cls = clsClassic(t, next);
      out.push(cls ? '<span class="' + cls + '">' + esc(t) + '</span>' : esc(t));
    }
    last = m.index + t.length;
  }
  if (last < code.length) out.push(esc(code.slice(last)));
  return out.join('');
}

export const KEYWORDS = KW;
export const TYPES = TY;

/**
 * 单趟输出「每行一段 HTML」。
 *
 * @param {string} code
 * @param {{vscode?:boolean, brackets?:boolean, brOut?:Array, unmatchedOut?:Array}} [opts]
 *   vscode      语义细分分层（控制流 / 内置类型 / STL / 标识符）
 *   brackets    括号着色：每个括号包成 <span class="bk dN">，多余的闭括号 bku
 *   brOut       括号位置输出：[{line, col, idx, ch, depth, pair}]，供光标配对高亮用
 *   unmatchedOut 未闭合的开括号输出：[{line, col, idx, ch}]（扫描结束后才知道，由调用方标红）
 *   rowClsOut   每行括号 class 的摘要（"d0,d1,bku"）：比较两版代码时判断
 *               "只是括号颜色变了" 比逐行跑正则便宜一个数量级
 */
export function highlightLines(code, opts) {
  const o = opts || {};
  const brOn = !!o.brackets;
  const vs = !!o.vscode;
  const brOut = o.brOut || null;
  const unmatchedOut = o.unmatchedOut || null;
  const rowClsOut = o.rowClsOut || null;
  if (unmatchedOut) unmatchedOut.length = 0;
  if (rowClsOut) rowClsOut.length = 0;

  const lines = [];
  let cur = '';
  let last = 0;
  let m;
  RE.lastIndex = 0;

  let col = 0;      // 当前行已走过的原文字符数（brOut 用）
  let brIdx = 0;    // 当前行已输出的括号 span 数
  let depth = 0;    // 括号嵌套深度（跨行延续）
  let prevKw = '';  // 上一个标识符类 token（用于 struct X 判定）
  let rowBr = '';   // 当前行的括号 class 摘要（"d0,d1"）
  let brN = 0;      // brOut 已用条数（对象复用，避免每次 patch 分配几千个对象）
  const pending = [];   // 待配对的开括号：{ch（配对的闭符）, bi, line, col, idx, ch0（本身）}

  /** 往 brOut 里放一条，复用旧对象；返回下标 */
  const pushBr = (line, c, idx, ch, d) => {
    if (!brOut) return -1;
    let o = brOut[brN];
    if (!o) o = brOut[brN] = { line: 0, col: 0, idx: 0, ch: '', depth: 0, pair: -1 };
    o.line = line; o.col = c; o.idx = idx; o.ch = ch; o.depth = d; o.pair = -1;
    return brN++;
  };

  const newline = () => {
    lines.push(cur);
    if (rowClsOut) rowClsOut.push(rowBr);
    cur = ''; col = 0; brIdx = 0; rowBr = '';
  };

  const emitBr = (ch, isOpen) => {
    const line = lines.length;
    const c = col;
    let cls;
    if (isOpen) {
      cls = 'bk d' + (depth % 3);
      const bi = pushBr(line, c, brIdx, ch, depth);
      pending.push({ ch: BRK_OPEN[ch], bi, line, col: c, idx: brIdx, ch0: ch });
      depth++;
    } else {
      const top = pending[pending.length - 1];
      if (top && top.ch === ch) {
        pending.pop();
        depth--;
        cls = 'bk d' + (depth % 3);
        const bi = pushBr(line, c, brIdx, ch, depth);
        if (bi >= 0) brOut[bi].pair = top.bi;          // 闭括号指向它的开括号
        if (top.bi >= 0 && bi >= 0) brOut[top.bi].pair = bi;
      } else {
        cls = 'bk bku';
        pushBr(line, c, brIdx, ch, -1);
      }
    }
    brIdx++;
    // HTML 里只写占位 class：深度全部通过 rowClsOut 传给编辑器。
    // 这样「敲一个 ( 让后面所有行的括号层级整体偏移」不会改动任何行的 HTML，
    // 增量重绘只需要改 className，不用重建上千行。
    cur += '<span class="bk">' + ch + '</span>';
    rowBr += (rowBr ? ',' : '') + (cls === 'bk bku' ? 'bku' : cls.slice(3));
    col++;
  };

  // 预处理行：指令部分 tk-pre，目标部分 tk-inc
  const putPre = (raw) => {
    RE_INC.lastIndex = 0;
    let i = 0, mm;
    while ((mm = RE_INC.exec(raw)) !== null) {
      if (mm.index > i) { cur += '<span class="tk-pre">' + esc(raw.slice(i, mm.index)) + '</span>'; }
      cur += '<span class="tk-inc">' + esc(mm[0]) + '</span>';
      i = mm.index + mm[0].length;
    }
    if (i < raw.length) cur += '<span class="tk-pre">' + esc(raw.slice(i)) + '</span>';
    col += raw.length;
  };

  /** 把一段原文（可能含换行）落到行缓冲里；cls 为 null 时可选做括号扫描 */
  const put = (raw, cls) => {
    if (!raw) return;
    if (cls === 'tk-pre' && raw.indexOf('\n') === -1) { putPre(raw); return; }
    const parts = raw.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i) newline();
      const seg = parts[i];
      if (!seg) continue;
      if (cls || !brOn) {
        cur += cls ? '<span class="' + cls + '">' + esc(seg) + '</span>' : esc(seg);
        col += seg.length;
        continue;
      }
      let s = 0;
      for (let k = 0; k < seg.length; k++) {
        const ch = seg[k];
        const isOpen = !!BRK_OPEN[ch];
        if (!isOpen && !BRK_CLOSE[ch]) continue;
        if (k > s) { cur += esc(seg.slice(s, k)); col += k - s; }
        emitBr(ch, isOpen);
        s = k + 1;
      }
      if (s < seg.length) { cur += esc(seg.slice(s)); col += seg.length - s; }
    }
  };

  while ((m = RE.exec(code)) !== null) {
    if (m.index > last) put(code.slice(last, m.index), null);
    const t = m[0];
    const c = t[0];
    let cls = null;
    if (t.startsWith('//') || t.startsWith('/*')) cls = 'tk-com';
    else if (c === '#') cls = 'tk-pre';
    else if (c === '"' || c === "'" || c === '`') cls = 'tk-str';
    else if (c >= '0' && c <= '9') cls = 'tk-num';
    else {
      const next = code.slice(m.index + t.length, m.index + t.length + 1);
      cls = vs ? clsVscode(t, next, prevKw) : clsClassic(t, next);
      prevKw = t;
    }
    put(t, cls);
    last = m.index + t.length;
  }
  if (last < code.length) put(code.slice(last), null);
  lines.push(cur);
  if (rowClsOut) rowClsOut.push(rowBr);
  if (brOut) brOut.length = brN;   // 截掉复用了但这次没用到的尾巴

  // 扫完才知道哪些开括号没闭合
  if (unmatchedOut) {
    for (const p of pending) unmatchedOut.push({ line: p.line, col: p.col, idx: p.idx, ch: p.ch0 });
  }
  return lines;
}

// 把高亮 HTML 按行拆分：跨行的 span（块注释等）在行尾闭合、行首重开。
// 每行成为独立合法 HTML，才能把「行号 + 代码」包进同一个行盒里渲染。
export function splitHighlightLines(html) {
  const lines = [];
  const open = [];
  let cur = '';
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) { cur += html.slice(i); break; }
      const tag = html.slice(i, end + 1);
      if (tag[1] === '/') open.pop();
      else if (tag[tag.length - 2] !== '/') open.push(tag);
      cur += tag;
      i = end + 1;
      continue;
    }
    if (ch === '\n') {
      lines.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  lines.push(cur + '</span>'.repeat(open.length));
  return lines;
}
