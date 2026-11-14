#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
意图分类模块（结合现有前端页面上下文）。

四类意图：
    qa         文博问答（介绍某纹样、问寓意/工艺/朝代）
    redesign   纹样再设计（AI 共创、生成图片、改稿）
    comparison 对比考据（两个及以上朝代/纹样名 + 对比词）
    story      纹样故事创作（故事剧场：写微小说 / 剧本 / 叙事）
    other      通用对话（闲聊、与纹样无关）

分类优先级：
    1) 前置规则拦截（确定性高、零延迟）
       - 当前页面=故事剧场（纯文本创作）         -> story
       - 带图片（AI共创页）            -> redesign
       - 含对比词 且 (≥2朝代 | ≥2纹样名 | 1朝代+1纹样名) -> comparison
    2) LLM 兜底：调用智谱 glm-4-flash（JSON 模式）做细粒度判定
    3) 无 Key 时的启发式兜底：保证永远有结果
"""
import os
import re
import csv
import logging

import zhipu_client as zhipu
from rag_search import DYN_ALIAS  # 复用朝代词表，避免重复维护

logger = logging.getLogger("intent_router")

DEFAULT_CSV = os.path.join(os.path.dirname(__file__), "pattern_inventory_574.csv")
INTENTS = ("qa", "redesign", "comparison", "story", "palette", "other")

# 对比触发词
CMP_KEYWORDS = ["区别", "对比", "比较", "差异", "异同", "不同", "分别", "pk", "PK", "比一比", "对照"]

# 再设计触发词（无图但语义明确时）
REDESIGN_KEYWORDS = ["再设计", "重新设计", "生成图", "画一张", "设计稿", "创作", "海报", "二创",
                     "变体", "改稿", "配色方案", "衍生", "文创", "logo", "LOGO"]

# 纹样识别/鉴赏语义（带图时优先于再设计判定：问"这是什么纹样"应识别而非配色）
ID_KEYWORDS = ["什么纹样", "什么图案", "什么花", "是什么纹", "识别", "辨认", "帮我认",
               "这是", "这是啥", "哪种纹", "哪类纹", "看看这", "认一认", "什么类型",
               "叫什么", "是什么意思", "寓意是什么", "出处是", "来自哪个朝代"]

# 文博问答触发词（含检索/推荐类，避免「帮我找找…」被误判为 other）
QA_KEYWORDS = ["寓意", "是什么", "介绍", "工艺", "朝代", "起源", "象征", "故事", "文化", "来历",
               "怎么读", "含义", "特点", "特色", "怎么形容", "找", "推荐", "哪些", "有哪些",
               "搜", "颜色", "红色", "蓝色", "绿色", "纹样库", "适合", "用在哪里"]

# 故事创作触发词（故事剧场：微小说 / 剧本 / 叙事类，纯文本生成，绝不要求图片）
STORY_KEYWORDS = ["微小说", "小说", "剧本", "脚本", "叙事", "编一个", "编一段", "讲一个故事",
                  "写一个故事", "写一段故事", "故事剧场", "故事化", "改编成故事", "绘本", "传说新编",
                  # 常见创作句式（"神话故事""写一段…故事"），覆盖与 QA 词表的"故事"冲突
                  "神话故事", "写一段", "写一个", "写一篇", "讲一个", "讲一段",
                  "传说", "民间故事", "寓言", "童话"]

# 配色创作触发词（智能配色：色卡 / 配色方案类，纯文本生成，绝不要求图片）
# 注意：必须先于 REDESIGN_KEYWORDS 检查（"配色方案"同时是再设计词，无图时优先判配色创作）
PALETTE_KEYWORDS = ["色卡", "配色", "色彩方案", "颜色搭配", "配色建议", "色板", "色系",
                    "5色", "五色", "一套色", "几套色", "风色卡", "国潮风",
                    # 「给我 5 个青花瓷风格的色号」这类说法不含「配色/色卡」字面，
                    # 曾导致 fast 路径误判为 other，模型自由发挥出 #FF69B4 荧光粉。
                    "色号", "配色方案", "取色", "调色", "主色", "辅色", "点缀色"]

# 「N 个色号 / 几组颜色」等数字变体：字面词表覆盖不到，用正则补一条。
PALETTE_PATTERNS = [
    re.compile(r"[0-9一二三四五六七八九十两几多]\s*(个|种|套|组|款)\s*(红|蓝|绿|青|紫|金|色)"),
    re.compile(r"(给我|来|出|推荐).{0,6}(色号|配色|色卡|颜色)"),
    re.compile(r"[几多][组套款种个].{0,4}(色|颜色)"),
]


def _is_palette(text: str) -> bool:
    """配色意图判定：字面关键词 + 数字变体正则，两条任一中即算。"""
    if any(k in text for k in PALETTE_KEYWORDS):
        return True
    return any(p.search(text) for p in PALETTE_PATTERNS)

# 朝代检测词（长词优先，避免「周」误命中「周期」等）
_DYN_WORDS = sorted(DYN_ALIAS.keys(), key=len, reverse=True)

# 页面语义（注入 prompt，帮助 LLM 判断）
PAGE_HINT = {
    "首页": "网站首页，用户通常在泛览或发起搜索",
    "纹样宝库": "纹样陈列/检索页，多为按朝代、主题、色彩的检索与问答",
    "朝代长廊": "按朝代浏览纹样，问题多与某朝代纹样特征相关",
    "非遗技艺馆": "非遗工艺科普页，问题多为工艺/技艺问答",
    "AI共创": "AI 创作页，用户上传图片做再设计/生成，带图必判 redesign",
    "故事剧场": "故事剧场页，用户请求写微小说/剧本/叙事等纹样故事，纯文本创作，不需要图片，应判 story",
    "智能配色": "智能配色页，用户请求生成色卡/配色方案（如为主题配 N 套 5 色方案），纯文本创作，不需要图片，无图时应判 palette",
}


# --------------------------------------------------------------------------- #
# 实体检测
# --------------------------------------------------------------------------- #
def _load_pattern_names(csv_path: str = DEFAULT_CSV):
    names = set()
    try:
        with open(csv_path, encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                if row.get("name"):
                    names.add(row["name"].strip())
    except Exception as e:
        logger.warning("加载纹样名失败: %s", e)
    return names


_PATTERN_NAMES = None


def _detect_dynasties(text: str):
    found = set()
    for w in _DYN_WORDS:
        if w in text:
            found.add(w)
    # 去重叠：剔除被更长命中词完全包含的短词（如 '明清' 命中后去掉 '明'/'清'）
    kept = []
    for w in sorted(found, key=len, reverse=True):
        if not any(w != k and w in k for k in kept):
            kept.append(w)
    return set(kept)


def _detect_patterns(text: str):
    global _PATTERN_NAMES
    if _PATTERN_NAMES is None:
        _PATTERN_NAMES = _load_pattern_names()
    return {n for n in _PATTERN_NAMES if n and n in text}


# --------------------------------------------------------------------------- #
# 规则拦截
# --------------------------------------------------------------------------- #
def _rule_check(text: str, has_image: bool, current_page: str | None = None):
    # 故事剧场页：纯文本创作请求，直接走故事生成链路（绝不要求图片，避免串台到再设计）
    if (current_page or "") == "故事剧场":
        return "story", 0.98, "当前页面为故事剧场，纯文本创作请求，走故事生成链路"
    # 纹样共创工作台：纯文本文创设计需求，走设计方案链路（不能因为句中出现
    # 「配色要热烈」这类描述词就被判成 palette，只返回一张色卡）
    if (current_page or "") == "纹样共创" and not has_image:
        return "redesign", 0.97, "当前页面为纹样共创工作台，纯文本文创设计需求，生成设计方案"
    # 智能配色页：纯文本配色/色卡创作请求，直接走配色设计链路（带图仍走识别/再设计提取）
    if (current_page or "") == "智能配色" and not has_image:
        return "palette", 0.98, "当前页面为智能配色，纯文本配色创作请求，直接生成色卡方案"
    if has_image:
        # 带图 + 识别/鉴赏语义 → 纹样识别问答（视觉模型看图作答），而非配色提取
        if any(k in text for k in ID_KEYWORDS):
            return "qa", 0.95, "带图且语义为纹样识别/鉴赏提问，走视觉识别问答链路"
        return "redesign", 1.0, "请求携带图片（AI共创/再设计场景），直接判定纹样再设计"

    # 故事创作语义关键词（纯文本，无图）
    if any(k in text for k in STORY_KEYWORDS):
        return "story", 0.95, "命中故事创作语义关键词"

    # 配色创作语义关键词（纯文本，无图）：先于再设计检查（"配色方案"是重叠词）
    if _is_palette(text):
        return "palette", 0.92, "命中配色/色卡创作语义关键词，纯文本直接生成配色方案"

    has_cmp = any(k in text for k in CMP_KEYWORDS)
    if has_cmp:
        dyn = _detect_dynasties(text)
        pat = _detect_patterns(text)
        if len(dyn) >= 2:
            return "comparison", 0.97, f"含对比词且出现 {len(dyn)} 个朝代（{', '.join(dyn)}）"
        if len(pat) >= 2:
            return "comparison", 0.97, f"含对比词且出现 {len(pat)} 个纹样名（{', '.join(pat)}）"
        if dyn and pat:
            return "comparison", 0.95, f"含对比词且同时出现朝代({', '.join(dyn)})与纹样名({', '.join(pat)})"

    # 纯再设计语义（无图也能判定）
    if any(k in text for k in REDESIGN_KEYWORDS):
        return "redesign", 0.9, "命中再设计语义关键词"

    return None


# --------------------------------------------------------------------------- #
# 启发式兜底（无 Key 时）
# --------------------------------------------------------------------------- #
def _heuristic(text: str):
    if any(k in text for k in STORY_KEYWORDS):
        return "story"
    if _is_palette(text):
        return "palette"
    if any(k in text for k in REDESIGN_KEYWORDS):
        return "redesign"
    if any(k in text for k in CMP_KEYWORDS):
        return "comparison"
    if any(k in text for k in QA_KEYWORDS):
        return "qa"
    return "other"


# --------------------------------------------------------------------------- #
# LLM 兜底
# --------------------------------------------------------------------------- #
_SYS = (
    "你是「纹以载道」传统纹样数字博物馆的意图分类器。"
    "请把用户 query 归入五类之一："
    "qa（文博问答，如介绍纹样、问寓意/工艺/朝代）、"
    "redesign（纹样再设计，如 AI 生成、改稿、做文创/海报，通常需要图片）、"
    "comparison（对比考据，如两个朝代或纹样的异同）、"
    "story（纹样故事创作，如写微小说/剧本/叙事，纯文本、不需要图片）、"
    "palette（配色/色卡创作，如为主题配 N 套 5 色方案、色彩搭配建议，纯文本、不需要图片）、"
    "other（通用闲聊或与纹样无关）。"
    "只输出 JSON，格式：{\"intent\":\"qa\",\"confidence\":0.9,\"reason\":\"...\"}。"
    "intent 必须是 qa/redesign/comparison/story/palette/other 之一，confidence 为 0~1 浮点数。"
)


def _llm_fallback(text: str, current_page: str | None):
    page_ctx = PAGE_HINT.get(current_page or "", "页面未知")
    user_msg = f"当前页面：{current_page or '未知'}（{page_ctx}）\n用户 query：{text}"
    out = zhipu.chat_json(_SYS, user_msg)
    if not out or out.get("intent") not in INTENTS:
        return None
    try:
        conf = float(out.get("confidence", 0.8))
    except Exception:
        conf = 0.8
    return {
        "intent": out["intent"],
        "confidence": round(conf, 2),
        "reason": str(out.get("reason", "")),
    }


# --------------------------------------------------------------------------- #
# 对外函数
# --------------------------------------------------------------------------- #
def classify_intent(user_input: str, has_image: bool = False,
                    current_page: str | None = None) -> dict:
    """
    参数
    ----
    user_input    : 用户输入文本
    has_image     : 是否携带图片（AI共创页上传）
    current_page  : 当前前端页面名（首页/纹样宝库/朝代长廊/非遗技艺馆/AI共创）

    返回
    ----
    {"intent": "qa"|"redesign"|"comparison"|"other",
     "confidence": float,
     "reason": str}
    """
    text = (user_input or "").strip()
    rule = _rule_check(text, has_image, current_page)
    if rule:
        return {"intent": rule[0], "confidence": rule[1], "reason": rule[2]}

    if zhipu.MODE == "real":
        res = _llm_fallback(text, current_page)
        if res:
            return res

    # 无 Key / LLM 失败：启发式兜底
    intent = _heuristic(text)
    return {
        "intent": intent,
        "confidence": 0.6,
        "reason": "无 API Key（或 LLM 调用失败），使用规则启发式兜底" if zhipu.MODE != "real"
                  else "LLM 返回不合法，回退启发式",
    }


def is_question(text: str) -> bool:
    """是否为「求解性提问」（问号 / 疑问词 / 请……）。

    用途：ReAct 模式下，纯文本问句不需要任何外部工具——工具集里只有 rag_search 与
    reformulate，拿它查「补子禽鸟按品级如何区分」这类制度常识只会捞回不相关的纹样档案，
    进而拖长 10 秒以上还答偏。判为问句后直接走流式快路径（0.6s 出首字）。
    """
    t = (text or "").strip()
    if not t:
        return False
    if "？" in t or "?" in t:
        return True
    # 对比类问句（"X 和 Y 有什么区别"）即使没写问号也按问句处理
    if any(k in t for k in CMP_KEYWORDS):
        return True
    return any(k in t for k in _Q_WORDS)


_Q_WORDS = ("为什么", "为何", "怎么", "怎样", "如何", "哪些", "哪个", "有什么", "是什么",
            "多少", "几种", "区别", "讲究", "含义", "寓意", "代表", "请问", "能否", "是否")


def classify_intent_fast(user_input: str, has_image: bool = False,
                         current_page: str | None = None) -> dict:
    """零 LLM 的极速意图判定，专供流式快路径使用。

    classify_intent() 在规则未命中时会额外发起一次 chat_json 模型调用，
    这一次往返直接推迟首字 1~3 秒。流式链路的意图只用于挑 System Prompt
    与决定要不要检索，规则 + 启发式的精度已足够，因此这里完全跳过 LLM。
    """
    text = (user_input or "").strip()
    rule = _rule_check(text, has_image, current_page)
    if rule:
        return {"intent": rule[0], "confidence": rule[1], "reason": rule[2]}
    return {
        "intent": _heuristic(text),
        "confidence": 0.6,
        "reason": "极速规则判定（跳过 LLM 意图分类，用于流式首字加速）",
    }


if __name__ == "__main__":
    samples = [
        ("帮我找找明清的红色纹样", False, "纹样宝库"),
        ("苗族纹样有什么特色", False, "纹样宝库"),
        ("对比明清和宋代的龙凤纹", False, "朝代长廊"),
        ("用这个纹样帮我生成一张现代海报", True, "AI共创"),
        ("缠枝莲的寓意和工艺介绍一下", False, "非遗技艺馆"),
        ("你好", False, "首页"),
    ]
    for q, img, page in samples:
        print(q, "->", classify_intent(q, img, page))
