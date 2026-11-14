#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_retrieval_quality.py —— 打标 + 重建索引后，直观验证检索质量是否提升。

用法（务必用 venv 的 python）：
    /tmp/ragvenv/bin/python test_retrieval_quality.py
    /tmp/ragvenv/bin/python test_retrieval_quality.py "明清龙纹"
    /tmp/ragvenv/bin/python test_retrieval_quality.py "苗族蝴蝶纹" 8

它会：
  1) 校验 MODE=real（没接 Key 会直接提示）；
  2) 用 rag_search 检索你传入的纹样关键词；
  3) 对命中结果打印「原句 meaning_short」vs「GLM-4V 扩写 meaning_rich」，
     让你一眼看出扩写后的文化寓意质量是否提升。
"""
import os
import sys
import csv

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import zhipu_client as zhipu
import rag_search as rs

DEFAULT_CSV = rs.DEFAULT_CSV


def load_rows(csv_path=DEFAULT_CSV):
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        return {r["pattern_id"]: r for r in csv.DictReader(f)}


def extract_meaning_rich(content: str):
    """从 chunk content 中提取『文化寓意：...』那一行（即 meaning_rich）。"""
    for line in content.splitlines():
        if line.startswith("文化寓意："):
            return line[len("文化寓意："):].strip()
    return ""


def main():
    query = sys.argv[1] if len(sys.argv) > 1 else "明清龙纹"
    top_k = int(sys.argv[2]) if len(sys.argv) > 2 else 5

    if zhipu.MODE != "real":
        print("❌ MODE =", zhipu.MODE, "（real 才是真实 embedding-3，请先接入 Key）")
        sys.exit(1)
    print(f"✓ MODE = real，使用 embedding-3 真实向量检索\n")

    rows = load_rows()
    results = rs.rag_search(query, top_k=top_k)

    if not results:
        print(f"未检索到与『{query}』相关的纹样，可尝试更宽泛的关键词。")
        return

    print(f"===== 检索『{query}』Top {len(results)} 结果 =====\n")
    for r in results:
        pid = r["pattern_id"]
        print(f"#{r['rank']}  {r['name']}   (相似度 {r['similarity_score']})")
        row = rows.get(pid, {})

        short = (row.get("meaning_short") or "").strip()
        rich = extract_meaning_rich(r["content"]) or (row.get("meaning_rich") or "").strip()

        if short:
            print(f"   ├─ 扩写前 meaning_short ({len(short)} 字):")
            print(f"   │   {short}")
        if rich:
            print(f"   └─ 扩写后 meaning_rich ({len(rich)} 字):")
            # 按句换行，便于阅读
            for seg in [rich[i:i + 60] for i in range(0, len(rich), 60)]:
                print(f"       {seg}")
        else:
            print("   └─ （该纹样尚未打标，meaning_rich 为空，请先跑打标+merge+重建）")
        print()

    print("提示：若 meaning_rich 为空，说明还没打标或没重建索引，请先执行：")
    print("  /tmp/ragvenv/bin/python glm4v_batch_labeling.py          # 全量打标")
    print("  /tmp/ragvenv/bin/python glm4v_batch_labeling.py merge    # 合并进 CSV")
    print("  /tmp/ragvenv/bin/python rebuild_index.py                 # 用真实 embedding-3 重建")


if __name__ == "__main__":
    main()
