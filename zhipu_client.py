#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一智谱客户端：embedding-3（向量化）+ glm-4-flash（LLM）。

设计要点：
- 所有大模型调用统一走这里，Key 从环境变量 ZHIPU_API_KEY 读取。
- 未配置 Key 时自动进入「mock 模式」：
  * embed  → 基于字 bi-gram 的确定性哈希向量（本地、可复现），足以支撑离线冒烟测试；
  * chat   → 返回 None，由调用方走规则/启发式兜底。
- 真实模式与 mock 模式的对外接口完全一致，业务代码无需感知。
"""
import os
import re
import json
import hashlib
import logging
import numpy as np

logger = logging.getLogger("zhipu_client")

# —— 启动时从 .env 自动加载环境变量（含 ZHIPU_API_KEY）——
# 这样后端无需依赖终端临时 `export`，部署更稳，Key 也不会进进程命令行参数。
# 失败则静默降级为「纯环境变量」模式（行为不变）。
try:
    from dotenv import load_dotenv
    # 明确指向本模块同目录的 .env，避免受运行目录影响
    _env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    load_dotenv(_env_path)
except Exception:
    pass

EMBEDDING_MODEL = "embedding-3"
CHAT_MODEL = "glm-4-flash"

# 生成长度上限：防止模型长篇大论拖慢整条链路（首字不变，但总时长显著缩短）。
# 智谱 OpenAI 兼容接口，所有文本/视觉/工具调用统一注入该参数。
MAX_TOKENS = int(os.environ.get("ZHIPU_MAX_TOKENS", "500") or "500")

# 文生图模型：默认 cogview-3-flash（免费档，演示零成本）；
# 如需更高质量可改用 "glm-image" / "cogview-4"，无需新增 Key，
# 仅通过环境变量 ZHIPU_IMAGE_MODEL 切换即可。
IMAGE_MODEL = os.environ.get("ZHIPU_IMAGE_MODEL", "cogview-3-flash").strip() or "cogview-3-flash"
IMAGE_API_URL = "https://open.bigmodel.cn/api/paas/v4/images/generations"

API_KEY = os.environ.get("ZHIPU_API_KEY", "").strip()
_MODE = "real" if API_KEY else "mock"

_client = None
if _MODE == "real":
    try:
        from zhipuai import ZhipuAI
        try:
            # timeout: 单次模型调用超时（秒）；max_retries: SDK 级重试。
            # 限制单次调用最长时间，避免慢调用无限挂起拖垮整条链路 / 触发网关 524。
            _client = ZhipuAI(api_key=API_KEY, timeout=45, max_retries=1)
        except TypeError:
            # 旧版 SDK 不接受 timeout 参数时回退到默认构造
            _client = ZhipuAI(api_key=API_KEY)
    except Exception as e:  # 极端情况：Key 配了但 SDK 不可用 → 退回 mock
        _MODE = "mock"
        _client = None
        _import_error = e

MODE = _MODE


# --------------------------------------------------------------------------- #
# 向量化
# --------------------------------------------------------------------------- #
def _mock_embed(texts, dim: int = 1024):
    """离线向量：字 bi-gram + TF 加权 + L2 归一化。中文同字会自然产生词面重叠。"""
    out = []
    for t in texts:
        vec = np.zeros(dim, dtype=np.float32)
        grams = [t[i:i + 2] for i in range(len(t) - 1)] or [t]
        for g in grams:
            h = int(hashlib.md5(g.encode("utf-8")).hexdigest(), 16)
            vec[h % dim] += 1.0
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec = vec / norm
        out.append(vec.tolist())
    return out


def embed(texts, batch_size: int = 32):
    """texts: list[str] -> list[list[float]]（L2 归一化）。"""
    if isinstance(texts, str):
        texts = [texts]
    texts = [str(t) for t in texts]

    if _MODE != "real":
        return _mock_embed(texts)

    try:
        out = []
        for i in range(0, len(texts), batch_size):
            chunk = texts[i:i + batch_size]
            resp = _client.embeddings.create(model=EMBEDDING_MODEL, input=chunk)
            out.extend([d.embedding for d in resp.data])
        return out
    except Exception as e:
        # Key 失效/过期/网络抖动时降级为本地哈希向量，保证检索服务不挂
        logger.warning("embedding 调用失败，降级为本地哈希向量: %s", e)
        return _mock_embed(texts)


# --------------------------------------------------------------------------- #
# 文本生成（可选 JSON 模式）
# --------------------------------------------------------------------------- #
def _extract_json(text: str):
    """从模型输出中尽量稳健地解析出 JSON 对象。"""
    if text is None:
        return None
    text = text.strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            return None
    return None


def chat_text(system: str, user: str, temperature: float = 0.1,
              max_tokens: int = None) -> str | None:
    """自由文本生成（Query Rewrite / 兜底链等）。无 Key 或调用失败均返回 None。

    max_tokens 统一限制生成长度，避免模型长篇大论拖慢整条链路。
    """
    if _MODE != "real":
        return None
    try:
        resp = _client.chat.completions.create(
            model=CHAT_MODEL,
            temperature=temperature,
            max_tokens=max_tokens or MAX_TOKENS,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        return resp.choices[0].message.content
    except Exception as e:
        # Key 失效/过期/网络抖动时降级为 None，由调用方走规则兜底，避免整条链路 500
        logger.warning("chat_text 调用失败（已降级为兜底）: %s", e)
        return None


def chat_stream(system: str, user: str, temperature: float = 0.5,
                max_tokens: int = None):
    """真流式文本生成：stream=True，逐块 yield 文本片段（不做任何一次性聚合）。"""
    if _MODE != "real":
        yield "（离线模式，暂未接入真实模型。）"
        return
    try:
        resp = _client.chat.completions.create(
            model=CHAT_MODEL,
            temperature=temperature,
            max_tokens=max_tokens or MAX_TOKENS,
            stream=True,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        for chunk in resp:
            try:
                delta = chunk.choices[0].delta.content
            except Exception:
                delta = None
            if delta:
                yield delta
    except Exception as e:
        logger.warning("chat_stream 调用失败: %s", e)
        yield "（AI 服务暂时不可用，请稍后再试。）"


def chat_vision(system: str, user_text: str, image_path: str, temperature: float = 0.2) -> str | None:
    """视觉对话（glm-4v-flash）：把本地图片转为 base64 喂给多模态模型作答。

    用于「纹样识别」链路：用户带图提问『这是什么纹样』时，由视觉模型
    直接看图识别，而非走配色提取。无 Key / 调用失败均返回 None，由调用方兜底。
    """
    if _MODE != "real" or not image_path:
        return None
    try:
        import base64
        from PIL import Image
        import io
        # 统一转成 JPEG base64，规避 webp 等扩展名兼容问题
        img = Image.open(image_path).convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
        data_url = f"data:image/jpeg;base64,{b64}"
        resp = _client.chat.completions.create(
            model="glm-4v-flash",
            temperature=temperature,
            max_tokens=MAX_TOKENS,
            messages=[
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": data_url}},
                    {"type": "text", "text": (system + "\n\n" + user_text).strip()},
                ]},
            ],
        )
        return resp.choices[0].message.content
    except Exception as e:
        logger.warning("chat_vision 调用失败（已降级为兜底）: %s", e)
        return None


async def chat_with_vision(prompt: str,
                           image_data: str | None = None,
                           image_url: str | None = None,
                           system: str = "",
                           temperature: float = 0.3):
    """异步流式视觉对话（glm-4v-flash），用于「纹样识别」链路。

    按智谱官方多模态 API 格式组装 messages（text + image_url 两个节点），
    并以异步生成器逐块 yield 文本片段，供 SSE / 打字机效果使用。

    参数
    ----
    prompt      : 用户文本提示词（必填）
    image_data  : Base64 图片字符串（可带或不带 data: 前缀），与 image_url 二选一
    image_url   : 可访问的图片 URL，与 image_data 二选一
    system      : 系统级指令（如文物专家设定 + RAG 参考资料），拼在文本前
    """
    if _MODE != "real":
        yield "（离线模式未接入视觉模型，无法识别图片。）"
        return
    if not image_data and not image_url:
        yield "（缺少图片数据，无法调用视觉识别。）"
        return

    # 统一成 image_url 节点可识别的形态
    if image_data:
        url = image_data if image_data.startswith("data:") else f"data:image/jpeg;base64,{image_data}"
    else:
        url = image_url

    text = (system + "\n\n" + prompt).strip() if system else prompt

    try:
        resp = _client.chat.completions.create(
            model="glm-4v-flash",
            temperature=temperature,
            max_tokens=MAX_TOKENS,
            stream=True,
            messages=[
                {"role": "user", "content": [
                    {"type": "image_url", "image_url": {"url": url}},
                    {"type": "text", "text": text},
                ]},
            ],
        )
        for chunk in resp:
            try:
                delta = chunk.choices[0].delta.content
            except Exception:
                delta = None
            if delta:
                yield delta
    except Exception as e:
        logger.warning("chat_with_vision 流式调用失败: %s", e)
        yield f"（视觉识别调用失败：{e}）"


def chat_json(system: str, user: str, temperature: float = 0.1) -> dict | None:
    """JSON 模式生成（用于意图分类兜底）。无 Key 或调用失败均返回 None。"""
    if _MODE != "real":
        return None
    try:
        resp = _client.chat.completions.create(
            model=CHAT_MODEL,
            temperature=temperature,
            max_tokens=MAX_TOKENS,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        return _extract_json(resp.choices[0].message.content)
    except Exception as e:
        logger.warning("chat_json 调用失败（已降级为兜底）: %s", e)
        return None


def chat_tools(system: str, user: str, tools: list,
               tool_choice: str = "auto", temperature: float = 0.2,
               history: list = None) -> dict:
    """
    Function-Calling 封装（OpenAI 风格 tools，智谱 GLM 兼容）。

    用于 ReAct 自主决策：模型可返回 0~N 个 tool_calls，由调用方执行后再回填。
    返回结构（与调用方约定稳定）:
        {
          "content": str | None,        # 模型的最终自然语言（无工具调用时）
          "tool_calls": [               # 本次需执行的工具调用列表
             {"name": str, "arguments": dict}, ...
          ],
          "finish_reason": str | None,  # "tool_calls" / "stop" / ...
        }

    mock 模式（无 Key 或 SDK 不可用）直接返回空 tool_calls，由调用方走确定性兜底，
    绝不抛出、绝不 500。
    """
    if _MODE != "real":
        return {"content": None, "tool_calls": [], "finish_reason": None}

    try:
        messages = [{"role": "system", "content": system}]
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": user})

        resp = _client.chat.completions.create(
            model=CHAT_MODEL,
            temperature=temperature,
            max_tokens=MAX_TOKENS,
            tools=tools,
            tool_choice=tool_choice,
            messages=messages,
        )
        msg = resp.choices[0].message
        tool_calls = []
        for tc in (msg.tool_calls or []):
            try:
                args = json.loads(tc.function.arguments) if tc.function.arguments else {}
            except Exception:
                args = {}
            tool_calls.append({"name": tc.function.name, "arguments": args})
        return {
            "content": msg.content,
            "tool_calls": tool_calls,
            "finish_reason": resp.choices[0].finish_reason,
        }
    except Exception as e:
        logger.warning("chat_tools 调用失败（已降级为无工具兜底）: %s", e)
        return {"content": None, "tool_calls": [], "finish_reason": None}


# --------------------------------------------------------------------------- #
# 文生图（智谱 CogView / GLM-Image 生态）
# --------------------------------------------------------------------------- #
def generate_image(prompt: str, size: str = "1024x1024", model: str | None = None) -> str | None:
    """文本生成图像（智谱开放平台文生图接口）。

    复用既有 ZHIPU_API_KEY，不引入任何新环境变量 / 新 Key。
    调用 https://open.bigmodel.cn/api/paas/v4/images/generations ，
    返回图片 URL（智谱返回的临时链接，有效期约 30 天）。

    入参
    ----
    prompt : 文生图描述（如「青花瓷现代简约风云纹，白地蓝花，矢量插画」）
    size   : 输出尺寸，默认 1024x1024（cogview-3-flash 支持 512/768/1024 等边）
    model  : 指定模型，默认取 IMAGE_MODEL（cogview-3-flash）；可传 "glm-image" 等

    返回
    ----
    str  : 图片 URL（可直接放进 <img src>）
    None : 无 Key（mock 模式）/ 调用失败 / 模型不可用 → 由调用方走占位图兜底
    """
    if _MODE != "real":
        logger.info("generate_image 处于 mock 模式（无 ZHIPU_API_KEY），返回 None 由前端走占位图")
        return None
    prompt = (prompt or "").strip()
    if not prompt:
        logger.warning("generate_image 收到空 prompt，跳过")
        return None

    model = (model or IMAGE_MODEL).strip() or "cogview-3-flash"
    payload = {
        "model": model,
        "prompt": prompt,
        "size": size or "1024x1024",
        "n": 1,
    }

    try:
        import requests
        resp = requests.post(
            IMAGE_API_URL,
            headers={
                "Authorization": f"Bearer {API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        items = data.get("data") or []
        if items and items[0].get("url"):
            logger.info("generate_image 成功：model=%s | url=%s", model, items[0]["url"][:80])
            return items[0]["url"]
        # 个别情况下接口回传 b64_json（兜底转 data URI）
        if items and items[0].get("b64_json"):
            logger.info("generate_image 成功（b64_json 回退）：model=%s", model)
            return "data:image/png;base64," + items[0]["b64_json"]
        logger.warning("generate_image 返回为空 data：%s", str(data)[:200])
        return None
    except Exception as e:
        # Key 失效 / 过期 / 网络抖动 / 模型不可用：降级为 None，由前端走占位图兜底，绝不抛 500
        logger.warning("generate_image 调用失败（已降级为占位图兜底）: %s", e)
        return None


if __name__ == "__main__":
    print("MODE =", MODE)
    v = embed(["明清 红色 纹样", "苗族 银饰"])
    print("embed dim =", len(v[0]), "samples =", len(v))
