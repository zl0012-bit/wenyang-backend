#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Agent 确定性调度主函数。

run_agent(user_input, has_image, current_page, image_path=None)
    ├─ classify_intent → qa / comparison / redesign / other
    ├─ qa | comparison : rag_search 召回 → glm-4-flash 基于检索资料生成回答
    ├─ redesign         : 若有图 → 视觉工具链（extract_color + segment_pattern）→ 结构化 JSON
    │                     若无图 → 提示上传图片
    └─ other            : 通用对话（glm-4-flash / 离线兜底）

返回统一结构（与后端接口对齐）：
    {
      "intent": str, "confidence": float, "reason": str,
      "answer": str,
      "tool_results": {...},     # vision 或 rag 的中间产物
      "sources": [...]          # qa/comparison 的检索来源
    }
"""
import os
import re
import time
import logging

import zhipu_client as zhipu
import intent_router as ir
import rag_search as rs
import vision_tools as vt
import pattern_images as pi

logger = logging.getLogger("agent_router")

# 速度约束：所有创作/问答链路共用。限制篇幅能显著缩短流式总时长，
# 也让 max_tokens=500 永远不会被打满。结构化输出（色卡）走下方专用精简版。
BREVITY_RULE = (
    "【速度要求】请用最精简、直接的语言回答，不要废话、不要复述问题、不要客套、"
    "不要列举与问题无关的背景，控制在 260 字以内（以把问题真正讲清为准，宁可写满也不要半句收尾）。"
)

QA_SYS = (
    "你是「纹以载道」传统纹样数字博物馆的问答助手。"
    "优先依据下方【检索资料】作答；资料只是某几枚纹样的档案，讲不到用户问的制度、"
    "历史或分类时，请按公认的文物／历史常识把问题回答完整，不要因为资料没写就只说一半。"
    "严禁编造具体年代、作者或出土信息。用简洁、专业的中文回答。"
    + BREVITY_RULE
    + pi.IMG_TAG_RULE
)

# --------------------------------------------------------------------------- #
# 用户偏好风格 → System Prompt 注入（个人中心「偏好设置」联动）
# 前端保存偏好后，后续 /api/agent_chat 请求会携带 style 字段（如 "hantang"），
# 此处将其翻译为口吻/审美取向指令，拼接到各链路的 system prompt 末尾。
# --------------------------------------------------------------------------- #
STYLE_PROMPTS = {
    "shangzhou": (
        "\n【用户偏好】用户偏爱「商周威严」风格。回答请庄重古朴、言简意赅，"
        "举例优先引用青铜器纹样（饕餮纹、夔龙纹、云雷纹）与礼制意象。"
    ),
    "hantang": (
        "\n【用户偏好】用户偏爱「汉唐富丽」风格。回答请气象开阔、辞彩饱满，"
        "举例优先引用汉代云气纹、瓦当与唐代宝相花、团窠、卷草纹等富丽意象。"
    ),
    "songyuan": (
        "\n【用户偏好】用户偏爱「宋元雅致」风格。回答请清雅克制、注重意蕴，"
        "举例优先引用宋代瓷器纹样（青瓷、磁州窑）、文人花鸟与元代文人画意趣。"
    ),
    "mingqing": (
        "\n【用户偏好】用户偏爱「明清繁缛」风格。回答请细致铺陈、层次丰富，"
        "举例优先引用明清吉祥纹样（缠枝莲、龙凤呈祥、福寿纹）与宫廷工艺。"
    ),
}


def _style_prompt(style) -> str:
    """把前端传来的偏好风格值翻译成 system prompt 片段；未知/缺失返回空串。"""
    if not style:
        return ""
    return STYLE_PROMPTS.get(str(style).strip().lower(), "")


# --------------------------------------------------------------------------- #
# 回答合成（真实 LLM 优先，离线用检索资料拼接兜底）
# --------------------------------------------------------------------------- #
def _offline_answer(query: str, chunks: list) -> str:
    lines = [f"根据知识库检索，为你找到 {len(chunks)} 枚相关纹样："]
    for c in chunks:
        m = c["metadata"]
        lines.append(f"· {c['name']}（{m['origin_std']}｜{m['theme']}）— 相似度 {c['similarity_score']}")
    lines.append("\n（离线模式未接入大模型，以上为检索命中；配置 ZHIPU_API_KEY 后可生成自然语言解读。）")
    return "\n".join(lines)


def _format_history(history):
    """把前端传来的 [{role, content}] 历史整理成纯文本上下文（仅当前板块的独立历史）。"""
    if not history:
        return ""
    lines = []
    for m in history:
        role = "用户" if str(m.get("role")) == "user" else "助手"
        c = (m.get("content") or "").strip()
        if c:
            lines.append(f"{role}：{c}")
    return "\n".join(lines)


# 命中偏弱的两种处理方式（都不再向用户暴露任何过程话术）：
#   "admit"   —— 用户问的本身就是馆内没有的冷知识：先答通用常识，再补一句馆藏边界，语气自然。
#   "related" —— 用户想看/想聊纹样：给出最接近的馆藏纹样。
# 早期实现会在正文前硬拼一句"检索不精准"的说明，那句话会让整个对话
# 立刻显出机器味，已彻底移除。
_NO_MATCH_NOTE = {
    "admit": "\n\n（以上为通行史实概述；馆内暂无与此完全对应的纹样条目。）",
    "related": "\n\n（以上是最接近的几枚馆藏纹样，如想看更贴合的，可以换个说法再问。）",
}


def _synthesize_qa(query: str, chunks: list, mode: str | None = None, history_ctx: str = None,
                   style: str = None) -> str:
    """基于检索资料合成回答。

    参数 chunks 为空是允许的：冷知识类问题（例如"补子禽鸟按品级如何区分"）
    馆藏里根本没有对应条目，此时不应强行拿几条相似度 0.5 的边缘纹样硬凑，
    而是让模型按通行史实正常作答。
    """
    if chunks:
        ctx = "\n\n".join(
            f"【纹样 {c['name']}】朝代:{c['metadata']['origin_std']} 主题:{c['metadata']['theme']}\n{c['content']}"
            for c in chunks
        )
        user_q = (
            f"检索资料：\n{ctx}\n\n用户问题：{query}\n\n"
            "请优先用资料的客观信息（名称、朝代、寓意）作答；"
            "资料只是纹样档案，不必逐条复述，也不要评价资料本身够不够用。"
        )
    else:
        user_q = f"用户问题：{query}\n\n（馆内暂无高度相关的纹样条目，请按通行史实作答。）"

    if history_ctx:
        # 当前板块的多轮上文，仅作上下文参考，不参与检索打分
        user_q = f"【对话上文，仅作上下文参考】\n{history_ctx}\n\n" + user_q

    if zhipu.MODE == "real":
        sys_p = QA_SYS + _style_prompt(style)
        if mode == "admit":
            sys_p += ("\n本条提问在馆藏中没有专门条目，请直接按公认的文物/历史常识完整回答，"
                      "不要说明检索结果如何。")
        ans = zhipu.chat_text(sys_p, user_q)
        if ans:
            return ans
        return _offline_answer(query, chunks) if chunks else "这个问题我暂时没有把握回答，换个角度问问看？"
    return _offline_answer(query, chunks)


def _collect_best(trace: list, result: dict):
    """汇总全程所有 rag_search / reformulate 命中，挑出 top-1 分数最高的那次作为『最佳命中』。"""
    rag_traces = [t for t in trace
                  if t["tool"] in ("rag_search", "reformulate_query(auto)", "reformulate_query")
                  and isinstance(t.get("obs"), list) and t["obs"]]
    best_chunks, best_top = None, -1.0
    for t in rag_traces:
        obs = t["obs"]
        top = obs[0]["similarity_score"] if obs else -1.0
        if top > best_top:
            best_top, best_chunks = top, obs
    if not best_chunks:
        best_chunks = (result["tool_results"].get("rag") or {}).get("chunks", [])
    return best_chunks, best_top


def _synthesize_comparison(query: str, chunks: list, history_ctx: str = None, style: str = None) -> str:
    # comparison：把两端纹样都喂给模型对比，离线则列出来源
    return _synthesize_qa(query, chunks, history_ctx=history_ctx, style=style)


def _describe_vision(colors: dict, segs: dict) -> str:
    dom = colors.get("dominant")
    top = "、".join(f"{p['hex']}({int(p['ratio'] * 100)}%)" for p in colors.get("palette", [])[:3])
    return (
        f"已对该纹样完成视觉分析。主色调 {dom}，前 3 主色占比：{top}；"
        f"边缘连通域切分出 {segs.get('num_components', 0)} 个图层，"
        f"可用于分层再设计 / 配色提取。"
    )


# 纹样共创工作台：文创设计方案 System Prompt
# 工作台左侧「设计思路」栏需要一段可读的设计说明；不能只丢色号清单。
DESIGN_SYSTEM = (
    "你是「纹以载道」非遗纹样数字博物馆的文创设计总监。"
    "根据用户给出的文创需求（主题纹样 / 载体 / 风格倾向），用中文给出一段精炼的设计思路。"
    "必须覆盖四点：① 主体纹样与造型处理 ② 构图与布局方式 ③ 色彩方向（用中国传统色名，不要堆十六进制色号）"
    "④ 与载体的适配要点（材质、印刷/织造工艺限制）。"
    "控制在 80–140 字，一段话说完，不要分点编号、不要客套、不要输出色卡清单。"
)

# 故事剧场：纯文本创作，直接输出故事正文，不得交代检索过程
STORY_SYSTEM = (
    "你是「纹以载道」数字博物馆的故事编剧「纹宝」。"
    "用户给你一个纹样、技艺或主题，你就直接写一段短故事（微小说 / 叙事散文 / 绘本文案均可）。\n"
    "【开头】第一句必须是故事正文，从情节切入，例如："
    "「相传在远古时期，蝴蝶妈妈原是花神，因眷恋人间花期，久久不肯归位……」"
    "不要铺陈、不要引子、不要解释你要写什么。\n"
    "【严禁】不得出现任何开场白、说明、免责或过程性叙述，"
    "包括但不限于「以下是」「未找到」「匹配」「根据资料」「为您创作」「希望您喜欢」；"
    "不得提知识库、检索、相似度、参考纹样等任何内部机制；"
    "不得复述用户问题，不得输出标题、编号、分点或加粗标记。\n"
    "【内容】情节具体，有人物、有场景、有转折；自然融入纹样的名称与象征寓意；"
    "语言优美但不浮夸。全文 120–180 字，最多两段，写完即止。"
    "【时代感】神话与古代题材保持相应年代氛围，不要出现现代人物、现代器物或网络用语"
    "（如手机、设计师、程序员、打卡）。"
)

# 馆内标准中国传统色表：色名与 Hex 的唯一事实来源，Prompt 要求逐字照抄
CN_TRADITIONAL_COLORS = (
    ("黛蓝",   "#2B4B5C", "深沉暗蓝"),
    ("胭脂",   "#C34A4A", "古典暗红"),
    ("石绿",   "#4A6B53", "灰调绿"),
    ("琉璃黄", "#D4AF37", "暗金色"),
    ("牙白",   "#F2E6D8", "米白色"),
    ("青黛",   "#1A3550", "深蓝近墨"),
    ("胭脂红", "#9E2933", "正红偏暗"),
    ("赤金",   "#C9A227", "沉金"),
    ("竹青",   "#2F7D5B", "苍绿"),
    ("月白",   "#F6F3EC", "极浅米白"),
    ("绛红",   "#8B1A1A", "深绛红"),
    ("沉香",   "#6B4423", "褐棕"),
)
COLOR_TABLE_TEXT = "\n".join(
    "- {} {}（{}）".format(hexv, name, desc)
    for name, hexv, desc in CN_TRADITIONAL_COLORS
)
COLOR_NAME_BY_HEX = {h.upper(): n for n, h, _ in CN_TRADITIONAL_COLORS}
COLOR_HEX_SET = frozenset(COLOR_NAME_BY_HEX)

# 智能配色：纯文本配色创作 System Prompt（绝不要求图片 / 不混入"请上传纹样"逻辑）
# 精简版色卡：既满足「100 字内 / 快速」的诉求，又必须保留足量 #RRGGBB，
# 否则上一轮做的「📋 复制色卡 (Hex)」按钮会失去可提取的色值。
PALETTE_SYSTEM = (
    "你是「纹以载道」传统纹样数字博物馆的资深配色设计师。"
    "用户给出纹样主题与载体，请直接输出紧凑色卡，绝不要求用户上传图片。"
    "【硬性规则 · 最高优先级】当你生成配色方案时，必须使用真实的中国传统色名称"
    "（如：黛蓝、胭脂、石绿等），并且给出的 16 进制色号必须与该颜色的实际色相严格匹配，"
    "严禁胡编乱造色号。色名与色号只能从下方《馆内标准中国传统色表》中逐字照抄："
    "不得自造色名（尤其禁止「青瓷金」「青瓷紫」这类把主题词硬套到色名上的写法），"
    "不得改动色号任何一位十六进制数字，不得把 A 色名配到 B 色号上；表外色值一律禁止输出。\n"
    "《馆内标准中国传统色表》（仅准使用以下 12 色）：\n"
    + COLOR_TABLE_TEXT + "\n"
    "输出格式：只输出 2 套方案，每套一行，格式：方案名｜#RRGGBB 色名、#RRGGBB 色名、#RRGGBB 色名、#RRGGBB 色名、#RRGGBB 色名。"
    "方案名用简短中文（如「青花清供」「敦煌藻井」），不要写成色名。"
    "不要写搭配建议、不要客套、不要解释色名，控制在 150 字以内。"
)

# 智能配色「一键复制色卡」依赖回复文本中的 #RRGGBB。模型偶发漏格式 / 调用失败 /
# 离线模式时，回复可能一个色值都没有，导致前端按钮无从挂载。这里做确定性兜底：
# 不足 3 个色值时追加一组馆内标准中国传统色参考值，并明确标注为「补充参考」，
# 既不伪造模型结论，也保证色卡永远可用、可复制。
PALETTE_FALLBACK = (
    "\n\n【补充参考色卡 · 馆内标准中国传统色】\n"
    "- #2B4B5C（黛蓝）— 深沉暗蓝 / 主色\n"
    "- #C34A4A（胭脂）— 古典暗红 / 主色\n"
    "- #4A6B53（石绿）— 灰调绿 / 辅色\n"
    "- #D4AF37（琉璃黄）— 暗金色 / 点缀\n"
    "- #F2E6D8（牙白）— 米白色 / 留白\n"
    "以上色名与色号严格对应，可直接复制到设计软件中取用。"
)


def _ensure_palette_hex(answer: str) -> str:
    """保证智能配色回复至少含 3 个 6 位十六进制色值。"""
    text = answer or ""
    if len(re.findall(r"#[0-9a-fA-F]{6}\b", text)) >= 3:
        return text
    return text.rstrip() + PALETTE_FALLBACK


# --------------------------------------------------------------------------- #
# 主函数
# --------------------------------------------------------------------------- #
def run_agent(user_input: str, has_image: bool = False, current_page=None,
              image_path: str = None, history=None, style: str = None) -> dict:
    user_input = (user_input or "").strip()
    hist_ctx = _format_history(history)  # 当前板块独立上文（仅本板块，绝不串台）
    deadline = time.time() + 90  # 总时长上限（秒）：< 网关 100s 超时，杜绝 524
    intent = ir.classify_intent(user_input, has_image=has_image, current_page=current_page)
    intent_name = intent["intent"]

    result = {
        "intent": intent_name,
        "confidence": intent.get("confidence"),
        "reason": intent.get("reason"),
        "answer": "",
        "tool_results": {},
        "sources": [],
    }

    try:
        if time.time() > deadline:
            result["answer"] = "（请求处理超时，请简化问题或稍后重试。）"
            return result
        if intent_name in ("qa", "comparison"):
            chunks = rs.rag_search(user_input, top_k=2, use_rewrite=False)
            result["sources"] = [
                {
                    "pattern_id": c["pattern_id"],
                    "name": c["name"],
                    "theme": c["metadata"]["theme"],
                    "origin_std": c["metadata"]["origin_std"],
                    "category_group": c["metadata"]["category_group"],
                    "score": c["similarity_score"],
                }
                for c in chunks
            ]
            result["tool_results"]["rag"] = {
                "count": len(chunks),
                "top": result["sources"][:3],
            }

            # —— 带图 + 识别语义：视觉模型看图识别，RAG 结果作佐证 —— #
            if image_path and intent_name == "qa":
                rag_hint = "\n\n".join(
                    f"· {c['name']}（{c['metadata']['origin_std']}｜{c['metadata']['theme']}）：{c['content'][:120]}"
                    for c in chunks[:3]
                )
                sys_p = (
                    "你是「纹以载道」传统纹样博物馆的纹样识别专家。"
                    "请仔细观察图片中的纹样，回答用户的问题："
                    "1) 指出最可能的纹样类型/名称（如缠枝莲纹、云雷纹、宝相花纹等）；"
                    "2) 简述其构图特征与象征寓意；"
                    "3) 如能判断，说明其常见朝代/载体。"
                    "若图片模糊或无法确定，请如实说明并给出最接近的候选。"
                    "回答简洁、专业、面向博物馆访客。" + _style_prompt(style)
                )
                user_msg = (
                    f"用户问题：{user_input}\n\n"
                    f"【知识库中最接近的纹样候选，可作参考佐证，不确定时不要照搬】\n{rag_hint}\n\n"
                    f"请结合图片内容作答。"
                )
                vision_ans = zhipu.chat_vision(sys_p, user_msg, image_path)
                if vision_ans:
                    result["answer"] = vision_ans
                    result["tool_results"]["vision_identify"] = {"model": "glm-4v-flash"}
                    return result
                # 视觉模型失败（mock/网络）：退回普通检索问答，并附上视觉分析摘要
                colors = vt.extract_color(image_path)
                result["tool_results"]["vision"] = {"extract_color": colors}
                result["answer"] = _describe_vision(colors, {"num_components": 0}) + "\n\n" + \
                    _synthesize_qa(user_input, chunks, history_ctx=hist_ctx, style=style)
                return result

            result["answer"] = (
                _synthesize_comparison(user_input, chunks, history_ctx=hist_ctx, style=style)
                if intent_name == "comparison"
                else _synthesize_qa(user_input, chunks, history_ctx=hist_ctx, style=style)
            )

        elif intent_name == "story":
            # 故事剧场：纯文本创作，不校验图片、不走配色提取，直接生成叙事文本
            if zhipu.MODE == "real":
                story = zhipu.chat_text(STORY_SYSTEM + _style_prompt(style), user_input)
                if story:
                    result["answer"] = story
                else:
                    # 模型失败兜底：用 RAG 资料做知识性回答，绝不回退到"请上传图片"
                    result["answer"] = _synthesize_qa(user_input, chunks, history_ctx=hist_ctx, style=style)
            else:
                result["answer"] = (
                    "（故事创作：离线模式未接入大模型，以下为基于馆内资料的片段式叙述。）\n\n"
                    + _synthesize_qa(user_input, chunks, history_ctx=hist_ctx, style=style)
                )

        elif intent_name == "palette":
            # 智能配色：纯文本配色创作，不校验图片、不走配色提取，直接输出色卡方案
            if zhipu.MODE == "real":
                palette = zhipu.chat_text(PALETTE_SYSTEM + _style_prompt(style), user_input)
                if palette:
                    result["answer"] = palette
                else:
                    # 模型失败兜底：用 RAG 资料做知识性回答，绝不回退到"请上传图片"
                    result["answer"] = _synthesize_qa(user_input, [], history_ctx=hist_ctx, style=style)
            else:
                result["answer"] = (
                    "（配色创作：离线模式未接入大模型，无法生成色卡方案。请配置 API Key 后重试。）"
                )
            # 无论模型成功 / 失败 / 离线，都保证回复含可提取的色值
            result["answer"] = _ensure_palette_hex(result["answer"])

        elif intent_name == "redesign":
            if not image_path:
                result["answer"] = (
                    "已识别为「纹样再设计」需求。请上传一张纹样图片，"
                    "我将自动提取主色板并做图层切分，返回结构化结果。"
                )
            else:
                colors = vt.extract_color(image_path)
                segs = vt.segment_pattern(image_path)
                result["tool_results"]["vision"] = {
                    "extract_color": colors,
                    "segment_pattern": segs,
                }
                result["answer"] = _describe_vision(colors, segs)

        else:  # other
            if zhipu.MODE == "real":
                result["answer"] = zhipu.chat_text(
                    "你是博物馆的智能助手，负责轻松自然地回应访客。" + _style_prompt(style),
                    user_input,
                ) or "（暂无法生成回答）"
            else:
                result["answer"] = (
                    "（通用对话：离线模式未接入大模型，已识别为 other 意图。）"
                )
    except Exception as e:
        logger.exception("run_agent 执行异常")
        result["answer"] = f"处理出错：{e}"
        result["error"] = str(e)

    return result


# --------------------------------------------------------------------------- #
# 纹样识别流式生成器（专为 /api/vision_identify 的 SSE 打字机效果服务）
#
# 链路：先对用户输入做 RAG 检索 → 拼接成「文物专家」System Prompt（含知识库参考资料）
#      → 再调用 glm-4v-flash 视觉模型流式看图作答。逐块 yield 文本片段。
# --------------------------------------------------------------------------- #
def _image_to_base64(image_path: str) -> str | None:
    """把本地图片读成 JPEG base64（不含 data: 前缀），失败返回 None。"""
    try:
        import base64 as _b
        import io
        from PIL import Image
        im = Image.open(image_path).convert("RGB")
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=90)
        return _b.b64encode(buf.getvalue()).decode("utf-8")
    except Exception as e:
        logger.warning("纹样识别图片编码失败: %s", e)
        return None


async def identify_pattern_stream(user_input: str, image_path: str | None = None,
                                 image_data: str | None = None, style: str = None):
    """异步生成器：纹样识别流式回答。

    image_path / image_data 二选一提供图片；user_input 为用户提问文本。
    逐块 yield 文本片段，供 SSE 流式推送到前端。
    """
    query = (user_input or "请识别这张纹样图片并介绍").strip()

    # 1) RAG 检索：提取相关非遗/纹样知识作为佐证背景
    try:
        chunks = rs.rag_search(query, top_k=2, use_rewrite=False)
    except Exception as e:
        logger.warning("识别链路 RAG 检索失败: %s", e)
        chunks = []

    rag_ctx = "\n\n".join(
        f"【{c['name']}】朝代:{c['metadata']['origin_std']} 主题:{c['metadata']['theme']}\n{c['content'][:200]}"
        for c in chunks[:3]
    ) if chunks else "（知识库暂无可参考条目）"

    system = (
        "你是一个文物专家，请结合图片和以下参考资料回答问题：\n"
        f"{rag_ctx}\n\n"
        "回答要求：\n"
        "1) 先指出最可能的纹样名称/类型（如缠枝莲纹、云雷纹、宝相花纹等）；\n"
        "2) 简述其构图特征与象征寓意；\n"
        "3) 如能判断，说明常见朝代/载体。\n"
        "若图片模糊或无法确定，请如实说明并给出最接近的候选。"
        + _style_prompt(style)
    )

    # 2) 图片入参统一为 base64
    b64 = image_data if image_data else (_image_to_base64(image_path) if image_path else None)
    logger.info("[identify_pattern_stream] image_path=%r | b64长度=%s | 是否走视觉模型=%s",
                image_path, (len(b64) if b64 else 0), bool(b64))
    if not b64:
        yield "（未能读取到图片数据，无法识别。）"
        return

    # 3) 调 glm-4v-flash 流式识别
    async for delta in zhipu.chat_with_vision(query, image_data=b64, system=system):
        yield delta


# =========================================================================== #
# ReAct 自主决策链路（隔离新增，不替换上面的确定性 run_agent）
#
# 设计原则：
#  - 与 run_agent 完全独立，前端不传 mode=react 时绝不会走到这里；
#  - max_steps 上限防止模型无限循环；
#  - 检索最高相似度 < REFORMULATE_THRESHOLD(0.55) 时自动「换词重试」；
#  - 每轮思考/工具调用/观察都打印 [ReAct] 日志，方便联调观察多轮决策；
#  - 即便步数耗尽，也会抽取全程「最高分命中」强行合成回答，不再返回冰冷兜底。
# =========================================================================== #
REACT_SYS = (
    "你是「纹以载道」传统纹样数字博物馆的多步推理助手（ReAct 范式：Reasoning + Acting）。\n"
    "你可以通过调用工具来逐步收集信息，再给出最终回答。可用工具：\n"
    "  - rag_search：在纹样知识库中向量检索（适用于查找/了解/对比纹样）\n"
    "  - extract_color / segment_pattern：对纹样图片做视觉分析（需图片路径）\n"
    "  - reformulate_query：当检索结果不理想时，换一种表述重新检索\n"
    "决策规则：\n"
    "  1) 若信息已足够，直接以自然语言作答，不再调用工具；\n"
    "  2) 若需要更多信息，调用合适的工具；\n"
    "  3) 若一次检索命中不相关（相似度低），主动 reformulate_query 换词重试；\n"
    "  4) 严格依据检索到的资料作答，不编造资料之外的史实。\n"
    "回答要简洁、专业、面向博物馆访客。"
)

# 换词重试触发阈值：RAG 命中最高相似度低于此值即认为检索不理想。
# 已由 0.65 下调到 0.55：多数"宽泛/古老"类问题在 0.55~0.65 区间其实已有可用命中，
# 过早换词反而容易把模型带进 reformulate 死循环。
REFORMULATE_THRESHOLD = 0.55

# 资料可用性阈值：全程最佳命中高于此值才算"馆藏里确实有讲得清的资料"，
# 才把纹样档案塞进 Context；低于此值按冷知识处理（直接按常识答，不硬凑边缘纹样）。
RAG_STRONG_THRESHOLD = 0.62
# SOFTEN_PREFIX 已移除：任何「未找到/不精准」之类的过程话术都不再进入用户可见的回答。

# —— ReAct 工具 Schema（OpenAI 风格，与 VISION_TOOLS 合并）——
RAG_SEARCH_SCHEMA = {
    "type": "function",
    "function": {
        "name": "rag_search",
        "description": "在 574 枚传统纹样知识库中做向量检索，返回最相关的若干纹样"
                       "（含名称、朝代、主题、文化寓意与相似度）。适用于查找/了解/对比某类纹样。",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索关键词或问题，例如 '明清 红色 牡丹纹'"},
                "dynasty_filter": {"type": "string", "description": "可选『单一』朝代过滤，如 '汉'/'唐'/'宋'/'魏晋'（只填一个，不要组合成 '唐宋明清' 这类多朝代串，否则可能无结果）；不填则不限"},
                "theme_filter": {"type": "string", "description": "可选主题过滤，如 'mingqing'/'明清·繁缛红'，不填则不限"},
            },
            "required": ["query"],
        },
    },
}
REFORMULATE_SCHEMA = {
    "type": "function",
    "function": {
        "name": "reformulate_query",
        "description": "当上一次检索结果不理想（相似度偏低、命中不相关）时，换一种表述/角度重新提问以再次检索。",
        "parameters": {
            "type": "object",
            "properties": {
                "new_query": {"type": "string", "description": "改写后的检索词，保留朝代/主题/纹样名等实体"},
            },
            "required": ["new_query"],
        },
    },
}
REACT_TOOLS = [RAG_SEARCH_SCHEMA, REFORMULATE_SCHEMA] + vt.VISION_TOOLS


def _obs_to_text(obs) -> str:
    """把一个工具观测结果序列化为可回填给模型的短文本。"""
    if isinstance(obs, list):  # rag_search 返回 chunk 列表
        if not obs:
            return "（检索无结果）"
        lines = []
        for i, c in enumerate(obs[:5], 1):
            m = c["metadata"]
            lines.append(f"[{i}] {c['name']}（{m['origin_std']}｜{m['theme']}）score={c['similarity_score']}：{c['content'][:120]}")
        return "\n".join(lines)
    return str(obs)[:300]


def _reformulate_query(query: str, trace: list) -> str:
    """LLM 改写检索词：基于已有不理想检索，产出更精准的关键词串。

    关键优化：当用户强调「古老 / 不要近现代 / 古代」时，强制让大模型在改写结果里
    显式补上具体朝代实体（汉、魏晋、唐、宋、元），而不是干巴巴地换同义词，
    否则"古老"二字的向量语义太发散，容易检索到明清反而偏离用户本意。
    """
    obs_text = "\n".join(f"- {o['tool']}({o.get('args')}) -> {o.get('summary', '')[:120]}" for o in trace[-3:])

    era_hint = ""
    if re.search(r"古老|古代|不要近现代|非近现代|不是近现代|传统|古典|很久以前", query):
        era_hint = (
            "用户明确强调要「古老 / 非近现代」的纹样，请在改写时强制加入具体朝代实体词"
            "（如 汉、魏晋、魏晋南北朝、唐、宋、元），优先选用更靠前的朝代，"
            "并尽量保留「吉祥/寓意/纹样」等主题词，以提升检索精准度。"
        )
        logger.info("[ReAct] 重写注入朝代限定：检测到'古老/非近现代'，强制携带汉/唐/宋/魏晋等实体词")

    sys_p = ("你是检索词改写器。基于已有检索结果的不佳表现，给出更精准的检索关键词串，"
             "务必保留朝代、主题、纹样名等实体词。"
             + era_hint +
             "只输出改写后的文本，不要解释。")
    new_q = zhipu.chat_text(sys_p, f"原问题：{query}\n已有检索：\n{obs_text}\n请给出更精准的检索词：")
    return (new_q or "").strip() or query


def _execute_react_tool(name, args, image_path, result):
    """执行单个工具调用，并把关键产物写回 result['tool_results']。返回观测结果（回填给模型）。"""
    args = args or {}
    if name == "rag_search":
        chunks = rs.rag_search(
            args.get("query", ""),
            dynasty_filter=args.get("dynasty_filter"),
            theme_filter=args.get("theme_filter"),
            top_k=2,
            use_rewrite=False,
        )
        result["tool_results"]["rag"] = {"count": len(chunks), "query": args.get("query", ""), "chunks": chunks}
        result["sources"] = [
            {
                "pattern_id": c["pattern_id"], "name": c["name"], "theme": c["metadata"]["theme"],
                "origin_std": c["metadata"]["origin_std"], "category_group": c["metadata"]["category_group"],
                "score": c["similarity_score"],
            } for c in chunks
        ]
        return chunks

    if name in ("extract_color", "segment_pattern"):
        p = args.get("image_path") or image_path
        if p and os.path.exists(p):
            r = getattr(vt, name)(p)
            result["tool_results"].setdefault("vision", {})[name] = r
            return r
        return {"error": "no image available"}

    if name == "reformulate_query":
        # reformulate_query 必须以新 query 真实重新检索，否则模型会反复调用却拿不到新结果
        new_q = args.get("new_query") or user_input
        logger.info("[ReAct] 执行 reformulate_query 工具：以 %r 重新检索", new_q)
        chunks = rs.rag_search(new_q, top_k=2, use_rewrite=False)
        result["tool_results"]["rag"] = {
            "count": len(chunks), "query": new_q, "chunks": chunks, "reformulated": True
        }
        result["sources"] = [
            {"pattern_id": c["pattern_id"], "name": c["name"], "theme": c["metadata"]["theme"],
             "origin_std": c["metadata"]["origin_std"], "category_group": c["metadata"]["category_group"],
             "score": c["similarity_score"]} for c in chunks
        ]
        return {"reformulated_to": new_q, "retrieved": _obs_to_text(chunks)}

    return {"error": f"unknown tool: {name}"}


def run_agent_react(user_input: str, has_image: bool = False, current_page=None,
                    image_path: str = None, max_steps: int = 3, history=None,
                    style: str = None) -> dict:
    """ReAct 多轮自主决策链路（与 run_agent 隔离，互不影响）。

    参数
    ----
    max_steps : 最大决策步数（默认 3，防无限循环）。
    history   : 当前板块独立多轮上文（仅本板块，绝不串台）。
    style     : 用户偏好风格（个人中心「偏好设置」联动，注入 System Prompt）。
    """
    logger.info("[ReAct] 启动：问题=%r | has_image=%s | max_steps=%s", user_input, has_image, max_steps)
    user_input = (user_input or "").strip()
    deadline = time.time() + 90  # 总时长上限（秒）：< 网关 100s 超时，杜绝 524
    hist_ctx = _format_history(history)  # 当前板块独立上文
    result = {
        "intent": None, "confidence": None, "reason": None,
        "answer": "", "tool_results": {"react_trace": []}, "sources": [], "mode": "react",
    }

    # 离线 mock：无 LLM 驱动，直接确定性检索兜底，避免空转
    if zhipu.MODE != "real":
        logger.warning("[ReAct] 离线 mock 模式：跳过 LLM 多轮决策，直接确定性检索兜底")
        chunks = rs.rag_search(user_input, top_k=2, use_rewrite=False)
        result["tool_results"]["rag"] = {"count": len(chunks), "query": user_input, "chunks": chunks}
        result["sources"] = [
            {"pattern_id": c["pattern_id"], "name": c["name"], "theme": c["metadata"]["theme"],
             "origin_std": c["metadata"]["origin_std"], "category_group": c["metadata"]["category_group"],
             "score": c["similarity_score"]} for c in chunks
        ]
        result["answer"] = _offline_answer(user_input, chunks)
        return result

    intent = ir.classify_intent(user_input, has_image=has_image, current_page=current_page)
    result["intent"] = intent["intent"]
    result["confidence"] = intent.get("confidence")
    result["reason"] = intent.get("reason")

    # 创作类意图（故事 / 配色 / 再设计）不进检索链路。
    # 根因：ReAct 循环会先 rag_search，命中分低时走 _collect_best + _synthesize_qa(soften=True)，
    # 把模型写好的故事整段覆盖成一句过程说明 + 一段资料复述（实测穿帮）。
    # 创作不需要佐证资料，这里直接转交确定性创作链路。
    if intent["intent"] in ("story", "palette", "redesign") and not has_image:
        logger.info("[ReAct] 创作类意图(%s)，跳过检索与相似度兜底，转交创作链路", intent["intent"])
        return run_agent(user_input, has_image=False, current_page=current_page,
                         history=history, style=style)

    # 带图 + 识别/鉴赏提问：转交确定性链路（视觉模型看图识别，ReAct 工具集无视觉对话能力）
    if has_image and intent["intent"] in ("qa", "comparison"):
        logger.info("[ReAct] 带图识别类提问（intent=%s），转交 run_agent 视觉识别链路", intent["intent"])
        return run_agent(user_input, has_image=True, current_page=current_page,
                         image_path=image_path, history=history, style=style)

    trace = result["tool_results"]["react_trace"]
    reformulated = False

    for step in range(1, max_steps + 1):
        if time.time() > deadline:
            logger.warning("[ReAct] 已达总时长上限(90s)，提前结束并走兜底合成，避免网关超时")
            break
        obs_block = "\n".join(f"第{o['step']}步 工具={o['tool']} 结果=\n{o.get('summary', '')}" for o in trace) or "（暂无）"
        user_msg = (
            f"用户问题：{user_input}\n"
            f"意图：{intent['intent']}\n"
            + (f"【对话上文，仅作上下文参考】\n{hist_ctx}\n\n" if hist_ctx else "")
            + f"已完成的工具调用与结果：\n{obs_block}\n\n"
            f"若已收集到足够信息，请只输出面向访客的最终回答"
            f"（不要复述本指令、不要出现『下一步』『直接作答』等元描述）；"
            f"若仍需信息，则调用合适的工具"
            f"（rag_search / extract_color / segment_pattern / reformulate_query）。"
            + (f"\n注意：待分析图片的本地路径为 {image_path}" if image_path else "")
        )
        logger.info("[ReAct] 第 %d/%d 步：思考中…", step, max_steps)
        decision = zhipu.chat_tools(REACT_SYS + _style_prompt(style), user_msg, tools=REACT_TOOLS, temperature=0.2)
        content = decision.get("content")
        tool_calls = decision.get("tool_calls") or []

        if not tool_calls:
            logger.info("[ReAct] 第 %d 步：模型决定结束，产出最终回答", step)
            if content:
                # 模型已给出最终回答，直接采用，不再用资料重合成覆盖
                result["answer"] = content
            break

        for tc in tool_calls:
            name, args = tc["name"], tc.get("arguments", {})
            logger.info("[ReAct] 第 %d 步：调用工具 %s(%s)", step, name, args)
            obs = _execute_react_tool(name, args, image_path, result)
            summary = _obs_to_text(obs)
            logger.info("[ReAct] 观察：%s -> %s", name, summary[:160].replace("\n", " "))
            trace.append({"step": step, "tool": name, "args": args, "obs": obs, "summary": summary})

            # ★ 换词重试触发逻辑：RAG 命中最高相似度 < 阈值，且尚未 reformulate
            if name == "rag_search" and isinstance(obs, list) and obs and not reformulated:
                top_score = obs[0]["similarity_score"]
                if top_score < REFORMULATE_THRESHOLD:
                    logger.info("[ReAct] 换词重试：top_score=%.3f < %.2f，触发 reformulate", top_score, REFORMULATE_THRESHOLD)
                    new_q = _reformulate_query(user_input, trace) or user_input
                    logger.info("[ReAct] 换词重试：%r -> %r", user_input, new_q)
                    chunks2 = rs.rag_search(new_q, top_k=2, use_rewrite=False)
                    result["tool_results"]["rag"] = {"count": len(chunks2), "query": new_q, "chunks": chunks2, "reformulated": True}
                    result["sources"] = [
                        {"pattern_id": c["pattern_id"], "name": c["name"], "theme": c["metadata"]["theme"],
                         "origin_std": c["metadata"]["origin_std"], "category_group": c["metadata"]["category_group"],
                         "score": c["similarity_score"]} for c in chunks2
                    ]
                    summary2 = _obs_to_text(chunks2)
                    trace.append({"step": step, "tool": "reformulate_query(auto)", "args": {"new_query": new_q},
                                  "obs": chunks2, "summary": summary2})
                    reformulated = True

    # 兜底：走到 max_steps 仍无最终回答 → 抽取全程「最高分命中」强行合成，不再返回冰冷提示
    if not result["answer"]:
        best_chunks, best_top = _collect_best(trace, result)

        if best_chunks:
            logger.info("[ReAct] 步数耗尽兜底：采用全程最高分命中 top=%.3f，强制合成回答", best_top)
            result["tool_results"]["rag"] = {
                "count": len(best_chunks),
                "query": (result["tool_results"].get("rag") or {}).get("query", user_input),
                "chunks": best_chunks, "fallback_used": True,
            }
            result["sources"] = [
                {"pattern_id": c["pattern_id"], "name": c["name"], "theme": c["metadata"]["theme"],
                 "origin_std": c["metadata"]["origin_std"], "category_group": c["metadata"]["category_group"],
                 "score": c["similarity_score"]} for c in best_chunks
            ]
            ans = _synthesize_qa(user_input, best_chunks, style=style)
            result["answer"] = ans or _offline_answer(user_input, best_chunks)
        else:
            logger.warning("[ReAct] 步数耗尽且全程无检索命中，返回离线兜底")
            result["answer"] = "（暂未检索到相关纹样，请换个说法或补充图片后重试。）"

    return result


if __name__ == "__main__":
    import json

    print("--- qa ---")
    print(json.dumps(run_agent("帮我找找明清的红色纹样", False, "纹样宝库"), ensure_ascii=False, indent=2))
    print("--- comparison ---")
    print(json.dumps(run_agent("对比明清和宋代的龙凤纹", False, "朝代长廊"), ensure_ascii=False, indent=2))
    print("--- redesign (no image) ---")
    print(json.dumps(run_agent("用这张图帮我生成现代海报", True, "AI共创"), ensure_ascii=False, indent=2))
    print("--- redesign (with image) ---")
    print(json.dumps(run_agent("分析这张纹样的配色", True, "AI共创", "A01.webp"), ensure_ascii=False, indent=2)[:1200])
