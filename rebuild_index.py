#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
重建 ChromaDB 向量库（数据打标后的「最关键一步」）。

问题：glm4v_batch_labeling.py 的 merge 子命令会把 GLM-4V 扩写的
meaning_rich / craft_desc / color_palette 等写回 pattern_inventory_574.csv，
但 ChromaDB 里已经存的是「旧 chunk 文本 + 旧 embedding」。如果不重建，
新生成的文化寓意根本不会被检索到（向量还是老的）。

本脚本做两件事：
    1. （可选）调用打标合并流程，确保 CSV 已含最新 meaning_rich；
    2. 强制重建 ChromaDB 集合，用 embedding-3 重新向量化全部 574 条 chunk，
       并把新的 chunk 文本 + metadata 一并写回。

用法：
    python3 rebuild_index.py                 # 直接重建（假设 CSV 已是最新）
    python3 rebuild_index.py --auto-merge    # 先 merge 再重建（merge 在联网/有 key 时才有意义）
    python3 rebuild_index.py --csv 其他.csv  # 指定数据来源

注意：
    - 真实 embedding 需要 export ZHIPU_API_KEY=xxx；无 key 时降级为本地哈希向量，
      仅用于验证管线，不会得到真实语义召回。
    - 重建过程会删除旧的 chroma_db 目录后重写，耗时取决于 574 条 × embedding-3 网络往返
      （真实环境约 1–3 分钟，embedding-3 支持批量调用）。
"""
import argparse
import os
import sys
import logging

# 让脚本既能被 `python3 rebuild_index.py` 直接跑，也能被 main 引入
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zhipu_client as zhipu
import rag_search as rs

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("rebuild_index")


def _auto_merge():
    """调用 glm4v_batch_labeling 的 merge（需要同级模块与已打标 json 目录）。"""
    try:
        import glm4v_batch_labeling as gl
        gl.merge()
        logger.info("glm4v merge 完成，CSV 已含最新 meaning_rich")
    except Exception as e:
        logger.warning("auto-merge 失败（可能尚未打标或入口不同）：%s", e)


def main():
    ap = argparse.ArgumentParser(description="重建纹样 RAG 向量库")
    ap.add_argument("--auto-merge", action="store_true", help="重建前先执行 glm4v merge")
    ap.add_argument("--csv", default=rs.DEFAULT_CSV, help="数据来源 CSV")
    ap.add_argument("--persist", default=rs.DEFAULT_PERSIST, help="ChromaDB 持久化目录")
    args = ap.parse_args()

    logger.info("当前 embedding 模式: %s（real=embedding-3, mock=本地哈希）", zhipu.MODE)
    if zhipu.MODE != "real":
        logger.warning("未检测到 ZHIPU_API_KEY，将使用「本地哈希向量」重建——仅验证管线，"
                       "非真实语义召回。请 export ZHIPU_API_KEY=xxx 后再跑一次以得到真实索引。")

    if args.auto_merge:
        _auto_merge()

    # 清空旧索引并重建
    col = rs.get_collection(rebuild=True, persist_dir=args.persist, csv_path=args.csv)
    logger.info("重建完成 ✅  集合条数 = %d", col.count())
    logger.info("可运行 `python3 test_rag.py` 验证检索效果。")


if __name__ == "__main__":
    main()
