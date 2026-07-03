#!/usr/bin/env bash
# install.sh —— Claude Code 版「额度守卫」薄转发器(DEPRECATED 入口)
#
#   ./install.sh              安装(幂等,可重复跑)
#   ./install.sh --uninstall  卸载(脚本本体保留在 ~/.budget-guard)
#
# 真正的安装逻辑在 Node 版 bin/install-claude.mjs:部署 Node runtime
# (guard.mjs / probe.mjs / lib/)、幂等合并 ~/.claude/settings.json 的 hook、
# 写入 CLAUDE.md 协议块。本脚本只把参数原样透传过去,保留是为了 clone 后
# 仍能用老习惯 `./install.sh`。guard 核心已全部是 Node 实现,故需要 node >= 18。
#
# 运行期依赖 jq;安装/卸载需要 node >= 18。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "✗  需要 node >= 18(guard 核心已是 Node 实现);请先安装 node。" >&2
  echo "   安装器: $REPO_ROOT/bin/install-claude.mjs" >&2
  exit 1
fi

exec node "$REPO_ROOT/bin/install-claude.mjs" "$@"
