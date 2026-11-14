#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RAG 检索 + 意图分类 —— 冒烟测试脚本。

运行：
    python3 test_rag.py                 # 无 Key 也能跑（本地哈希向量 + 规则/启发式兜底）
    ZHIPU_API_KEY=xxx python3 test_rag.py   # 真实 embedding-3 + glm-4-flash

说明：未配置 Key 时，向量为离线哈希向量（语义近似靠词面重叠），仅用于验证管线正确性；
真实语义质量需配置 Key 后复跑。
"""
import os
import sys
import json

sys.path.insert(0, os.path.dirname(__file__))

import zhipu_client as zhipu
import rag_search as rs
import intent_router as ir


def show_results(query, results, limit=5):
    print(f"    命中 {len(results)} 条：")
    for r in results[:limit]:
        m = r["metadata"]
        print(f"      [{r['rank']}] {r['name']} | 主题={m['theme']} "
              f"| 朝代={m['origin_std']} | 分类={m['category_group']} "
              f"| 相似度={r['similarity_score']}")


def hr(title):
    print("\n" + "=" * 70)
    print(title)
    print("=" * 70)


def main():
    print(f"ZHIPU MODE = {zhipu.MODE}  "
          f"（{'真实 embedding-3 / glm-4-flash' if zhipu.MODE=='real' else '离线哈希向量 + 规则兜底'}）")

    # 首次构建集合（带 rebuild 保证数据最新；574 条量级很小）
    print("\n[初始化] 构建/加载 ChromaDB 集合 ...")
    rs.get_collection(rebuild=True)

    cases = [
        ("帮我找找明清的红色纹样", False, "纹样宝库"),
        ("苗族纹样有什么特色", False, "纹样宝库"),
        ("对比明清和宋代的龙凤纹", False, "朝代长廊"),
        ("缠枝莲的寓意和工艺介绍一下", False, "非遗技艺馆"),
        ("用这张图帮我生成现代海报", True, "AI共创"),
    ]

    hr("一、意图分类 + 检索（端到端）")
    for q, img, page in cases:
        intent = ir.classify_intent(q, has_image=img, current_page=page)
        print(f"\n▶ query: {q!r}  (has_image={img}, page={page})")
        print(f"  意图 → {intent['intent']}  (conf={intent['confidence']}, {intent['reason']})")

        # 检索：依据意图与页面做最简单的过滤器派生演示
        if intent["intent"] == "comparison":
            # 对比类：宽松检索，让 Agent 自己挑两端
            results = rs.rag_search(q, top_k=4)
        elif "明清" in q or "明" in q and "宋" not in q:
            # 演示带主题过滤：只取明清·繁缛红
            results = rs.rag_search(q, theme_filter="mingqing", top_k=4)
        else:
            results = rs.rag_search(q, top_k=4)
        show_results(q, results)

    hr("二、metadata 过滤器单独验证")
    # 1) 主题过滤：明清·繁缛红
    print("\n[主题过滤] theme=mingqing（明清·繁缛红）")
    res = rs.rag_search("有什么纹样推荐", theme_filter="mingqing", top_k=3)
    bad = [r for r in res if r["metadata"]["theme"] != "mingqing"]
    print(f"    返回 {len(res)} 条，主题越界 {len(bad)} 条 -> {'PASS' if not bad else 'FAIL'}")
    show_results("mingqing", res)

    # 2) 朝代过滤：唐
    print("\n[朝代过滤] dynasty=唐")
    res = rs.rag_search("盛唐纹样", dynasty_filter="唐", top_k=3)
    bad = [r for r in res if r["metadata"]["origin_std"] != "唐"]
    print(f"    返回 {len(res)} 条，朝代越界 {len(bad)} 条 -> {'PASS' if not bad else 'FAIL ('+str([r['metadata']['origin_std'] for r in bad])+')'}")
    show_results("唐", res)

    # 3) 复合过滤：明清主题 + 明清（跨）朝代
    print("\n[复合过滤] theme=mingqing & dynasty=明清")
    res = rs.rag_search("繁缛纹样", dynasty_filter="明清", theme_filter="mingqing", top_k=3)
    bad = [r for r in res if not (r["metadata"]["theme"] == "mingqing"
                                  and r["metadata"]["origin_std"] in ("明清（跨）", "明", "清"))]
    print(f"    返回 {len(res)} 条，越界 {len(bad)} 条 -> {'PASS' if not bad else 'FAIL'}")
    show_results("明清+mingqing", res)

    hr("三、跨查询稳定性（MMR 重排生效）")
    q = "适合做红包封面的吉祥纹样"
    a = rs.rag_search(q, top_k=5)
    b = rs.rag_search(q, top_k=5)
    same = [x["pattern_id"] for x in a] == [x["pattern_id"] for x in b]
    print(f"    同 query 两次结果一致 -> {'PASS' if same else 'FAIL'}")
    show_results(q, a)

    print("\n完成。")
    if zhipu.MODE != "real":
        print("\n提示：当前为离线模式，向量为哈希近似。配置 ZHIPU_API_KEY 后复跑可获得真实语义检索。")


if __name__ == "__main__":
    main()
