#!/usr/bin/env bash
# 浏览器模式启动（不用桌面窗口时用这个）
# macOS / Linux 通用：按 当前虚拟环境 → python3 → python 的顺序找解释器，不写死本机路径
cd "$(dirname "$0")" || exit 1

PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -x ".venv/bin/python" ]; then PY=".venv/bin/python"
  elif command -v python3 >/dev/null 2>&1; then PY="python3"
  else PY="python"; fi
fi

exec "$PY" -m uvicorn backend.app:app --host 127.0.0.1 --port 8765
