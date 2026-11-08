#!/bin/sh
set -e

DATA_DIR="${VCALL_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

# 绑定挂载的宿主目录通常属于 root，启动时修正属主，
# 否则容器内 node 用户无法写入 settings.json（管理端保存设置会失败）
chown -R node:node "$DATA_DIR" 2>/dev/null || true

exec su-exec node "$@"
