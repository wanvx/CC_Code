// 轻量实时检查（本地纯 JS，不编译、不联网）
// 目标：在打字的瞬间就指出「括号没配对」「语句末尾漏了分号」这类低级错误，
// 不必等整轮编译。规则刻意保守——宁可漏报，也不要满屏红线。
// 编译才是最终裁判，这里只做提示。

const OPEN_OF = { ')': '(', ']': '[', '}': '{' };
const CLOSE_OF = { '(': ')', '[': ']', '{': '}' };
// 行首是这些关键字时，行尾不要求分号（控制语句 / 声明头 / 跨行结构）
const HEAD_OK = /^(if|for|while|switch|else|do|try|catch|case|default|template|namespace|using|extern|friend|operator|inline|static|constexpr|typedef|public|private|protected)\b/;
// 整行只有一个关键字 → 明显还没写完，不评判
const LONE = /^(return|throw|goto|break|continue|else|do|try|case|default)$/;
// 下一行以这些字符开头 → 说明当前行还没写完（续行 / 块开始 / 初始化列表）
const NEXT_CONT = /^[{(,)\].:?+\-*/%&|^=!<>;\\]/;
// 上一行以这些结尾 → 当前行是续行
const PREV_CONT = /[+\-*/%&|^=!,?:<>(\[]$|\b(and|or|not)$/;
// 行尾属于「值」 → 可能缺分号
const VALUE_END = /(?:\bS$|[A-Za-z0-9_\)\]\}])$/;

/**
 * @param {string} src
 * @returns {{line:number,col:number,severity:'error'|'warning',message:string}[]}
 */
export function lintCpp(src) {
  const text = String(src == null ? '' : src);
  const lines = text.split('\n');
  const out = [];
  const push = (line, col, severity, message, kind) => out.push({ line, col, severity, message, kind });

  // ── 第一遍：词法剥离注释与字面量，同时做括号配对 ──
  const bones = new Array(lines.length); // 每行去掉注释/字面量后的骨架，用于第二遍
  const stack = [];                      // 未闭合的开括号
  let inBlock = false, blockLine = 0;
  const badStrLine = new Set();          // 字面量没闭合的行，第二遍不再评判

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const isPP = /^\s*#/.test(raw);  // 预处理行（#include <x> 的尖括号不参与配对）
    let bone = '';
    let i = 0;

    while (i < raw.length) {
      const c = raw[i], n = raw[i + 1];

      if (inBlock) {
        if (c === '*' && n === '/') { inBlock = false; bone += '  '; i += 2; continue; }
        bone += ' ';
        i++;
        continue;
      }
      if (c === '/' && n === '/') break;                       // 行注释：后面全部丢弃
      if (c === '/' && n === '*') { inBlock = true; blockLine = li + 1; bone += '  '; i += 2; continue; }

      if (c === '"' || c === "'") {
        const quote = c;
        let j = i + 1, closed = false;
        while (j < raw.length) {
          if (raw[j] === '\\') { j += 2; continue; }
          if (raw[j] === quote) { closed = true; j++; break; }
          j++;
        }
        const cont = /\s*\\$/.test(raw);   // 行尾反斜杠 = 跨行字面量
        if (!closed && !isPP && !cont) {
          badStrLine.add(li);
          push(li + 1, i + 1, 'error', (quote === '"' ? '字符串' : '字符常量') + '没有闭合', 'str');
        }
        bone += 'S'.repeat(Math.max(1, Math.min(j, raw.length) - i));  // 占位，保持列位置
        i = j;
        continue;
      }

      bone += c;
      if (!isPP) {
        if (CLOSE_OF[c]) stack.push({ ch: c, line: li + 1, col: i + 1 });
        else if (OPEN_OF[c]) {
          const want = OPEN_OF[c];
          const top = stack.pop();
          if (!top) push(li + 1, i + 1, 'error', '多余的 ' + c + '，前面没有对应的 ' + want, 'paren');
          else if (top.ch !== want) {
            push(li + 1, i + 1, 'error', '括号不匹配：这里的 ' + c + ' 对不上第 ' + top.line + ' 行的 ' + top.ch + '（应该先写 ' + CLOSE_OF[top.ch] + '）', 'paren');
          }
        }
      }
      i++;
    }
    bones[li] = bone;
  }

  if (inBlock) push(blockLine, 1, 'warning', '/* 注释没有闭合', 'paren');
  // 只报最内层那一处：用户补上它以后下一轮会接着报外层，不会一次甩一堆
  if (stack.length) {
    const s = stack[stack.length - 1];
    push(s.line, s.col, 'error', s.ch === '{' ? '{ 没有闭合，后面少了一个 }' : '“' + s.ch + '” 没有闭合，后面少了一个 ' + CLOSE_OF[s.ch], 'paren');
  }

  // ── 第二遍：漏分号 / 条件里误用 = ──
  const nextBone = (from) => {
    for (let k = from + 1; k < bones.length; k++) {
      const t = bones[k].trim();
      if (t) return t;
    }
    return null;
  };
  const prevBone = (from) => {
    for (let k = from - 1; k >= 0; k--) {
      const t = bones[k].trim();
      if (t) return t;
    }
    return null;
  };

  for (let li = 0; li < bones.length; li++) {
    const t = bones[li].trim();
    if (!t || t[0] === '#' || badStrLine.has(li)) continue;

    // if / while 条件里写了赋值
    const cond = /^(?:if|while)\s*\(([^)]*)\)/.exec(t);
    if (cond && /(^|[^=!<>+\-*/%&|^])=([^=]|$)/.test(cond[1])) {
      push(li + 1, 1, 'warning', '条件里用的是赋值 =，是不是想写 == ？');
    }

    // 行尾是否"看起来写完了"
    if (/[;,\\]$/.test(t)) continue;                 // 分号 / 逗号 / 续行符结尾
    if (/\}$/.test(t)) {
      // } 结尾：只有"单行数据块"（int a[] = {1,2,3}）才可能漏分号；
      // {} 和 { 语句; } 是函数体 / lambda 体，本来就不带分号
      if (!/\{/.test(t)) continue;
      if (/\{\s*\}/.test(t) || /\{[^}]*;\s*\}/.test(t)) continue;
    } else if (/\{$/.test(t)) continue;
    else if (!VALUE_END.test(t)) continue;           // 以运算符等结尾 → 明显没写完
    if (HEAD_OK.test(t) || LONE.test(t)) continue;   // if (…) / else / template<…> 这类

    const nx = nextBone(li);
    if (nx == null) continue;                        // 文件末尾，用户可能正在写
    if (NEXT_CONT.test(nx)) continue;                // 下一行是续行 / { / 初始化列表

    const pv = prevBone(li);
    if (pv != null && PREV_CONT.test(pv)) continue;  // 本行是续行

    push(li + 1, t.length, 'warning', '这一行末尾可能少了分号 ;');
  }

  // 字符串没闭合时后面的括号配对必然跟着乱，只留字符串那条
  const hasStr = out.some((d) => d.kind === 'str');
  const kept = hasStr ? out.filter((d) => d.kind !== 'paren') : out;

  // ── 收尾：按行号排序，同行 error 优先，去掉完全重复的 ──
  const seen = new Set();
  kept.sort((a, b) => a.line - b.line || (a.severity === b.severity ? a.col - b.col : a.severity === 'error' ? -1 : 1));
  return kept.filter((d) => {
    const k = d.line + '|' + d.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 只取每行最严重的一条，用于行号栏染色 */
export function severityByLine(items) {
  const m = new Map();
  for (const d of items || []) {
    const cur = m.get(d.line);
    if (cur === 'error') continue;
    m.set(d.line, d.severity === 'error' ? 'error' : 'warning');
  }
  return m;
}
