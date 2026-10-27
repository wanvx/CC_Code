# CC_Code

手机 / 平板上的 C/C++ IDE。**编译器跑在本机**（Clang 22 编译成 WebAssembly），不联网也能编译运行，适合刷算法题和随手写点 C/C++。

支持 PWA（浏览器直接用）和 Android APK（原生 WebView 壳，带系统文件导出）。

## 功能

- **离线编译运行**：Clang 22 + wasm-ld + WASI 运行时全部在浏览器里跑，无后端、无上传
- **代码编辑器**：C/C++ 语法高亮、行号与代码同行对齐、自动补全（标准库 + 项目内符号）、括号配对、Ctrl+滚轮缩放
- **文件树**：单一 `root` 根目录，可无限嵌套文件夹，文件夹行内直接新建子目录 / `.cpp`，支持重命名与删除
- **标准输入**：编辑器下方常驻输入框，按文件独立保存，点「运行」自动喂给程序
- **cph 测评**（内置插件）：按文件保存测试点，输入 / 预期输出 / 最终输出，单点运行与全部运行，判定忽略行尾空白与末尾空行
- **插件系统**：插件栏只显示图标，点开展开面板；设置里可启停、删除、导入 `.json` 插件包
- **导出**：APK 走 Android SAF，可保存到平板任意文件夹；网页版降级为浏览器下载
- **检查更新**：读取本仓库的 `version.json` 比对版本（唯一需要联网的功能，失败不影响使用）

## 快速开始

### 网页版

```bash
npm install          # 安装 @live-codes/clang-wasm 与 playwright
npm run setup:clang  # 把编译器资源复制到 web/clang/
npm start            # http://localhost:8341
```

`web/` 就是完整的静态站点，随便丢到任何静态服务器上即可。Service Worker 会缓存全部资源，第二次打开完全离线可用。

> 首次编译需要加载约 28MB 的编译器，之后走缓存。

### Android APK

```bash
cd android
./gradlew assembleDebug     # 需要 JDK 17 + Android SDK 34
```

APK 把 `web/` 整个打进 `assets/`，用 `WebViewAssetLoader` 以 https 源加载，因此和网页版共用同一套代码。

一键构建脚本见 `tools/build-apk.sh`（会同步 web → assets、修补 manifest、构建并输出 APK）。

## 目录结构

```
web/                    静态站点（真正被两端共用的那套代码）
  index.html
  css/app.css
  js/app.js             应用外壳：文件树 / 标签 / 编译运行 / 设置 / 更新
  js/editor.js          编辑器：高亮渲染、补全弹窗、键盘行为
  js/complete.js        补全数据库与符号索引
  js/fs.js              虚拟文件系统（localStorage）
  js/worker.js          编译执行的 Web Worker
  js/plugins.js         插件内核
  js/plugins/cph.js     cph 测评插件
  vendor/               clang-wasm 浏览器包
  clang/                编译器资源（不入库，见 npm run setup:clang）
android/                Android 壳工程（Java + WebView）
tools/                  构建与资源准备脚本
tests/                  Playwright 端到端测试
version.json            版本号，供 app 内「检查更新」读取
```

## 插件格式

插件是一个 JSON 文件，导入后即可出现在插件栏：

```json
{
  "id": "hello",
  "name": "示例插件",
  "icon": "note",
  "desc": "演示用",
  "script": "ctx.h('div', { text: 'hello ' + ctx.path });"
}
```

`script` 会在本机执行，拿到一个 `ctx` 对象：

| 成员 | 说明 |
| --- | --- |
| `ctx.path` | 当前文件路径 |
| `ctx.code` / `ctx.setFile(text)` | 读取 / 修改当前文件 |
| `ctx.read(p)` / `ctx.write(p, text)` | 读写任意文件 |
| `ctx.listFiles()` | 列出全部文件路径 |
| `ctx.run(stdin)` | 编译并运行当前文件，返回 `{ stdout, errors, exitCode, ms }` |
| `ctx.toast(msg)` / `ctx.confirm(msg, cb)` | 交互 |
| `ctx.h(tag, props, children)` | 创建 DOM 的helper |

插件脚本在本机 JS 沙箱里运行，**只导入你自己信任的文件**。

## 测试

```bash
node server.mjs &          # 需要先起静态服务器
node tests/v3-stdin.mjs    # stdin 输入 / 补全关闭 / 关于与更新
node tests/v2-smoke.mjs    # 文件树 / 编译 / cph / 设置
node tests/inline-ln.mjs   # 行号与代码对齐回归
```

## 已知限制

- 数据存在浏览器 localStorage，卸载或清数据会丢，**没有云同步**
- 网页版的「导出」受浏览器沙箱限制，只能落到默认下载目录；要保存到任意目录请用 APK
- 编译器资源约 28MB，首次加载需要联网（或已通过 Service Worker / APK 内置）
- 只支持单文件编译（本地 `#include "x.h"` 会被内联处理）

## License

MIT
