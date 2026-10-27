/* 编译执行 Worker：本地 Clang 22 (WASM) + WASI 沙箱 */
const VENDOR = new URL('../vendor/clang-wasm.global.js', self.location.href).href;
const ASSETS = new URL('../clang/', self.location.href).href;

importScripts(VENDOR);

let compiler = null;
let curLang = null;
let curStd = null;
const api = self.clangWasm;

function post(msg) { self.postMessage(msg); }

// 同源资产 fetch 经主线程代理：网关凭证在 cookie 里，而运行时加载器固定 credentials:'omit'
const nativeFetch = self.fetch.bind(self);
let proxyPort = null;
let proxySeq = 0;
const proxyPending = new Map();

function installFetchProxy(port) {
  proxyPort = port;
  port.onmessage = (e) => {
    const { id, ok, status, buf, error } = e.data;
    const p = proxyPending.get(id);
    if (!p) return;
    proxyPending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(new Response(buf, { status: status || 200 }));
  };
  self.fetch = (input, init) => {
    let url = '';
    try { url = typeof input === 'string' ? input : (input && input.url) || String(input); } catch (e) { /* 忽略 */ }
    if (url && (url.startsWith('/') || url.indexOf(self.location.origin) === 0)) {
      return new Promise((resolve, reject) => {
        const id = ++proxySeq;
        proxyPending.set(id, { resolve, reject });
        proxyPort.postMessage({ id, url });
      });
    }
    return nativeFetch(input, init);
  };
}

async function ensureCompiler(language, std, id) {
  if (compiler && curLang === language && curStd === std) return compiler;
  if (compiler) {
    try { compiler.dispose(); } catch (e) { /* 忽略 */ }
    compiler = null;
  }
  post({ type: 'status', id, phase: 'loading' });
  let last = -1;
  compiler = await api.createCompiler(language, {
    baseUrl: ASSETS,
    std,
    onProgress: (v) => {
      const pct = Math.round((v || 0) * 100);
      if (pct !== last) { last = pct; post({ type: 'progress', id, value: pct }); }
    }
  });
  curLang = language;
  curStd = std;
  return compiler;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === 'init') {
    if (msg.port) installFetchProxy(msg.port);
    return;
  }
  if (msg.type === 'preload') {
    try {
      await ensureCompiler(msg.language, msg.std, msg.id);
      post({ type: 'preloaded', id: msg.id });
    } catch (err) {
      post({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
    }
    return;
  }
  if (msg.type !== 'run') return;

  const id = msg.id;
  try {
    const c = await ensureCompiler(msg.language, msg.std, id);
    post({ type: 'status', id, phase: 'compiling' });
    const t0 = performance.now();
    const r = await c.run(msg.code, msg.stdin || '', {
      fileName: msg.fileName || (msg.language === 'c' ? 'main.c' : 'main.cpp'),
      compileArgs: msg.compileArgs || [],
      args: msg.args || []
    });
    post({
      type: 'result',
      id,
      stdout: r.stdout,
      stderr: r.stderr,
      output: r.output,
      errors: r.errors || [],
      exitCode: r.exitCode,
      compileMs: Math.round(r.compileMs != null ? r.compileMs : performance.now() - t0),
      runMs: r.runMs != null ? Math.round(r.runMs) : null
    });
  } catch (err) {
    post({ type: 'error', id, message: String((err && err.message) || err) });
  }
};
