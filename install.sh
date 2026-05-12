#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${CODEX_PROVIDER_MANAGER_REPO:-https://github.com/Saviour2411/codex-api-sync.git}"
INSTALL_DIR="${CODEX_PROVIDER_MANAGER_HOME:-$HOME/.codex-provider-manager}"
REQUIRED_NODE_MAJOR=20

info() {
  printf '[Codex Provider Manager] %s\n' "$1"
}

fail() {
  printf '[Codex Provider Manager] 错误：%s\n' "$1" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令 '$1'，请先安装后重试。"
}

need_cmd git
need_cmd node
need_cmd npm

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  fail "Node.js 版本需要 >= ${REQUIRED_NODE_MAJOR}，当前为 $(node -v)。"
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  info "更新 $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --depth 1 origin main
  git -C "$INSTALL_DIR" checkout main
  git -C "$INSTALL_DIR" reset --hard origin/main
elif [ -e "$INSTALL_DIR" ]; then
  fail "$INSTALL_DIR 已存在但不是 Git 仓库，请手动移走或设置 CODEX_PROVIDER_MANAGER_HOME。"
else
  info "克隆到 $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

info "安装依赖"
npm --prefix "$INSTALL_DIR" install

info "构建"
npm --prefix "$INSTALL_DIR" run build

info "链接命令 codex-api-sync"
npm --prefix "$INSTALL_DIR" link

info "安装完成"
printf '\n运行 Web 控制台：\n  codex-api-sync web\n\n'
printf '运行配置检查：\n  codex-api-sync doctor\n\n'
