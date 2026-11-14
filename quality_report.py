#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
quality_report.py —— 打标质检报告生成器。

从 labels_glm4v.jsonl（逐条打标结果）+ pattern_inventory_574.csv（原 meaning_short）
统计并生成「质检报告.md」，包含：
    · 打标成功率、平均耗时
    · 生成文本平均字数、空值率、低置信度条数
    · 随机抽取 3 条「扩写前 meaning_short vs 扩写后 meaning_rich」对比样例

用法：
    /tmp/ragvenv/bin/python quality_report.py
"""
import os
import sys
import csv
import json
import random

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "labels_glm4v.jsonl")
INV = os.path.join(HERE, "pattern_inventory_574.csv")
REPORT = os.path.join(HERE, "质检报告.md")


def load_inventory():
    if not os.path.exists(INV):
        return {}
    with open(INV, encoding="utf-8-sig", newline="") as f:
        return {r["pattern_id"]: r for r in csv.DictReader(f)}


def load_records():
    if not os.path.exists(OUT):
        return []
    recs = []
    with open(OUT, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                recs.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return recs


def dedupe(recs):
    """按 pattern_id 去重：同一 id 优先保留成功记录。"""
    by_pid = {}
    for r in recs:
        pid = r.get("pattern_id")
        if not pid:
            continue
        if pid not in by_pid or (r.get("_ok") and not by_pid[pid].get("_ok")):
            by_pid[pid] = r
    return list(by_pid.values())


def main():
    if not os.path.exists(OUT):
        print("⚠️ 尚无打标数据 labels_glm4v.jsonl，请先运行 glm4v_batch_labeling.py。")
        return

    inv = load_inventory()
    recs = dedupe(load_records())
    total = len(recs)
    success = [r for r in recs if r.get("_ok")]
    failed = [r for r in recs if not r.get("_ok")]
    sr = (len(success) / total * 100) if total else 0.0

    rich_lens = [len((r.get("label") or {}).get("meaning_rich") or "") for r in success]
    craft_lens = [len((r.get("label") or {}).get("craft_desc") or "") for r in success]
    null_rich = sum(1 for x in rich_lens if x == 0)
    low_conf = sum(1 for r in success if (r.get("label") or {}).get("confidence") == "low")
    secs = [float(r.get("_secs") or 0) for r in success]
    avg_secs = (sum(secs) / len(secs)) if secs else 0.0

    # 随机抽 3 条样例（扩写前 vs 扩写后）
    pool = success[:]
    random.shuffle(pool)
    samples = []
    for r in pool[:3]:
        pid = r["pattern_id"]
        rich = (r.get("label") or {}).get("meaning_rich") or ""
        short = (inv.get(pid) or {}).get("meaning_short") or "（原库无 meaning_short）"
        samples.append((pid, short, rich))

    L = []
    L.append("# 纹样 GLM-4V 打标质检报告")
    L.append("")
    L.append(f"> 自动生成 · 去重后样本 {total} 条 · 成功 {len(success)} · 失败 {len(failed)}")
    L.append("")
    L.append("## 一、总体指标")
    L.append("")
    L.append(f"- 打标总数（去重）：**{total}**")
    L.append(f"- 成功：**{len(success)}** ｜ 失败：**{len(failed)}**")
    L.append(f"- **打标成功率：{sr:.1f}%**")
    L.append(f"- 平均单条耗时：**{avg_secs:.1f}s** ｜ 累计耗时：{sum(secs):.0f}s")
    if failed:
        L.append(f"- 失败样例（前 10）：`{', '.join(r.get('pattern_id', '?') for r in failed[:10])}`")
    L.append("")
    L.append("## 二、文本质量")
    L.append("")
    if rich_lens:
        L.append(f"- `meaning_rich` 字数：平均 **{sum(rich_lens)/len(rich_lens):.0f}** ｜ 最短 {min(rich_lens)} ｜ 最长 {max(rich_lens)}")
        L.append(f"- `craft_desc` 字数：平均 **{sum(craft_lens)/len(craft_lens):.0f}**")
        L.append(f"- **空值率（meaning_rich 为空）：{null_rich/len(success)*100:.1f}%**（{null_rich}/{len(success)}）")
    else:
        L.append("- （暂无成功样本，无法统计文本质量）")
    L.append(f"- 低置信度（confidence=low）：**{low_conf}** 条，建议人工复核")
    L.append("")
    L.append("## 三、随机抽检：扩写前 vs 扩写后")
    L.append("")
    if not samples:
        L.append("（暂无成功样本可展示）")
    for i, (pid, short, rich) in enumerate(samples, 1):
        L.append(f"### 样例 {i} · `{pid}`")
        L.append("")
        L.append(f"**扩写前 meaning_short**（{len(short)} 字）：")
        L.append(f"> {short}")
        L.append("")
        L.append(f"**扩写后 meaning_rich**（{len(rich)} 字）：")
        L.append(f"> {rich}")
        L.append("")
    L.append("---")
    L.append("生成命令：`/tmp/ragvenv/bin/python quality_report.py`")

    report = "\n".join(L)
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write(report + "\n")
    print(report)
    print(f"\n✅ 质检报告已写入：{REPORT}")


if __name__ == "__main__":
    main()
