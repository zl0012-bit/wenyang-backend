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
import shutil
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# 后端启动即加载 .env（含 ZHIPU_API_KEY），必须早于任何业务/智谱客户端的导入
try:
    from dotenv import load_dotenv
    _env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    load_dotenv(_env_path)
except Exception:
    pass

import agent_router as ar

logger = logging.getLogger("main")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# —— 额外把日志落盘到 react_trace.log，方便事后 grep / 截图（手机端看不到终端，C1 复盘用）——
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


@app.post("/api/agent_chat")
async def agent_chat(request: Request):
    ctype = request.headers.get("content-type", "")

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
    else:
        # —— FormData 分支（可含图片）——
        form = await request.form()
        user_input = (form.get("user_input") or "").strip()
        current_page = form.get("current_page")
        mode = str(form.get("mode") or "default").strip().lower()
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

    try:
        if mode == "react":
            # 隔离链路：只有显式指定 mode=react 才进入多轮自主决策，
            # 默认仍走确定性 run_agent，确保前端联调不崩。
            logger.info("[API] mode=react，路由到 ReAct 自主决策链路")
            return ar.run_agent_react(
                user_input=user_input,
                has_image=has_image,
                current_page=current_page,
                image_path=image_path,
            )
        return ar.run_agent(
            user_input=user_input,
            has_image=has_image,
            current_page=current_page,
            image_path=image_path,
        )
    finally:
        # 处理完毕，清理上传的临时图片
        for p in tmp_files:
            try:
                os.remove(p)
            except OSError:
                pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
