#!/usr/bin/env bash
# ============================================================================
# start.sh —— 纹以载道 RAG 后端「防呆」一键启动脚本
#   · 锁定 venv 的 python（/tmp/ragvenv/bin/python），绝不用系统 python3.11
#   · 启动前强制校验 MODE=real，Key 没生效直接报错退出（不静默降级）
#   · 端口 8000
# 用法：
#   chmod +x start.sh && ./start.sh
# ============================================================================
set -euo pipefail

# 无论在哪调用，都切到脚本所在目录（保证 .env / main.py 路径正确）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PY="/tmp/ragvenv/bin/python"

# —— 1) venv 存在性检查 ——
if [ ! -x "$PY" ]; then
  echo "❌ 找不到虚拟环境 python：$PY" >&2
  echo "   请先创建 venv 并装依赖：" >&2
  echo "   python3.11 -m venv /tmp/ragvenv" >&2
  echo "   /tmp/ragvenv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

# —— 2) 启动前校验 Key 是否真正接入（real 模式），否则直接报错退出 ——
echo "==> 校验智谱 Key 接入状态 ..."
"$PY" - <<'PYEOF'
import sys
import zhipu_client as z
if z.MODE != "real":
    print("❌ MODE =", z.MODE, "（不是 real，Key 未生效，已拒绝启动）")
    print("   请确认 backend/.env 中 ZHIPU_API_KEY 已填写且正确，")
    print("   且本脚本使用的是同一份 venv（/tmp/ragvenv）。")
    sys.exit(1)
print("✓ MODE = real，智谱 Key 已接入，准备启动 uvicorn ...")
PYEOF

# —— 3) 启动 uvicorn（端口 8000，支持热重载）——
echo "==> 启动后端：http://127.0.0.1:8000  （Ctrl+C 停止）"
exec "$PY" -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
