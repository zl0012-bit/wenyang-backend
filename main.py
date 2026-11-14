#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FastAPI 后端：把前端请求「拦截」到后端统一调度。

接口：POST /api/agent_chat
    - 纯文本：Content-Type: application/json
        {"user_input": "...", "current_page": "纹样宝库", "has_image": false}
    - 带图片：Content-Type: multipart/form-data
        fields: user_input, current_page, image(文件)
    统一返回 JSON：
        {"intent","confidence","reason","answer","tool_results","sources"}

启动：uvicorn main:app --host 0.0.0.0 --port 8000 --reload
"""
import os
import json
import time
import asyncio
import shutil
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

# 后端启动即加载 .env（含 ZHIPU_API_KEY），必须早于任何业务/智谱客户端的导入
try:
    from dotenv import load_dotenv
    _env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    load_dotenv(_env_path)
except Exception:
    pass

import agent_router as ar
import zhipu_client as zc
import pattern_images as pi

logger = logging.getLogger("main")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# 日志同时落盘，便于远程环境排查
try:
    _LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "react_trace.log")
    _fh = logging.FileHandler(_LOG_FILE, encoding="utf-8")
    _fh.setLevel(logging.INFO)
    _fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
    _root = logging.getLogger()
    # 避免 uvicorn --reload 重复 import 时叠加多个相同 FileHandler
    if not any(isinstance(h, logging.FileHandler) and getattr(h, "baseFilename", "") == _fh.baseFilename
               for h in _root.handlers):
        _root.addHandler(_fh)
        logger.info("日志已同时写入 %s", _LOG_FILE)
except Exception as e:
    logger.warning("react_trace.log 文件处理器初始化失败：%s", e)


@asynccontextmanager
async def lifespan(app):
    from zhipu_client import MODE
    logger.info("智谱 Key 状态: %s（real=已接入智谱大模型，mock=离线兜底）", MODE)
    if MODE != "real":
        logger.warning("未检测到 ZHIPU_API_KEY：当前为离线 mock 模式，检索/视觉可用但自然语言回答为兜底文本。")

    # 预热 RAG：集合加载与 embedding 首次连接约 1.3s，放到后台避免首个请求承担
    async def _warm():
        try:
            await asyncio.to_thread(
                lambda: ar.rs.rag_search("云纹 吉祥寓意", top_k=2, use_rewrite=False)
            )
            logger.info("[warmup] RAG 集合与 embedding 已预热")
        except Exception as e:
            logger.warning("[warmup] 预热失败（不影响服务）: %s", e)

    asyncio.create_task(_warm())
    yield


app = FastAPI(title="纹以载道 · Agent 调度后端", version="0.1.0", lifespan=lifespan)

# 跨域：允许前端本地服务（Vite/Webpack 常用 5173、3000 等）访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # 生产可收紧为具体域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


@app.get("/health")
def health():
    return {"status": "ok"}


# --------------------------------------------------------------------------- #
# 极速流式快路径（/api/agent_chat 默认纯文本链路）
# --------------------------------------------------------------------------- #
FAST_RULE = (
    "【速度要求】请用最精简、直接的语言回答，不要废话、不要复述问题、不要客套，"
    "控制在 260 字以内（以把问题真正讲清为准，宁可写满也不要半句收尾）。"
)


# 资料可用性阈值：低于此分数视为「馆藏里没有真正对得上的条目」。
# 取 0.62 与 agent_router.RAG_STRONG_THRESHOLD 保持一致。
RAG_USABLE_THRESHOLD = 0.62


def _rag_usable(chunks) -> bool:
    """检索结果里是否至少有一条够格当参考资料。

    缘由：「清代官员补子上的禽鸟有什么讲究」这类常识问题，向量检索只能捞到
    相似度 0.5 左右的补子纹样档案。把这些边缘命中塞进 Prompt，模型就会绕开
    真正要回答的品级制度，改成复述"六品鹭鸶补的图案中心是一只白鹭…"——
    字数还被 100 字上限卡掉一半，正是用户看到的半句答案。
    """
    if not chunks:
        return False
    try:
        return max(float(c.get("similarity_score") or 0) for c in chunks) >= RAG_USABLE_THRESHOLD
    except Exception:
        return True


def _fast_system(intent: str, chunks: list, style: str | None = None) -> str:
    """按规则意图组装精简 System Prompt，供真流式 chat_stream 使用。

    刻意不注入 pi.IMG_TAG_RULE：模型若在末尾写 [img:xxx]，流式就需要尾部缓冲
    才能整体剥离，反而延迟首字。配图改由 META 首块基于用户问题预取。
    """
    if intent == "palette":
        sys_p = ar.PALETTE_SYSTEM                 # 精简色卡（保留 #RRGGBB）
    elif intent == "story":
        sys_p = ar.STORY_SYSTEM
    elif intent == "redesign":
        sys_p = ar.DESIGN_SYSTEM
    elif intent == "other":
        sys_p = "你是「纹以载道」数字博物馆的 AI 创作助手，用中文作答。" + FAST_RULE
    else:
        sys_p = (
            "你是「纹以载道」传统纹样数字博物馆的问答助手。"
            "优先依据馆内资料作答；资料讲不到用户问的制度、历史或分类时，"
            "按公认的文物／历史常识把问题回答完整，禁止编造具体年代与出处。" + FAST_RULE
        )
    if chunks:
        ctx = "\n".join(
            f"【{c.get('name', '')}】{(c.get('content') or '')[:160]}"
            for c in chunks[:2]
        )
        sys_p += "\n\n馆内资料（仅供参考）：\n" + ctx
    if style:
        try:
            sys_p += ar._style_prompt(style)
        except Exception:
            pass
    return sys_p


def _fast_history(history) -> str:
    """只带最近 2 轮、每轮截断 120 字，避免长提示词场景下 prompt 膨胀拖慢首字。"""
    try:
        recent = (history or [])[-2:]
        lines = []
        for m in recent:
            if not isinstance(m, dict):
                continue
            role = "用户" if m.get("role") == "user" else "助手"
            content = str(m.get("content") or "")[:120]
            if content:
                lines.append(f"{role}：{content}")
        return "【对话上文，仅供参考】\n" + "\n".join(lines) + "\n\n" if lines else ""
    except Exception:
        return ""


@app.post("/api/agent_chat")
async def agent_chat(request: Request):
    ctype = request.headers.get("content-type", "")
    _req_t0 = time.time()      # 全链路耗时起点（含检索），用于定位"为什么这次慢"

    user_input = ""
    current_page = None
    image_path = None
    has_image = False
    mode = "default"          # 仅当显式传入 mode=react 时才走 ReAct 链路
    tmp_files = []

    if "application/json" in ctype:
        # —— 纯文本 JSON 分支 ——
        try:
            data = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="JSON 解析失败")
        user_input = (data.get("user_input") or "").strip()
        current_page = data.get("current_page")
        has_image = bool(data.get("has_image", False))
        mode = str(data.get("mode", "default")).strip().lower()
        history = data.get("history") or []
        style = (data.get("style") or "").strip() or None   # 用户偏好风格（偏好设置联动）
    else:
        # —— FormData 分支（可含图片）——
        form = await request.form()
        user_input = (form.get("user_input") or "").strip()
        current_page = form.get("current_page")
        mode = str(form.get("mode") or "default").strip().lower()
        style = (str(form.get("style") or "").strip() or None)   # 用户偏好风格
        history_raw = form.get("history")
        history = json.loads(history_raw) if history_raw else []
        img = form.get("image")
        # UploadFile 对象且有文件名才视为有效图片
        if img is not None and getattr(img, "filename", ""):
            suffix = os.path.splitext(img.filename)[1] or ".png"
            path = os.path.join(UPLOAD_DIR, f"up_{os.getpid()}_{len(tmp_files)}{suffix}")
            with open(path, "wb") as f:
                f.write(await img.read())
            image_path = path
            tmp_files.append(path)
            has_image = True

    if not user_input and not image_path:
        raise HTTPException(status_code=400, detail="user_input 与 image 不能同时为空")

    # 极速流式快路径：默认纯文本（非 ReAct、无图）。
    # 原链路会先跑完整 run_agent（意图分类 LLM + Query Rewrite LLM + RAG +
    # 一次性 chat_text），全部结束后才 yield 第一个字节 → 前端长时间空白；
    # 随后再用 sleep(0.04) 每 3 字「假装打字机」，反而额外增加十几秒。
    fast_mode = (mode != "react" and not has_image)

    # 勾选「ReAct 多轮」时，创作类请求（故事 / 配色 / 再设计）仍走流式快路径：
    # ① 创作不需要工具检索，进 ReAct 只会等模型整轮跑完才吐第一块，且历史上会被
    #    一段"检索命中偏低"的过程话术覆盖（故事开头出现兜底说明）；
    # ② 快路径 0.6s 出首字，正好配「实时流式」标签做演示。
    if mode == "react" and not has_image:
        try:
            _pre_intent = (ar.ir.classify_intent_fast(user_input, False, current_page) or {}).get("intent")
        except Exception:
            _pre_intent = None
        if _pre_intent in ("story", "palette", "redesign"):
            logger.info("[API] ReAct 模式下创作类意图(%s)，改走流式快路径", _pre_intent)
            fast_mode = True
        elif _pre_intent in ("qa", "comparison", "other") and ar.ir.is_question(user_input):
            # 纯文本质询（"清代官员补子上的禽鸟有什么讲究？"）也不需要工具：
            # ReAct 只会 rag_search 一把捞回相似度 0.5 的补子档案，11 秒后给出
            # 一句被字数上限卡断的半句答案。直接走快路径，1 秒内讲清。
            logger.info("[API] ReAct 模式下的纯文本质询，改走流式快路径")
            fast_mode = True

    async def _gen():
        logger.info("[API] agent_chat 入口 mode=%s fast=%s 准备耗时=%.2fs page=%r input=%r",
                    mode, fast_mode, time.time() - _req_t0, current_page, (user_input or "")[:30])
        if fast_mode:
            t0 = time.time()
            # ① 纯规则意图判定：0 次 LLM 往返
            try:
                intent = (ar.ir.classify_intent_fast(
                    user_input, False, current_page) or {}).get("intent") or "qa"
            except Exception:
                intent = "qa"
            # 「问答知识库」是明确的知识问答板块：只要是在提问，就按问答处理。
            # 否则"清代官员补子上的禽鸟有什么讲究"会被 _heuristic 判成 other，
            # 既拿不到 QA 提示词、也不检索，答出来的内容全靠模型即兴发挥。
            if current_page == "问答知识库" and ar.ir.is_question(user_input) \
                    and intent in ("other", "qa"):
                intent = "qa"

            # ② 仅知识问答 / 对比需要检索；Top-2 + 关闭 Query Rewrite（省一次模型改写）
            chunks = []
            if intent in ("qa", "comparison"):
                try:
                    chunks = await asyncio.to_thread(
                        lambda: ar.rs.rag_search(user_input, top_k=2, use_rewrite=False)
                    )
                except Exception as e:
                    logger.warning("[fast] RAG 检索失败（忽略，继续纯模型回答）: %s", e)
            # 资料可用性闸门：补子这类问题只能捞到相似度 0.5 的纹样档案，
            # 硬塞进 Prompt 会把答案带偏成"复述六品鹭鸶补"，必须挡掉。
            if chunks and not _rag_usable(chunks):
                logger.info("[fast] 检索命中不足（最高 %.3f），不注入资料，按常识作答",
                            max(float(c.get("similarity_score") or 0) for c in chunks))
                chunks = []
            sources = []
            for c in (chunks or [])[:2]:
                md = c.get("metadata", {}) or {}
                sources.append({
                    "pattern_id": c.get("pattern_id"),
                    "name": c.get("name", ""),
                    "theme": md.get("theme"),
                    "origin_std": md.get("origin_std"),
                    "category_group": md.get("category_group"),
                    "score": c.get("similarity_score"),
                })

            # ③ 配图只凭用户问题预取 → META 可随首块下发，无需等模型回答
            try:
                pre = await asyncio.to_thread(pi.build_payload, "", user_input)
            except Exception:
                pre = {"images": [], "patterns": []}

            meta = {
                "intent": intent,
                "sources": sources,
                "tool_results": {"rag": {"count": len(chunks), "top": sources[:2]}} if chunks else {},
                "error": None,
                "images": pre.get("images", []),
                "patterns": pre.get("patterns", []),
                "fast": True,
            }
            # 首块：META。此后每个模型 delta 立即吐出，不做任何 sleep 攒批。
            yield "\u0000META\u0000" + json.dumps(meta, ensure_ascii=False, default=str) + "\n"
            logger.info("[fast] 首块 %.3fs | intent=%s | rag=%d | images=%d",
                        time.time() - t0, intent, len(chunks), len(pre.get("images", [])))

            # ④ 真流式：stream=True 逐块转发（chat_stream 是同步生成器，用线程取下一个）
            system = _fast_system(intent, chunks, style)
            user_msg = _fast_history(history) + user_input
            if intent == "palette":
                # 双重强调标准色表，杜绝模型自造「青瓷金 #FFD700」这类错配；
                # 同时低温提高确定性，避免自由发挥改色号。
                user_msg += "\n（只准使用《馆内标准中国传统色表》内的色名与色号，逐字照抄，不得自造。）"
            it = zc.chat_stream(system, user_msg,
                                temperature=0.1 if intent == "palette" else 0.4)
            first = True
            full_text = ""
            try:
                while True:
                    delta = await asyncio.to_thread(lambda: next(it, None))
                    if delta is None:
                        break
                    full_text += delta
                    if first:
                        first = False
                        logger.info("[fast] 首字 %.3fs", time.time() - t0)
                    yield delta
            finally:
                try:
                    it.close()
                except Exception:
                    pass
            # 快路径绕过了 run_agent，因此智能配色的色值兜底要在这里补一份：
            # 精简 Prompt 下模型偶发漏写 Hex 时，追加馆内标准国色，
            # 保证「📋 复制色卡 (Hex)」按钮依旧有可提取的色值。
            if intent == "palette":
                import re
                if len(re.findall(r"#[0-9a-fA-F]{6}\b", full_text)) < 3:
                    yield ar.PALETTE_FALLBACK
            for p in tmp_files:
                try:
                    os.remove(p)
                except OSError:
                    pass
            return

        # ── 原链路（ReAct / 带图）：保留完整能力，仅去掉人为 sleep 假打字机 ──
        result = None
        try:
            if mode == "react":
                logger.info("[API] mode=react，路由到 ReAct 自主决策链路")
                result = await asyncio.to_thread(
                    ar.run_agent_react,
                    user_input=user_input,
                    has_image=has_image,
                    current_page=current_page,
                    image_path=image_path,
                    history=history,
                    style=style,
                )
            else:
                result = await asyncio.to_thread(
                    ar.run_agent,
                    user_input=user_input,
                    has_image=has_image,
                    current_page=current_page,
                    image_path=image_path,
                    history=history,
                    style=style,
                )
        except Exception as e:
            logger.exception("[API] agent_chat 执行异常")
            err_meta = {"intent": "error", "sources": [], "tool_results": {}, "error": str(e)}
            yield "\u0000META\u0000" + json.dumps(err_meta, ensure_ascii=False, default=str) + "\n"
            yield "（处理出错，请稍后再试。）"
            return
        finally:
            for p in tmp_files:
                try:
                    os.remove(p)
                except OSError:
                    pass

        answer = result.get("answer") or ""
        rich = pi.build_payload(answer, user_input)
        meta = {
            "intent": result.get("intent"),
            "sources": result.get("sources", []) or [],
            "tool_results": result.get("tool_results", {}) or {},
            "error": result.get("error"),
            "images": rich["images"],
            "patterns": rich["patterns"],
        }
        yield "\u0000META\u0000" + json.dumps(meta, ensure_ascii=False, default=str) + "\n"
        clean = rich["text"]
        # 一次性生成的文本再人为 sleep 只会额外拉长等待：按大块尽快吐完
        for i in range(0, len(clean), 24):
            yield clean[i:i + 24]

    return StreamingResponse(
        _gen(),
        media_type="text/plain; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-store, no-transform, must-revalidate",
            "X-Accel-Buffering": "no",
        },
    )


# --------------------------------------------------------------------------- #
# 纹样识别专用接口（SSE 流式）：带图 + 识别语义 → glm-4v-flash 视觉模型流式作答
#
# 设计：
#   - 不再走纯文本 glm-4-flash，也不做 OpenCV/配色提取；
#   - 先 RAG 检索知识库，再把参考资料拼进 System Prompt 喂给 glm-4v-flash；
#   - 以 text/event-stream 逐块推送，前端可实现打字机效果。
# 入参（二选一）：
#   - multipart/form-data: user_input + image(文件)
#   - application/json:    {"user_input": "...", "image_data": "<base64>", "style": "hantang"}
# --------------------------------------------------------------------------- #
@app.post("/api/vision_identify")
async def vision_identify(request: Request):
    ctype = request.headers.get("content-type", "")
    user_input = ""
    image_path = None
    image_data = None
    style = None
    tmp_files = []

    if "application/json" in ctype:
        try:
            data = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="JSON 解析失败")
        user_input = (data.get("user_input") or "").strip()
        image_data = (data.get("image_data") or None)
        style = (data.get("style") or "").strip() or None
    else:
        form = await request.form()
        user_input = (form.get("user_input") or "").strip()
        style = (str(form.get("style") or "").strip() or None)
        img = form.get("image")
        # —— DEBUG：一读复用，避免重复 read 把文件读空（排查"未能读取到图片数据"）——
        _raw = None
        if img is not None:
            try:
                _raw = await img.read()
                logger.info("[vision_identify] ctype=multipart | img.filename=%r | 读取到字节数=%d",
                            getattr(img, "filename", None), len(_raw))
            except Exception as _e:
                logger.warning("[vision_identify] 读取上传图片调试信息失败: %s", _e)
        if img is not None and getattr(img, "filename", ""):
            suffix = os.path.splitext(img.filename)[1] or ".png"
            path = os.path.join(UPLOAD_DIR, f"vid_{os.getpid()}_{len(tmp_files)}{suffix}")
            with open(path, "wb") as f:
                f.write(_raw if _raw is not None else await img.read())
            tmp_files.append(path)
            # 临时文件在 finally 中删除，故先编码为内存 base64，
            # 使流式生成器不再依赖磁盘文件——否则 finally 会在流式开始前删掉文件，
            # 导致 identify_pattern_stream 读到时已不存在（报「未能读取到图片数据」）。
            if not image_data:
                try:
                    image_data = ar._image_to_base64(path)
                except Exception as _e:
                    logger.warning("[vision_identify] 上传图片编码为 base64 失败: %s", _e)
            image_path = None

    # —— DEBUG：打印最终解析出的图片参数长度 ——
    logger.info("[vision_identify] 解析结果 | image_data(base64)长度=%s | image_path=%r | user_input=%r",
                (len(image_data) if image_data else 0), image_path, user_input[:40])

    if not image_path and not image_data:
        raise HTTPException(status_code=400, detail="image 文件或 image_data(base64) 不能同时为空")

    try:
        return StreamingResponse(
            ar.identify_pattern_stream(user_input, image_path, image_data=image_data, style=style),
            media_type="text/plain; charset=utf-8",
            headers={
            "Cache-Control": "no-cache, no-store, no-transform, must-revalidate",
            "X-Accel-Buffering": "no",
        },
        )
    finally:
        for p in tmp_files:
            try:
                os.remove(p)
            except OSError:
                pass


@app.post("/api/guide_chat")
async def guide_chat(request: Request):
    """AI 导览悬浮窗（纹宝）专用：流式文本问答（text/plain 流，前端打字机渲染）。

    入参 JSON：{"user_input": "...", "current_page": "可选"}
    返回：流式文本（逐块输出 glm-4-flash 回答），前端 res.body.getReader() 消费。
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    user_input = str(body.get("user_input") or "").strip()
    if not user_input:
        raise HTTPException(status_code=400, detail="user_input 不能为空")

    # RAG 知识库佐证：检索馆内纹样资料作为 System Prompt 的一部分
    rag_ctx = ""
    try:
        _t_rag = time.time()
        chunks = ar.rs.rag_search(user_input, top_k=2, use_rewrite=False)
        logger.info("[guide_chat] 知识库检索 %.2fs（%d 条）", time.time() - _t_rag, len(chunks or []))
        if _rag_usable(chunks):
            lines = []
            for c in chunks[:2]:
                md = c.get("metadata", {}) or {}
                doc = (c.get("document") or "")[:400]
                lines.append(f"【{c.get('name','')}】（{md.get('theme','')}·{md.get('origin_std','')}）：{doc}")
            rag_ctx = "\n".join(lines)
        else:
            logger.info("[guide_chat] 检索命中不足（最高 %.3f），不注入资料，按常识作答",
                        max((float(c.get("similarity_score") or 0) for c in (chunks or [])), default=0))
    except Exception as e:
        logger.warning("guide_chat RAG 检索失败（忽略，继续纯模型回答）: %s", e)

    # 纯规则意图判定（0 次 LLM 往返，约 0.1ms）：让同一个导览入口也能正确回答
    # 「给我 5 个青花瓷色号」「写一段蝴蝶妈妈的神话故事」这类创作请求。
    # 不加这段时，配色/故事一律套用通用导览提示词，模型会自由发挥出
    # #FF69B4 荧光粉、#66CC66 浅绿这类完全不像青花瓷的色号。
    try:
        _intent = (ar.ir.classify_intent_fast(user_input, False, None) or {}).get("intent") or "qa"
    except Exception:
        _intent = "qa"

    if _intent == "palette":
        system = ar.PALETTE_SYSTEM
        user_payload = user_input + "\n（只准使用《馆内标准中国传统色表》内的色名与色号，逐字照抄，不得自造。）"
        temperature = 0.1
    elif _intent == "story":
        system = ar.STORY_SYSTEM
        user_payload = user_input
        temperature = 0.7
    else:
        system = (
            "你是「纹以载道」数字博物馆的 AI 导览员「纹宝」，一位非遗纹样专家。"
            "用专业、简短的中文回答纹样、技艺、历史问题；馆内资料相关时可引用，不相关时不要生搬硬套。"
            + FAST_RULE
            + pi.IMG_TAG_RULE
        )
        user_payload = user_input
        temperature = 0.5
    # 资料只喂给问答/对比类；且必须先判断资料是否真的够用 ——
    # 边缘命中（相似度 0.5 的纹样档案）会把常识类问题带偏成复述某枚纹样，故先判定可用性
    if _intent in ("qa", "comparison") and rag_ctx:
        system += "\n\n馆内参考资料：\n" + rag_ctx

    async def _gen():
        # chat_stream 是同步生成器，用线程取下一个避免阻塞事件循环。
        # 尾部缓冲只在检测到 '['（可能是 [img: 标签开头）时才保留 20 字，
        # 其余整块立刻吐出 —— 固定 64 字缓冲会把短回答整个扣住，首字被白白拖慢。
        import asyncio
        it = zc.chat_stream(system, user_payload, temperature=temperature)
        full, carry = "", ""
        TAIL = 20
        try:
            while True:
                try:
                    delta = await asyncio.to_thread(lambda: next(it, None))
                except StopIteration:
                    delta = None
                except Exception as e:
                    logger.warning("guide_chat 流式生成异常: %s", e)
                    carry = "（网络异常，请稍后再试。）"
                    break
                if delta is None:
                    break
                full += delta
                carry += delta
                hold = TAIL if "[" in carry else 0
                if len(carry) > hold:
                    cut = len(carry) - hold
                    emit, carry = carry[:cut], carry[cut:]
                    emit = pi.strip_tags(emit)
                    if emit:
                        yield emit
            tail = pi.strip_tags(carry)
            if tail:
                yield tail
            # 配色兜底：模型偶发无视标准色表（会输出荧光粉、浅绿等非国色），
            # 此处核对色值是否全部落在馆内 12 色内，越界则追加权威色卡，
            # 保证「一键复制色卡」拿到的永远是可用、可解释的中国传统色。
            if _intent == "palette":
                try:
                    import re as _re
                    _allowed = set(_re.findall(r"#[0-9A-Fa-f]{6}", ar.COLOR_TABLE_TEXT))
                    _allowed = {c.upper() for c in _allowed}
                    _got = {c.upper() for c in _re.findall(r"#[0-9A-Fa-f]{6}", full)}
                    if not _got or not _got.issubset(_allowed):
                        logger.info("[guide_chat] 配色越界 %s，追加标准色卡", sorted(_got - _allowed)[:5])
                        yield ar.PALETTE_FALLBACK
                        full += ar.PALETTE_FALLBACK
                except Exception as e:
                    logger.warning("[guide_chat] 配色校验异常: %s", e)
            # 生成结束后把图片数组与文本一起返回（前端 AiGallery 负责剥离该块）
            rich = pi.build_payload(full, user_input)
            yield "\u0000IMAGES\u0000" + json.dumps(rich, ensure_ascii=False) + "\n"
        finally:
            try:
                it.close()
            except Exception:
                pass

    logger.info("[guide_chat] user_input=%r | intent=%s | rag_ctx长度=%d", user_input[:40], _intent, len(rag_ctx))
    return StreamingResponse(
        _gen(),
        media_type="text/plain; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-store, no-transform, must-revalidate",
            "X-Accel-Buffering": "no",
        },
    )


# --------------------------------------------------------------------------- #
# 多模态问答（非流式）：AI 导览 / 问答知识库可直接拿 {text, images} 一次性渲染
# 复用 run_agent 的 RAG 检索 + GLM-4-Flash，与 /api/agent_chat 同源，不改底层
# 返回：{"text":"...","images":["url1","url2"],"patterns":[{id,name,image,href,label}],
#        "answer":"...", "intent","sources","tool_results"}
# --------------------------------------------------------------------------- #
@app.post("/api/agent_chat_json")
async def agent_chat_json(request: Request):
    """非流式多模态问答：文字与检索到的站内纹样图片一次返回。"""
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="JSON 解析失败")
    user_input = str(data.get("user_input") or "").strip()
    if not user_input:
        raise HTTPException(status_code=400, detail="user_input 不能为空")

    result = await asyncio.to_thread(
        ar.run_agent,
        user_input=user_input,
        has_image=False,
        current_page=data.get("current_page"),
        history=data.get("history") or [],
        style=(str(data.get("style") or "").strip() or None),
    )
    rich = pi.build_payload(result.get("answer") or "", user_input)
    logger.info("[agent_chat_json] user_input=%r | images=%d",
                user_input[:40], len(rich["images"]))
    return {
        "text": rich["text"],
        "answer": rich["text"],          # 兼容既有 renderBot(data.answer)
        "images": rich["images"],
        "patterns": rich["patterns"],
        "intent": result.get("intent"),
        "sources": result.get("sources", []) or [],
        "tool_results": result.get("tool_results", {}) or {},
        "error": result.get("error"),
    }


# --------------------------------------------------------------------------- #
# 文生图接口（智谱 CogView / GLM-Image 生态，复用 ZHIPU_API_KEY）
# --------------------------------------------------------------------------- #
@app.post("/api/generate_image")
async def generate_image_api(request: Request):
    """前端「纹样共创 / 文生图」调用：传入 prompt，返回真实图片 URL。

    入参 JSON：{"prompt": "青花瓷现代简约风云纹", "size": "1024x1024"(可选)}
    返回 JSON：{"url": "<图片URL>"} 或（失败兜底）{"url": null, "error": "..."}
    前端拿到 url 后直接放进 <img src> 替换占位图；url 为 null 时前端走占位图兜底。
    """
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="JSON 解析失败")
    prompt = (data.get("prompt") or "").strip()
    size = (data.get("size") or "1024x1024").strip() or "1024x1024"
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt 不能为空")

    url = zc.generate_image(prompt, size=size)
    if not url:
        # 真实生图失败（无 Key / 模型不可用 / 网络异常）：返回 200 + url=null，
        # 由前端走占位图兜底，绝不抛 500。
        logger.warning("[generate_image] prompt=%r | 生图返回空，前端走占位图兜底", prompt[:40])
        return {"url": None, "error": "image_generation_failed"}
    logger.info("[generate_image] prompt=%r | url=%s", prompt[:40], url[:80])
    return {"url": url}


# --------------------------------------------------------------------------- #
# 跨域图片同源代理：供「纹样共创 → 下载高清原图」使用
#   智谱 CogView 水印图 CDN 返回 Content-Disposition: attachment，但**不带**
#   Access-Control-Allow-Origin，浏览器直接 fetch 会被 CORS 拦截，无法转 Blob。
#   前端先尝试直连 fetch，失败即回落本端点（server.js 把 /api/* 转发到此处），
#   由服务端抓取图片二进制后原样返回，前端拿到的仍是同源响应，可正常转 Blob。
#   仅放行已知图片域名，避免被当作任意 URL 代理（SSRF）。
# --------------------------------------------------------------------------- #
_ALLOWED_IMAGE_HOSTS = (
    "ufileos.com", "cn-wlcb.ufileos.com", "bigmodel.cn",
    "zhipuai.cn", "aigc-files.bigmodel.cn",
)


@app.get("/api/image_proxy")
async def image_proxy(url: str = ""):
    import urllib.request
    from urllib.parse import urlparse
    from fastapi.responses import Response

    if not url:
        raise HTTPException(status_code=400, detail="缺少 url 参数")
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not any(
        host == h or host.endswith("." + h) for h in _ALLOWED_IMAGE_HOSTS
    ):
        raise HTTPException(status_code=400, detail="不允许的图片域名")

    def _grab():
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.read(), r.headers.get("Content-Type") or "image/png"

    try:
        data, ctype = await asyncio.to_thread(_grab)
    except Exception as e:
        logger.warning("[image_proxy] 抓取失败: %s | url=%s", e, url[:100])
        raise HTTPException(status_code=502, detail="图片抓取失败")
    return Response(content=data, media_type=ctype,
                    headers={"Cache-Control": "public, max-age=3600"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
