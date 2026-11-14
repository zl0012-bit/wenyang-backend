#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI 多模态配图：解析模型输出的 [img:纹样名] 标签，站内检索对应纹样图片。

设计原则（不改动底层）：
  · 复用前端已有的 574 枚纹样静态图 /patterns/<ID>.webp 与
    frontend/admin/patterns-data.json 的 id/name 映射，不新建数据库、
    不引入 ChromaDB 依赖、不触碰现有 RAG 检索链路。
  · 主路径解析模型回复里的 [img:xxx] 标签；当模型漏标（或离线兜底文本）
    时，用站内纹样名词表 + 少量别名从用户问题/回答里兜底召回，
    保证「云纹和雷纹有什么区别」这类对比问法一定能带出图。
  · 返回结构：
      {"text": 去掉机器标签后的纯文本,
       "images": ["/patterns/G01.webp?v=...", ...],     # 用户约定的 URL 数组
       "patterns": [{"id","name","image","href","label"}, ...]}  # 与 images 同序，供前端跳转
"""
import json
import os
import re
import logging

logger = logging.getLogger("pattern_images")

# ── System Prompt 强指令（挂到所有生成回答的 system 末尾）────────────────────
IMG_TAG_RULE = (
    "\n\n【配图标签规则·必须遵守】当你提及某个具体纹样（如云纹、宝相花）时，"
    "请务必在回复的最后，提取出该纹样的名称，并严格按照格式输出图片标签，如：[img:云纹]。"
    "涉及多个纹样时每个都输出一个标签（如 [img:云纹][img:雷纹]）；"
    "标签只能放在正文结尾，不要解释标签含义，也不要把标签写进句子中间。"
)

IMG_TAG_RE = re.compile(r"\[img\s*:\s*([^\]\[]{1,24}?)\s*\]", re.IGNORECASE)

# 短名 → 站内主纹样 ID（数据里没有完全同名条目时的口语叫法）
ALIAS = {
    "雷纹": "G03",      # 站内名：云雷纹
    "云纹": "G01",
    "宝相花": "P01",
    "龙纹": "A01",
    "缠枝纹": "P02",    # 站内名：缠枝莲
    "云雷纹": "G03",
    "回纹": "G02",
    "夔龙纹": "B13",
    "莲花纹": "P04",
}

IMG_BASE = "/patterns/"
IMG_VER = "?v=20261019"

_DATA_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "frontend", "admin", "patterns-data.json"
)


def _load_index():
    """→ (by_id, norm_names)：by_id 用于别名解析，norm_names 用于词表扫描。"""
    by_id, norm_names = {}, []
    try:
        with open(_DATA_PATH, encoding="utf-8") as f:
            items = json.load(f)
        for it in items:
            pid, name = str(it.get("id") or "").strip(), str(it.get("name") or "").strip()
            if not pid or not name:
                continue
            by_id[pid] = name
            # 规范化：去掉括号补充说明，如「雷纹（蜡染）」→「雷纹」
            norm = re.sub(r"[（(].*?[）)]", "", name).strip()
            if norm:
                norm_names.append((norm, pid, name))
    except Exception as e:
        logger.warning("纹样索引加载失败（配图功能降级为空）: %s", e)
    return by_id, norm_names


BY_ID, NORM_NAMES = _load_index()
# 长名优先，避免「云纹」抢走「卷云纹」的匹配
NORM_NAMES.sort(key=lambda x: -len(x[0]))


def strip_tags(text: str) -> str:
    """把机器标签从展示文本里删除，避免气泡里露出 [img:云纹]。"""
    if not text:
        return ""
    clean = IMG_TAG_RE.sub("", text)
    # 标签后常跟空行，顺手收敛
    return re.sub(r"\n{3,}", "\n\n", clean).rstrip() + ("\n" if text.endswith("\n") else "")


def _resolve(pid: str, label: str = None):
    """ID → 一条可渲染的图卡数据；图片文件不存在时跳过，避免气泡里出现裂图。"""
    name = BY_ID.get(pid)
    if not name:
        return None
    img_file = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "frontend", "patterns", pid + ".webp"
    )
    if not os.path.exists(img_file):
        return None
    return {
        "id": pid,
        "name": name,
        "label": label or name,
        "image": IMG_BASE + pid + ".webp" + IMG_VER,
        "href": "/pattern/" + pid,
    }


def collect_names(answer: str, user_input: str, limit: int = 5):
    """从 [img:] 标签 + 站内词表 + 别名里召回纹样名（按相关性排序）。"""
    answer, user_input = answer or "", user_input or ""
    text = user_input + "\n" + answer

    tagged = [m.group(1).strip() for m in IMG_TAG_RE.finditer(answer)]
    names, seen_ids, seen_labels = [], set(), set()

    def push(pid, label=None):
        if len(names) >= limit or pid in seen_ids:
            return
        item = _resolve(pid, label)
        if item and item["label"] not in seen_labels:
            seen_ids.add(pid)
            seen_labels.add(item["label"])
            names.append(item)

    # 1) 模型明确标注的纹样优先
    for raw in tagged:
        key = raw.strip()
        pid = ALIAS.get(key)
        if not pid:
            hit = next((p for n, p, _ in NORM_NAMES if n == key), None)
            if not hit:
                hit = next((p for n, p, _ in NORM_NAMES if n in key or key in n), None)
        if pid:
            push(pid, key if key != BY_ID.get(pid) else None)

    # 2) 别名兜底（用户问题里出现但站内无完全同名条目，如「雷纹」→ 云雷纹）
    for alias, pid in ALIAS.items():
        if alias in text:
            push(pid, alias)

    # 3) 站内全名词表扫描（长名优先），只取确实出现在文本里的
    for norm, pid, full_name in NORM_NAMES:
        if len(names) >= limit:
            break
        if len(norm) >= 2 and norm in text:
            push(pid, norm if norm != full_name else None)

    # 按「用户问题里出现的先后」排列，让「云纹和雷纹」→ 云纹在前、雷纹在后
    # 注意：list.sort 执行期间会临时腾空原列表，key 里不能再访问 names 本身
    order = {id(it): i for i, it in enumerate(names)}

    def _pos(item):
        i = user_input.find(item["label"])
        return (i if i >= 0 else 9999, order.get(id(item), 9999))

    names.sort(key=_pos)
    return names


def build_payload(answer: str, user_input: str) -> dict:
    """→ {"text": 干净正文, "images": [url...], "patterns": [图卡...]}"""
    clean = strip_tags(answer)
    patterns = collect_names(answer, user_input)
    payload = {
        "text": clean,
        "images": [p["image"] for p in patterns],
        "patterns": patterns,
    }
    if patterns:
        logger.info("[pattern_images] 命中 %d 枚纹样：%s",
                    len(patterns), "/".join(p["name"] for p in patterns))
    return payload
