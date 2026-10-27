// C / C++ 语法高亮（正则分词，够快够用）
const KW = new Set([
  'auto','break','case','const','continue','default','do','else','enum','extern','for','goto','if',
  'inline','register','restrict','return','sizeof','static','struct','switch','typedef','union',
  'volatile','while','class','namespace','template','typename','public','private','protected',
  'virtual','override','final','new','delete','this','using','try','catch','throw','noexcept',
  'constexpr','consteval','constinit','decltype','nullptr','static_cast','dynamic_cast','reinterpret_cast',
  'const_cast','operator','friend','explicit','mutable','thread_local','alignas','alignof','co_await',
  'co_return','co_yield','static_assert','export','concept','requires','typeid','and','or','not'
]);
const TY = new Set([
  'void','bool','char','wchar_t','char8_t','char16_t','char32_t','short','int','long','float','double',
  'signed','unsigned','size_t','ssize_t','ptrdiff_t','int8_t','int16_t','int32_t','int64_t','uint8_t',
  'uint16_t','uint32_t','uint64_t','intptr_t','uintptr_t','FILE','string','vector','map','set','pair',
  'array','deque','queue','stack','list','unordered_map','unordered_set','stringstream','ifstream',
  'ofstream','shared_ptr','unique_ptr','weak_ptr','function','tuple','optional','variant','iterator',
  'true','false','NULL','std','cout','cin','cerr','endl','string_view','span','initializer_list'
]);

const RE_STR = String.raw`(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|^[ \t]*#[ \t]*[a-zA-Z_]+[^\n]*|"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?|` + '`[^`]*`?' + String.raw`|\b\d[\w.]*\b|[A-Za-z_]\w*)`;
const RE = new RegExp(RE_STR, 'gm');

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
      if (KW.has(t)) out.push('<span class="tk-key">' + esc(t) + '</span>');
      else if (TY.has(t)) out.push('<span class="tk-type">' + esc(t) + '</span>');
      else if (next === '(') out.push('<span class="tk-fn">' + esc(t) + '</span>');
      else out.push(esc(t));
    }
    last = m.index + t.length;
  }
  if (last < code.length) out.push(esc(code.slice(last)));
  return out.join('');
}

export const KEYWORDS = KW;
export const TYPES = TY;

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
