#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
最小 RAG 检索模块（基于 574 枚纹样数据）。

检索管线：
    Query Rewrite（查询重写，glm-4-flash）
        → ChromaDB 向量召回 2×top_k（带 metadata 过滤）
        → MMR 多样性重排序
        → 返回带 similarity_score 的结果列表

文本模板（对齐《数据清洗规范》中的 RAG chunk 结构）：
    【名称 + 分类 + 朝代(origin_std) + 主题(theme) + 工艺 + 文化寓意(扩写优先/短句兜底) + 形态 + 构图 + 视觉母题】

依赖：chromadb（向量库）、zhipu_client（embedding-3 + glm-4-flash）。
"""
import os
import csv
import logging

import numpy as np
import chromadb

import zhipu_client as zhipu

logger = logging.getLogger("rag_search")

# 知识库数据位于项目根目录的 03_非遗知识库数据，可用环境变量覆盖（便于独立部署）
_HERE = os.path.dirname(os.path.abspath(__file__))
_KB_BASE = os.environ.get("KB_DIR") or os.path.join(os.path.dirname(_HERE), "03_非遗知识库数据")
DEFAULT_CSV = os.path.join(_KB_BASE, "pattern_inventory_574.csv")
DEFAULT_PERSIST = os.path.join(_KB_BASE, "chroma_db")
COLLECTION_NAME = "wenyang_patterns"

# 四大主题：代码 -> 前端标签（与前端 He() 映射一致）
THEME_LABEL = {
    "shangzhou": "商周·青铜绿",
    "hantang": "汉唐·富丽金",
    "songyuan": "宋元·雅致青",
    "mingqing": "明清·繁缛红",
}

# 朝代过滤器别名 -> 归一化 origin_std 取值集合（命中即召回对应朝代）
DYN_ALIAS = {
    "商": ["商"],
    "西周": ["西周"], "周": ["周", "西周", "春秋", "战国", "春秋战国"],
    "春秋": ["春秋"], "战国": ["战国"], "春秋战国": ["春秋战国"],
    "秦": ["秦"], "汉": ["汉（泛指）", "西汉", "东汉", "秦汉（跨）"],
    "魏晋": ["魏晋"], "南北朝": ["南北朝", "北朝", "北魏", "北齐", "北周", "西魏"],
    "隋": ["隋"], "唐": ["唐", "隋唐（跨）"], "五代": ["五代"],
    "宋": ["宋"], "辽金": ["辽金西夏"], "元": ["元"], "宋元": ["宋元（跨）"],
    "明": ["明"], "清": ["清"], "明清": ["明清（跨）", "明", "清"],
    "新石器": ["新石器时代"], "近现代": ["近现代", "民间（历代）", "近现代（传世）"],
}


# --------------------------------------------------------------------------- #
# 数据加载与 chunk 构建
# --------------------------------------------------------------------------- #
def _split(val, seps=("；", ";", "、", ",")):
    if not val:
        return []
    for s in seps:
        val = val.replace(s, "|")
    return [x.strip() for x in val.split("|") if x.strip()]


def _parse_theme(raw):
    """'hantang（汉唐·富丽金）' -> 'hantang'（纯代码，与前端一致）。"""
    if not raw:
        return ""
    code = raw.split("（")[0].strip()
    return code if code in THEME_LABEL else raw.strip()


def load_inventory(csv_path: str = DEFAULT_CSV):
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            yield row


def build_chunk(row: dict):
    """由一行盘点数据构造 (chunk_id, content, metadata)。"""
    pid = (row.get("pattern_id") or "").strip()
    name = (row.get("name") or "").strip()
    cat_group = (row.get("category_group") or "").strip()
    origin_std = (row.get("origin_std") or "").strip()
    theme = _parse_theme(row.get("dynasty_theme"))
    era_group = (row.get("era_group") or "").strip()
    ethnic = (row.get("ethnic") or "").strip()
    crafts = _split(row.get("crafts"))
    meaning = (row.get("meaning_rich") or "").strip() or (row.get("meaning_short") or "").strip()
    craft_desc = (row.get("craft_desc") or "").strip()
    morphology = (row.get("morphology") or "").strip()
    composition = (row.get("composition") or "").strip()
    motifs = _split(row.get("visual_motifs"))
    refs = (row.get("refs_verified") or row.get("refs_suggested") or "").strip()
    image_url = (row.get("image_url") or "").strip() or f"/patterns/{pid}.webp"

    lines = [
        f"名称：{name}",
        f"分类：{cat_group}",
        f"朝代：{origin_std}",
        f"主题：{THEME_LABEL.get(theme, theme)}",
        f"工艺：{'、'.join(crafts)}" if crafts else "",
        f"文化寓意：{meaning}",
        f"工艺载体：{craft_desc}" if craft_desc else "",
        f"形态：{morphology}" if morphology else "",
        f"构图：{composition}" if composition else "",
        f"视觉母题：{'、'.join(motifs)}" if motifs else "",
        f"参考：{refs}" if refs else "",
    ]
    content = "\n".join([x for x in lines if x])
    cid = row.get("chunk_id") or f"pattern::{pid}"
    metadata = {
        "name": name,
        "origin_std": origin_std,
        "theme": theme,
        "era_group": era_group,
        "category_group": cat_group,
        "ethnic": ethnic,
        "crafts": crafts,
        "image_url": image_url,
    }
    return cid, content, metadata


# --------------------------------------------------------------------------- #
# 集合构建 / 获取
# --------------------------------------------------------------------------- #
def get_collection(rebuild: bool = False, persist_dir: str = DEFAULT_PERSIST,
                   csv_path: str = DEFAULT_CSV):
    client = chromadb.PersistentClient(path=persist_dir)
    # 向量后端切换（mock <-> real）时旧库不可用，必须重建，否则带 Key 复跑会命中离线向量
    try:
        existing = client.get_collection(COLLECTION_NAME)
        if not rebuild and existing.metadata.get("embed_mode") != zhipu.MODE:
            rebuild = True
    except Exception:
        pass
    if rebuild:
        try:
            client.delete_collection(COLLECTION_NAME)
        except Exception:
            pass
    col = client.get_or_create_collection(
        COLLECTION_NAME,
        metadata={"hnsw:space": "cosine", "embed_mode": zhipu.MODE},
    )
    if col.count() == 0:
        ids, docs, metas = [], [], []
        for row in load_inventory(csv_path):
            cid, content, meta = build_chunk(row)
            if not cid or not content:
                continue
            ids.append(cid)
            docs.append(content)
            metas.append(meta)
        embs = zhipu.embed(docs)
        # 分批写入，避免一次性请求过大
        step = 256
        for i in range(0, len(ids), step):
            col.add(
                ids=ids[i:i + step],
                documents=docs[i:i + step],
                embeddings=embs[i:i + step],
                metadatas=metas[i:i + step],
            )
        logger.info("已构建集合：%d 条纹样 chunk", col.count())
    return col


# --------------------------------------------------------------------------- #
# 过滤器规范化
# --------------------------------------------------------------------------- #
def normalize_dynasty(d) -> list:
    """dynasty_filter：支持字符串(友好别名/原始值/组合串) 或 list。返回 origin_std 取值列表。

    健壮性要点（演示级刚需）：大模型常会拼出 '唐宋明清' 这类组合串，或 '汉唐' 等非规范别名。
      · 命中 DYN_ALIAS 整词 → 直接展开；
      · 未命中整词 → 对串内逐个识别已知朝代关键字并展开（'唐宋明清' → 唐+宋+明+清+明清）；
      · 既不是已知别名、又拆不出任何已知朝代的 → 直接丢弃，绝不拿它当 origin_std 精确匹配。
        否则会匹配不到任何条目、把整次检索淘空（正是 C1 偶发『检索无结果』翻车的根因）。
    """
    if d is None:
        return []
    if isinstance(d, str):
        d = [d]
    known_vals = sum(DYN_ALIAS.values(), [])  # 所有真实 origin_std 取值
    out = []
    for raw in d:
        tok = (raw or "").strip()
        if not tok:
            continue
        if tok in DYN_ALIAS:
            out.extend(DYN_ALIAS[tok])
            continue
        # 组合 / 非规范串：在已知别名表里逐个子串匹配
        matched = False
        for alias, vals in DYN_ALIAS.items():
            if alias and alias in tok:
                out.extend(vals)
                matched = True
        if matched:
            continue
        # 兜底：短串且能命中某个真实 origin_std 取值（如 '东汉'）才保留，否则丢弃
        if len(tok) <= 3 and any(tok in v for v in known_vals):
            out.append(tok)
    # 去重保序
    seen, uniq = set(), []
    for x in out:
        if x not in seen:
            seen.add(x)
            uniq.append(x)
    return uniq


def normalize_theme(t) -> str:
    """theme_filter：支持代码(mingqing) / 标签(明清·繁缛红) / 关键词(明清)。"""
    if not t:
        return ""
    t = str(t).strip()
    if t in THEME_LABEL:
        return t
    for code in THEME_LABEL:          # 代码子串命中
        if code in t:
            return code
    for code, label in THEME_LABEL.items():
        if label in t or ("·" in label and any(p in t for p in label.split("·"))):
            return code
    return t


def build_where(dynasty_filter=None, theme_filter=None) -> dict:
    """构造 ChromaDB where 条件。

    注意：ChromaDB 不允许顶层同时出现「$in 操作符字段」与「等值字段」，
    多条件一律用 $and 包裹，避免 'Expected where to have exactly one operator'。
    """
    conds = []
    if dynasty_filter is not None:
        vals = normalize_dynasty(dynasty_filter)
        if vals:
            conds.append({"origin_std": vals[0] if len(vals) == 1 else {"$in": vals}})
    if theme_filter is not None:
        t = normalize_theme(theme_filter)
        if t:
            conds.append({"theme": t})
    if not conds:
        return {}
    if len(conds) == 1:
        return conds[0]
    return {"$and": conds}


# --------------------------------------------------------------------------- #
# Query Rewrite
# --------------------------------------------------------------------------- #
_REWRITE_SYS = (
    "你是「纹以载道」纹样知识库的查询优化器。"
    "请把用户的口语问题改写成适合向量检索的简洁关键词串，"
    "务必保留朝代、主题、工艺、色彩、纹样名等实体词，去掉问候语和废话。"
    "只输出改写后的文本，不要解释，不要加引号。"
)


def rewrite_query(query: str) -> str:
    if zhipu.MODE == "real":
        out = zhipu.chat_text(_REWRITE_SYS, query)
        if out:
            return out.strip()
    # 离线：原样透传（规则已足够支撑冒烟测试）
    return query


# --------------------------------------------------------------------------- #
# MMR 多样性重排
# --------------------------------------------------------------------------- #
def _cosine(a, b):
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    return 0.0 if denom == 0 else float(np.dot(a, b) / denom)


def mmr_rerank(query_emb, cand_embs, k: int, lambda_: float = 0.6):
    """最大边际相关：在相关性与多样性间权衡，返回候选索引的有序列表。"""
    n = len(cand_embs)
    k = min(k, n)
    if k == 0:
        return []
    sims = [_cosine(query_emb, e) for e in cand_embs]
    selected, remaining = [], list(range(n))
    while len(selected) < k and remaining:
        best_i, best_score = None, -1e9
        for i in remaining:
            max_sim = max([_cosine(cand_embs[i], cand_embs[s]) for s in selected], default=0.0)
            score = lambda_ * sims[i] - (1 - lambda_) * max_sim
            if score > best_score:
                best_score, best_i = score, i
        selected.append(best_i)
        remaining.remove(best_i)
    return selected


# --------------------------------------------------------------------------- #
# 对外检索函数
# --------------------------------------------------------------------------- #
def rag_search(query: str, dynasty_filter=None, theme_filter=None,
               top_k: int = 5, use_rewrite: bool = True,
               rebuild: bool = False, persist_dir: str = DEFAULT_PERSIST,
               csv_path: str = DEFAULT_CSV) -> list:
    """
    检索主函数。

    参数
    ----
    query          : 用户自然语言问题
    dynasty_filter : 朝代过滤，支持 '明清'/'明'/'唐' 等别名或 origin_std 列表
    theme_filter   : 主题过滤，支持 'mingqing'/'明清·繁缛红'/'明清' 等
    top_k          : 最终返回条数
    use_rewrite    : 是否先做 Query Rewrite
    rebuild        : 是否重建 ChromaDB 集合

    返回
    ----
    list[dict]，每项含 rank / pattern_id / name / content / metadata / similarity_score
    """
    col = get_collection(rebuild=rebuild, persist_dir=persist_dir, csv_path=csv_path)
    q = rewrite_query(query) if use_rewrite else query
    q_emb = zhipu.embed([q])[0]
    where = build_where(dynasty_filter, theme_filter)

    n_candidates = max(2 * top_k, top_k + 1)
    res = col.query(
        query_embeddings=[q_emb],
        n_results=n_candidates,
        where=where or None,
        include=["metadatas", "documents", "distances"],
    )
    ids = res["ids"][0]
    if not ids:
        return []

    docs = res["documents"][0]
    metas = res["metadatas"][0]
    dists = res["distances"][0]

    # 取候选向量做 MMR
    cand = col.get(ids=ids, include=["embeddings"])
    cand_embs = cand["embeddings"]
    order = mmr_rerank(q_emb, cand_embs, top_k, lambda_=0.6)

    results = []
    for rank, idx in enumerate(order, 1):
        sim = 1 - float(dists[idx])  # cosine distance -> similarity
        if zhipu.MODE != "real":
            # 索引由在线 embedding-3 构建，离线哈希向量与之不在同一空间，
            # 余弦值只剩 0.1~0.2 噪声，直接置 0 交给上层按"检索不可用"处理
            sim = 0.0
        meta = metas[idx]
        results.append({
            "rank": rank,
            "chunk_id": ids[idx],
            "pattern_id": ids[idx].replace("pattern::", ""),
            "name": meta.get("name", ""),
            "content": docs[idx],
            "metadata": meta,
            "similarity_score": round(sim, 4),
        })
    return results


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print("ZHIPU MODE =", zhipu.MODE)
    for q in ["明清的红色纹样", "苗族纹样特色", "缠枝莲寓意"]:
        print("\n=== query:", q, "===")
        for r in rag_search(q, top_k=3, rebuild=False):
            print(f"  [{r['rank']}] {r['name']} | {r['metadata']['theme']} "
                  f"| {r['metadata']['origin_std']} | score={r['similarity_score']}")
