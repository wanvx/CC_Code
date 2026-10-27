// cph 测评插件：按文件保存测试点，支持单点运行 / 全部运行
import { h } from '../plugins.js';

const KEY = 'pocketcode.cph.v1';

function loadAll() {
  try {
    const raw = localStorage.getItem(KEY);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === 'object' ? o : {};
  } catch (e) { return {}; }
}

let db = loadAll();
let saveTimer = null;

/** 清空全部数据时由外壳调用，避免内存里的旧测试点被写回 */
export function resetCphStore() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  for (const k of Object.keys(db)) delete db[k];
  try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ }
}

function persist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* 忽略 */ }
  }, 200);
}

function bucket(path) {
  if (!db[path] || !Array.isArray(db[path].tests)) db[path] = { tests: [] };
  return db[path];
}

function newId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 判题比较：忽略行尾空白与末尾空行（与主流 OJ 一致）
export function normOut(s) {
  return String(s == null ? '' : s)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

function statusOf(t) {
  if (t.status === 'pass' || t.status === 'fail' || t.status === 'error') return t.status;
  return 'none';
}

function badge(st) {
  const map = {
    pass: ['✓ PASS', 'pass'],
    fail: ['✗ FAIL', 'fail'],
    error: ['! 异常', 'err'],
    none: ['未测', 'none']
  };
  const [txt, cls] = map[st] || map.none;
  return h('span', { class: 'cph-badge ' + cls, text: txt });
}

export const cphPlugin = {
  id: 'cph',
  name: 'cph 测评',
  desc: '算法题测试点管理，单点/全部运行，输出比对',
  icon: 'cph',
  builtin: true,

  mount(host, ctx) {
    let alive = true;
    let busy = false;
    const refs = new Map(); // testId -> { el, refresh }

    const allBtn = h('button', { class: 'cph-run-all', text: '全部运行' });
    const headEl = h('div', { class: 'cph-head' });
    const listEl = h('div', { class: 'cph-list' });

    const score = () => {
      const path = ctx.path();
      const ts = path ? bucket(path).tests : [];
      const ok = ts.filter((x) => x.status === 'pass').length;
      return { total: ts.length, ok, allPass: ts.length > 0 && ok === ts.length };
    };

    function updateHead() {
      const path = ctx.path();
      const s = score();
      headEl.innerHTML = '';
      headEl.appendChild(h('span', { class: 'cph-file', text: path || '未打开文件', title: path || '' }));
      if (s.total) {
        headEl.appendChild(h('span', {
          class: 'cph-score' + (s.allPass ? ' allpass' : ''),
          text: s.allPass ? '通过 ' + s.ok + '/' + s.total + ' ✓' : '通过 ' + s.ok + '/' + s.total
        }));
      }
    }

    async function evaluate(t) {
      const r = await ctx.run(t.input || '');
      if (r.errors && r.errors.length) {
        t.status = 'error';
        t.actual = (r.errors || []).join('\n');
        return false;
      }
      t.actual = r.stdout != null ? r.stdout : (r.output || '');
      t.status = normOut(t.actual) === normOut(t.expected) ? 'pass' : 'fail';
      t.ms = r.runMs;
      return true;
    }

    async function runOne(t) {
      if (busy) return;
      if (!ctx.path()) { ctx.toast('先打开一个 .cpp 文件'); return; }
      busy = true;
      const ref = refs.get(t.id);
      t.status = 'running';
      if (ref) ref.refresh();
      try {
        await evaluate(t);
      } catch (e) {
        t.status = 'error';
        t.actual = String((e && e.message) || e);
      } finally {
        busy = false;
        persist();
        if (ref) ref.refresh();
        updateHead();
      }
    }

    async function runAll() {
      if (busy) return;
      const path = ctx.path();
      if (!path) { ctx.toast('先打开一个 .cpp 文件'); return; }
      const tests = bucket(path).tests;
      if (!tests.length) { ctx.toast('还没有测试点'); return; }
      busy = true;
      allBtn.disabled = true;
      let compileFailed = false;
      for (let i = 0; i < tests.length; i++) {
        if (!alive) return;
        const t = tests[i];
        allBtn.textContent = '评测中 ' + (i + 1) + '/' + tests.length;
        const ref = refs.get(t.id);
        t.status = 'running';
        if (ref) ref.refresh();
        try {
          const okRun = await evaluate(t);
          persist();
          if (ref) ref.refresh();
          if (!okRun) { compileFailed = true; break; }
        } catch (e) {
          t.status = 'error';
          t.actual = String((e && e.message) || e);
          if (ref) ref.refresh();
        }
      }
      busy = false;
      allBtn.disabled = false;
      allBtn.textContent = '全部运行';
      persist();
      updateHead();
      const s = score();
      if (compileFailed) ctx.toast('编译失败，已中断评测');
      else if (s.allPass) ctx.toast('全部通过 · ' + s.ok + '/' + s.total + ' ✓');
      else ctx.toast('通过 ' + s.ok + '/' + s.total);
    }

    allBtn.addEventListener('click', runAll);

    function textArea(value, onInput, rows, placeholder) {
      const ta = h('textarea', { class: 'cph-ta', rows: rows || 3, spellcheck: 'false', placeholder: placeholder || '（空）' });
      ta.value = value || '';
      ta.addEventListener('input', () => onInput(ta.value));
      return ta;
    }

    function card(t, idx) {
      const bSlot = h('span', { class: 'cph-bslot' });
      const msEl = h('span', { class: 'cph-ms' });
      const actualEl = h('pre', { class: 'cph-actual' });
      let collapsed = false;

      const el = h('div', { class: 'cph-card' });
      const runBtn = h('button', { class: 'cph-mini', text: '运行' });
      const delBtn = h('button', { class: 'cph-mini danger', text: '删除' });

      const head = h('div', { class: 'cph-card-head' },
        h('span', { class: 'cph-no', text: '#' + (idx + 1) }),
        bSlot,
        h('span', { class: 'spacer' }),
        msEl,
        runBtn);

      head.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        collapsed = !collapsed;
        el.classList.toggle('collapsed', collapsed);
      });

      runBtn.addEventListener('click', () => runOne(t));
      delBtn.addEventListener('click', () => {
        ctx.confirm('删除测试点 #' + (idx + 1), '删除后无法恢复，确定？', () => {
          const arr = bucket(ctx.path()).tests;
          const i = arr.findIndex((x) => x.id === t.id);
          if (i >= 0) arr.splice(i, 1);
          persist();
          draw();
        });
      });

      const body = h('div', { class: 'cph-card-body' },
        h('div', { class: 'cph-field' },
          h('label', { text: '输入' }),
          textArea(t.input, (v) => { t.input = v; persist(); }, 3, '标准输入')),
        h('div', { class: 'cph-field' },
          h('label', { text: '预期输出' }),
          textArea(t.expected, (v) => { t.expected = v; persist(); }, 3, '正确答案')),
        h('div', { class: 'cph-field' },
          h('label', { text: '最终输出' }),
          actualEl),
        h('div', { class: 'cph-card-foot' }, h('span', { class: 'spacer' }), delBtn));

      el.appendChild(head);
      el.appendChild(body);

      function refresh() {
        const st = statusOf(t);
        bSlot.innerHTML = '';
        bSlot.appendChild(badge(st === 'running' ? 'none' : st));
        if (st === 'running') bSlot.firstChild.textContent = '运行中';
        el.classList.toggle('is-pass', st === 'pass');
        el.classList.toggle('is-fail', st === 'fail');
        el.classList.toggle('is-err', st === 'error');
        actualEl.textContent = t.actual || '';
        actualEl.classList.toggle('bad', st === 'fail');
        msEl.textContent = st !== 'none' && st !== 'running' && t.ms != null ? (t.ms < 1 ? '<1ms' : t.ms + 'ms') : '';
      }
      refresh();
      refs.set(t.id, { el, refresh });
      return el;
    }

    function draw() {
      if (!alive) return;
      refs.clear();
      host.innerHTML = '';
      const path = ctx.path();
      const box = h('div', { class: 'cph' });

      updateHead();
      box.appendChild(h('div', { class: 'cph-top' }, headEl, allBtn));

      if (!path) {
        box.appendChild(h('div', { class: 'plug-empty' },
          h('div', { class: 'plug-empty-d', text: '先打开一个 .cpp 文件，再添加测试点。' })));
        host.appendChild(box);
        return;
      }

      listEl.innerHTML = '';
      const tests = bucket(path).tests;
      if (!tests.length) {
        listEl.appendChild(h('div', { class: 'plug-empty' },
          h('div', { class: 'plug-empty-t', text: '还没有测试点' }),
          h('div', { class: 'plug-empty-d', text: '点下方「+ 添加测试点」，填入输入和预期输出。' })));
      }
      tests.forEach((t, i) => listEl.appendChild(card(t, i)));
      box.appendChild(listEl);
      box.appendChild(h('div', { class: 'cph-add-wrap' },
        h('button', {
          class: 'cph-add', text: '+ 添加测试点',
          onclick: () => {
            const arr = bucket(ctx.path()).tests;
            arr.push({ id: newId(), input: '', expected: '', actual: '', status: 'none' });
            persist();
            draw();
            requestAnimationFrame(() => {
              const last = listEl.lastElementChild;
              if (last) last.scrollIntoView({ block: 'nearest' });
            });
          }
        })));
      host.appendChild(box);
    }

    draw();
    return () => { alive = false; persist(); };
  }
};
