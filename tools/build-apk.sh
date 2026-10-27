#!/usr/bin/env bash
# 构建 Android APK：同步 web 资源 -> assets，修补 manifest，调用 Gradle
#
# 依赖：JDK 17、Android SDK（platform 34 + build-tools）
#   export JAVA_HOME=/path/to/jdk-17
#   export ANDROID_SDK_ROOT=/path/to/android-sdk
#
# 用法：./tools/build-apk.sh [--bump]
#   --bump  versionCode 加 1（发新版本时用）
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/web"
ASSETS="$ROOT/android/app/src/main/assets"
PROJ="$ROOT/android"
OUT="$ROOT/CC_Code.apk"

[ -n "$JAVA_HOME" ] || { echo "[x] 请先设置 JAVA_HOME（需要 JDK 17）"; exit 1; }
[ -n "$ANDROID_SDK_ROOT" ] || { echo "[x] 请先设置 ANDROID_SDK_ROOT"; exit 1; }
[ -f "$WEB/clang/bin/clang.wasm.gz" ] || { echo "[x] 缺少编译器资源，先跑 npm run setup:clang"; exit 1; }

echo "[1/4] 同步 web -> assets"
rm -rf "$ASSETS"
mkdir -p "$ASSETS"
cp -r "$WEB"/. "$ASSETS"/

echo "[2/4] 修补 manifest（aapt2 会解压 .gz 并去掉后缀，路径需同步）"
sed -i 's/\.wasm\.gz/.wasm/g; s/\.tar\.gz/.tar/g' "$ASSETS/clang/runtime-manifest.v1.json"

if [ "$1" = "--bump" ]; then
  V=$(grep -oE 'versionCode [0-9]+' "$PROJ/app/build.gradle" | grep -oE '[0-9]+')
  sed -i "s/versionCode $V/versionCode $((V + 1))/" "$PROJ/app/build.gradle"
  echo "[3/4] versionCode -> $((V + 1))"
else
  echo "[3/4] 跳过 versionCode（--bump 可递增）"
fi

echo "[4/4] Gradle 构建"
cd "$PROJ"
if [ -x ./gradlew ]; then
  ./gradlew assembleDebug --no-daemon -q
else
  gradle assembleDebug --no-daemon -q
fi

cp app/build/outputs/apk/debug/app-debug.apk "$OUT"
echo "完成 -> $OUT"
