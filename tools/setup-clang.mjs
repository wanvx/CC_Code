// 把 npm 包里的编译器资源（约 28MB，不入库）复制到 web/clang/bin/
import { cp, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const src = join(repo, 'node_modules', '@live-codes', 'clang-wasm', 'assets');
const dst = join(repo, 'web', 'clang');

try {
  await access(join(src, 'bin', 'clang.wasm.gz'));
} catch {
  console.error('[x] 找不到编译器资源，请先 npm install');
  process.exit(1);
}

await mkdir(join(dst, 'bin'), { recursive: true });
await cp(join(src, 'bin'), join(dst, 'bin'), { recursive: true });

// 浏览器端 bundle 同步一份（已在 vendor/ 里，这里兜底更新）
try {
  await cp(
    join(repo, 'node_modules', '@live-codes', 'clang-wasm', 'dist', 'clang-wasm.global.js'),
    join(repo, 'web', 'vendor', 'clang-wasm.global.js')
  );
} catch { /* vendor 里已有旧版就用旧的 */ }

console.log('[ok] web/clang/bin 已就绪');
