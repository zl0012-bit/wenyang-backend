#!/usr/bin/env bash
# ============================================================================
# run_labeling_pipeline.sh —— 全量打标 → merge → 重建索引 → 质检报告（一键流水线）
#   · 锁定 venv 的 python（/tmp/ragvenv/bin/python），避免系统 python3.11
#   · 启动前校验 MODE=real，Key 没接入直接终止
#   · 全程日志写入 labeling_pipeline.log（同时输出到终端）
#
# 用法（在另一终端查看进度）：
#   nohup bash run_labeling_pipeline.sh > labeling_pipeline.log 2>&1 &
#   tail -f labeling_pipeline.log
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PY="/tmp/ragvenv/bin/python"
LOG="labeling_pipeline.log"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# —— 0) venv 与 Key 校验 ——
if [ ! -x "$PY" ]; then
  echo "❌ 找不到虚拟环境 python：$PY" >&2
  exit 1
fi

echo "[$(ts)] 校验智谱 Key 接入状态 ..."
if ! "$PY" - <<'PYEOF'
import sys, zhipu_client as z
if z.MODE != "real":
    print("MODE =", z.MODE, "（Key 未生效，终止流水线）"); sys.exit(1)
print("✓ MODE = real，Key 已接入")
PYEOF
then
  echo "❌ Key 校验失败，流水线已终止。" | tee -a "$LOG"
  exit 1
fi

# —— ① 全量打标（574 条，断点续跑）——
echo "==================================================" | tee -a "$LOG"
echo "[$(ts)] ① 开始全量打标（断点续跑）" | tee -a "$LOG"
"$PY" glm4v_batch_labeling.py 2>&1 | tee -a "$LOG"
echo "[$(ts)] ① 打标阶段结束" | tee -a "$LOG"

# —— ② merge 进盘点清单 ——
echo "[$(ts)] ② merge 合并进 pattern_inventory_574.csv" | tee -a "$LOG"
"$PY" glm4v_batch_labeling.py merge 2>&1 | tee -a "$LOG"

# —— ③ 重建向量库（真实 embedding-3）——
echo "[$(ts)] ③ 重建向量库（rebuild_index.py，真实 embedding-3）" | tee -a "$LOG"
"$PY" rebuild_index.py 2>&1 | tee -a "$LOG"

# —— ④ 生成质检报告 ——
echo "[$(ts)] ④ 生成质检报告" | tee -a "$LOG"
"$PY" quality_report.py 2>&1 | tee -a "$LOG"

echo "==================================================" | tee -a "$LOG"
echo "[$(ts)] ✅ 全部完成。质检报告见：质检报告.md" | tee -a "$LOG"
