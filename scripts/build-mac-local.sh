#!/bin/bash
# 打包 macOS 双架构 DMG / ZIP（8.3.0）
#
# 为什么单独写成脚本：electron-builder 需要往 ~/Library/Caches/electron 写缓存，
# 在受限沙箱里会被拦成 "No such file or directory (os error 2)"。
# 请在普通终端里直接运行本脚本。
#
#   用法：bash scripts/build-mac-local.sh            # 双架构 dmg + zip
#         bash scripts/build-mac-local.sh arm64      # 只打 arm64
#
# 走 npmmirror 镜像，避免 GitHub 下载超时。

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

ARCHS="${1:-arm64 x64}"

export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

echo "==> 版本：$(node -p "require('./package.json').version")"
echo "==> 架构：$ARCHS"
echo "==> 镜像：$ELECTRON_MIRROR"

# 1. FFmpeg / ffprobe：按架构校验并准备
echo
echo "==> 准备媒体工具"
node scripts/setup-ffmpeg-mac.js $ARCHS || exit 1

# 2. 软件播放器资源（24 个 Wasm）
echo
echo "==> 准备软件播放器资源"
node scripts/setup-software-player.cjs || exit 1

# 3. 前端构建：必须先清空 dist-react，否则 vite 的 emptyOutDir
#    会连带删掉上一步刚放进去的 software/ 目录。
echo
echo "==> 构建前端"
rm -rf dist-react
npx vite build || exit 1

# 4. 前端构建完再补回软件播放器资源（vite 已清过目录）
echo
echo "==> 补齐软件播放器资源到 dist-react/software"
node scripts/setup-software-player.cjs || exit 1

# 5. 打包
echo
echo "==> 打包 DMG / ZIP"
ARGS=()
for a in $ARCHS; do ARGS+=(--"$a"); done
npx electron-builder --mac dmg zip "${ARGS[@]}" --publish never || exit 1

echo
echo "==> 完成，产物在 dist/"
ls -lh dist/*.dmg dist/*.zip 2>/dev/null
