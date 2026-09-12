#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

# 系统批准按签名识别后台服务，后续构建应继续使用同一证书。
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-$(security find-identity -v -p codesigning | awk '/"Apple Development:|"Developer ID Application:/{print $2; exit}')}"
: "${APPLE_SIGNING_IDENTITY:?钥匙串中没有可用的应用签名证书}"

# 保留优化，省去本机日用版本不需要的调试符号和增量缓存。
export CARGO_PROFILE_RELEASE_DEBUG=0
export CARGO_PROFILE_RELEASE_STRIP=symbols
export CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO=off
export CARGO_INCREMENTAL=0
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
export NODE_USE_ENV_PROXY=1
# 避免终端继承的 SDKROOT 与当前 Xcode 链接器版本不匹配。
export SDKROOT="$(env -u SDKROOT xcrun --sdk macosx --show-sdk-path)"

pnpm install --frozen-lockfile
pnpm prebuild --force
pnpm tauri build --bundles app -- --locked

app="target/release/bundle/macos/Clash Verge.app"
codesign --verify --deep --strict "$app"
printf '已构建并校验：%s/%s\n' "$PWD" "$app"
