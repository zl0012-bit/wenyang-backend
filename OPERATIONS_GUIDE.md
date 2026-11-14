# 纹以载道 · RAG 知识库后端｜项目主程实操指南

> 配套文件：`rag_search.py` / `intent_router.py` / `zhipu_client.py` / `agent_router.py` /  
> `vision_tools.py` / `main.py` / `glm4v_batch_labeling.py` / `rebuild_index.py` /  
> `test_rag.py` / `frontend_guide.md`。  
> 本指南只讲「怎么把这套东西在你机器上跑顺、跑全」，不重复代码。

---

## 〇、一句话总览（先建立心智模型）

```
前端(JS/TS)  ──POST /api/agent_chat──▶  main.py(FastAPI)
                                          │
                              ┌───────────┴───────────┐
                         有图? │                       │ 纯文本
                              ▼                       ▼
                       vision_tools.py          intent_router.py
                      (OpenCV 配色/切图)              │ classify_intent
                                                    ▼
                                          rag_search.py → ChromaDB(embedding-3)
                                                    │ sources
                                                    ▼
                                          glm-4-flash 生成 answer
```

所有大模型调用都收敛到 `zhipu_client.py`：无 `ZHIPU_API_KEY` 时自动降级（embedding 用本地哈希、LLM 用检索兜底），**保证离线也能把整条链路跑通验证**；配了 Key 才是真实语义效果。

---

## 一、环境与依赖排雷

### 1.1 精确版本清单（已实测可跑，见 `requirements.txt`）

直接 `pip install -r requirements.txt` 即可，版本已锁定，避免 numpy/pydantic 升级引发的级联冲突：

| 包                                                                                                                               | 锁定版本           | 说明                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------- |
| `chromadb`                                                                                                                      | 1.5.9          | 向量库                                       |
| `zhipuai`                                                                                                                       | 2.1.5.20250825 | 智谱 SDK（embedding-3 + glm-4-flash）         |
| `fastapi`                                                                                                                       | 0.156.4        | Web 框架                                    |
| `uvicorn`                                                                                                                       | 0.54.0         | ASGI 服务器                                  |
| `python-multipart`                                                                                                              | 0.0.32         | **带图 FormData 必需**，Starlette 不自带，漏装会报 422 |
| `opencv-python-headless`                                                                                                        | 5.0.0.93       | 视觉工具链（无 GUI 依赖）                           |
| `pillow`                                                                                                                        | 13.0.0         | WebP/透明 PNG 兼容读取（**本次新增**）                |
| `numpy`                                                                                                                         | 2.4.6          | 三者共同依赖，必须锁                                |
| `pydantic` / `onnxruntime` / `tokenizers` / `starlette` / `httpx` / `anyio` / `sniffio` / `filelock` / `h11` / `click` / `tqdm` | 见文件            | chromadb/fastapi 的传递依赖，一并锁死               |

> **强烈建议用独立 venv**，不要装到系统 Python：
>
> ```bash
> cd rag
> python3 -m venv .venv && source .venv/bin/activate
> pip install -r requirements.txt
> ```
>
> 若你本地有 conda，`conda create -n wenyang python=3.11` 然后同样 `pip install -r`。

### 1.2 `uvicorn main:app` 启动 3 步排查清单

遇到起不来，按这个顺序查，**90% 的坑都在前两步**：

**第 1 步：端口被占用（`[Errno 98] Address already in use`）**

```bash
# 看谁占了 8000
lsof -i:8000        # macOS/Linux
# 或
ss -ltnp | grep 8000
# 解决：换端口，或杀掉旧进程
uvicorn main:app --port 8001
# 或
pkill -f "uvicorn main:app" && sleep 1
```

**第 2 步：找不到模块 / 导入报错（`ModuleNotFoundError: No module named 'chromadb'`）**

```bash
# 99% 是「装到 A 环境、跑到 B 环境」
which python; which uvicorn          # 确认二者同属一个 venv
pip show chromadb | grep Location    # 确认装进了当前环境
# 若不一致，先 source 正确的 venv 再跑
source .venv/bin/activate
python -c "import chromadb, cv2, fastapi; print('all ok')"   # 起服前先自测导入
```

**第 3 步：起服后接口 500 / 报错（`chromadb` 持久化目录损坏、`sqlite3` 版本旧）**

```bash
# 真机首次跑，先删掉旧的 chroma_db 让其重建（数据会从 CSV 重新向量化，不会丢）
rm -rf chroma_db
# 老系统 sqlite3 太旧会报 operational error，升级：
pip install -U sqlite3            # 或用 pip 的 pysqlite3-binary 顶替
# 最后用「热重载 + 指定 host」起服，方便联调
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```



> **自检捷径**：起服后用 `curl` 打一发，比开浏览器快得多：
>
> ```bash
> curl -s http://127.0.0.1:8000/health
> curl -s -X POST http://127.0.0.1:8000/api/agent_chat -H "Content-Type: application/json" \
>      -d '{"user_input":"苗族纹样有什么特色","current_page":"纹样宝库"}'
> ```

---

## 二、574 条 GLM-4V 扩写 + 重建索引（数据打标阶段）

### 2.1 操作顺序（三步走，别跳步）

```bash
# 0) 准备 Key（打标和「真实语义」回答都靠它；只看管线可跳过）
export ZHIPU_API_KEY=你的智谱Key        # https://open.bigmodel.cn 获取

# 1) 试跑 10 条，先看 GLM-4V 扩写的语气 / 色彩准确度合不合预期
python3 glm4v_batch_labeling.py --limit 10
#    → 进度写进 labels_glm4v.jsonl；断点续跑，重复执行不会重复打已完成的

# 2) 验收试跑：看 labels_glm4v.jsonl 里 meaning_rich / craft_desc / color_palette
#    觉得 OK 再全量（glm-4v-flash 免费档，574 条约 1–2 小时，支持 --workers 并发）
python3 glm4v_batch_labeling.py --workers 4
#    只想打某类（如少数民族纹样）：python3 glm4v_batch_labeling.py --category 少数民族纹样

# 3) 合并回盘点清单（把扩写写进 pattern_inventory_574.csv 的 meaning_rich 等列）
python3 glm4v_batch_labeling.py merge
#    → 输出「合并完成：574/574 条已注入盘点清单」，并列出低置信度条目待人工复核
```

> 防幻觉设计回顾：`glm4v_batch_labeling.py` 里**正文出现书名号引用即判失败**，模型只描述视觉、不乱编文献；`merge` 写入的 `refs_verified` 列统一为「待人工核对」——这是底线，别让模型替你「确认」出处。

### 2.2 最关键的一步：合并后必须重建向量库

`merge` 只是把文字写进 CSV，**ChromaDB 里存的还是旧 chunk 文本 + 旧 embedding**。不打标时检索靠 `meaning_short` 兜底；打标后 `meaning_rich` 填满了，但**不重建索引，新寓意永远不会被检索到**。

直接用现成的 `rebuild_index.py`：

```bash
# 方式 A：CSV 已 merge 完，直接重建
python3 rebuild_index.py

# 方式 B：让脚本先 merge 再重建（一键）
python3 rebuild_index.py --auto-merge

# 真实 embedding 需要 Key；无 Key 会降级为本地哈希向量（仅验证管线，非真实语义）
export ZHIPU_API_KEY=你的Key && python3 rebuild_index.py
```

重建后跑一遍冒烟，确认新寓意生效：

```bash
python3 test_rag.py
```

> 重建会删除旧 `chroma_db/` 后重写。真实环境 574 条 × embedding-3 批量调用约 1–3 分钟。  
> `get_collection()` 还会比较 `embed_mode` 标记：mock↔real 切换时**强制自动重建**，你不用担心离线向量污染线上。

---

## 三、前端旧代码替换「保姆级」定位与报错排查

> 实际替换代码（原直连 vs 改调后端、纯文本 vs 带图两种 `fetch`、JSON 解析与色块渲染）见 `frontend_guide.md`。这里只讲「怎么定位」和「两类报错怎么救」。

### 3.1 原本直连智谱的代码，去哪找？

全局搜这些关键字，命中处就是你要替换的调用点（注意只改**请求发出**的那段，UI 渲染逻辑保留）：

| 搜索关键字                                               | 大概率是什么                    |
| --------------------------------------------------- | ------------------------- |
| `open.bigmodel.cn` / `open.bigmodel.cn/api/paas/v4` | 智谱 API 直连地址（**核心替换点**）    |
| `Authorization` + `Bearer` + `你的Key`                | API Key 硬编码（**安全隐患，必须删**） |
| `zhipuai` / `ZhipuAI(` / `chat.completions`         | SDK 直连调用                  |
| `fetch(` / `axios.post(` 指向上述地址                     | 请求发送处                     |
| 一个 `apiKey` / `API_KEY` / `const key =` 常量          | Key 定义处（删掉，改由后端代理）        |

典型「危险」旧代码长这样（你应该在 `frontend_guide.md` 第 1 节看到完整示例）：

```js
const res = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json",
             "Authorization": "Bearer " + "ZMxxx你的Key" },   // ❌ 暴露在前端
  body: JSON.stringify({ model: "glm-4-flash", messages: [...] })
});
```

替换原则：**把上面这段整段换成 `POST http://localhost:8000/api/agent_chat`**（看 `frontend_guide.md` 第 2–3 节），Key 只留在后端 `.env`，前端代码里 `grep -rn "Bearer" src/` 应为空。

### 3.2 两类浏览器报错，分别是什么、怎么救

**报错 ①：`Access to fetch at 'http://localhost:8000' from origin 'http://localhost:5173' has been blocked by CORS policy`**

- **含义**：浏览器同源策略拦了跨域。前端在 5173、后端在 8000，不同源。
- **不是你代码写错**，是后端没放行。
- **怎么救**：
  1. 后端 `main.py` 已内置 `CORSMiddleware(allow_origins=["*"])`，确认它还在、且 `app.add_middleware` 在路由定义之前；
  2. 若你收紧过白名单，把前端地址加进去：`allow_origins=["http://localhost:5173","http://localhost:3000"]`；
  3. **坑点**：`Content-Type: application/json` 触发浏览器「预检 OPTIONS」。FastAPI + 上述 CORS 配置会自动回 200，无需手写 OPTIONS 路由；若仍失败，检查是否有 Nginx 反向代理把 OPTIONS 拦了。

**报错 ②：`net::ERR_CONNECTION_REFUSED` / `Failed to fetch`**

- **含义**：前端根本连不上后端（连接被拒），和 CORS 无关——CORS 是「连上了但不让读」，这个是「门都没开」。
- **怎么救**（按顺序）：
  1. 后端真的在跑吗？`curl http://127.0.0.1:8000/health` —— 连不上说明 uvicorn 没起或崩了（回到 §1.2 三步排查）；
  2. 地址对吗？前端写的是 `http://localhost:8000` 还是 `127.0.0.1`？**二者在容器/真机有时不等价**，统一用 `127.0.0.1` 更稳；
  3. 端口对吗？后端起在 8000，前端 fetch 的是 8000 吗？
  4. 跨设备联调（手机访问电脑后端）：后端必须 `--host 0.0.0.0`，且手机和电脑同一局域网；云服务器还要放行安全组入站 8000。

> **一句话区分**：CORS = 连上了被拦（改后端放行）；ERR_CONNECTION_REFUSED = 没连上（先确认后端活着、地址端口对）。

---

## 四、视觉工具 WebP 兼容补丁（已落地）

你的 574 条全是 `.webp`，OpenCV 的 `cv2.imread` 对部分 webp 编码会直接返回 `None`。已在 `vision_tools.py` 加 `_load_rgb()`：

- 先试 `cv2.imread`（jpg/png 最快）；
- 失败自动回退 `Pillow`（`Image.open(...).convert("RGB")`，**原生支持 webp / 带透明通道 PNG**）；
- `extract_color` 与 `segment_pattern` 都已改用它，对任意格式图片稳提取配色与切层。

新增依赖 `pillow==13.0.0`（已写入 `requirements.txt`）。验证：

```bash
python3 vision_tools.py /workspace/patterns/A01.webp
```

---

## 五、下一步：从「确定性路由」升级到「多轮自主决策（ReAct）」

当前链路是**单轮确定性**：一次请求 → 分类 → 检索/视觉 → 回答。升级目标是让 Agent **自己判断要不要再查、换词查、或主动追问**，对应业界 ReAct（Reasoning + Acting）范式。

### 5.1 演进设计图

```
┌─────────────────────────────────────────────────────────────────┐
│                      ReAct Agent Loop                            │
│                                                                 │
│   user_input + history                                          │
│        │                                                        │
│        ▼                                                        │
│   ┌───────────────  Plan / Reason  ───────────────┐            │
│   │  glm-4-flash（tools 模式，JSON function_call） │            │
│   │  决定下一步调用哪个 tool，或给出最终回答        │            │
│   └───────────────┬───────────────────────────────┘            │
│                   │ 返回 tool_call                              │
│        ┌──────────┴───────────┬──────────────┬──────────┐     │
│        ▼                      ▼              ▼          ▼     │
│   rag_search()        vision_tools        rewrite_     ask_user │
│   (可多次/换词)        (extract_color/     query()     (信息不足 │
│                        segment_pattern)   重查检索)    时追问)   │
│        │                      │              │          │       │
│        └──────────┬───────────┴──────────────┴──────────┘      │
│                   ▼  tool 结果回灌成 observation                  │
│           回到 Reason，直到模型输出最终 answer（无 tool_call）    │
│                   │                                             │
│                   ▼                                             │
│           返回 answer + 完整 trace（便于调试/展示思考链）         │
└─────────────────────────────────────────────────────────────────┘
```


```

### 5.2 落地建议（和你现有代码的衔接）

1. **不用从零造**：智谱 `glm-4-flash` 原生支持 `tools` 参数（OpenAI 兼容的 function calling）。把现有 `intent_router` 的「规则前置拦截」保留为**第一道低成本拦截**，命中的直接走原确定性路径；只有规则不确定时才进 ReAct 循环——省 token 又稳。
2. **把已有能力直接注册成 tools**：
   - `rag_search(query, dynasty_filter, theme_filter)` → 工具 `search_patterns`
   - `extract_color` / `segment_pattern` → 工具 `analyze_image`（已在 `vision_tools.VISION_TOOLS` 备好 schema）
   - 新增 `rewrite_query(query)` → 工具 `reformulate`（检索太差时让模型自己换词）
   - 新增 `ask_clarification(question)` → 工具 `clarify`（信息不足时主动追问用户）
3. **循环与停止条件**：`max_steps=5` 防失控；每轮把 `thought → action → observation` 累加进 messages；模型返回无 `tool_calls` 即终止，输出 `answer`。
4. **你的两个具体场景天然契合**：
   - 「检索结果不够 → 换个词再查」：`search_patterns` 返回 top_k 太弱时，模型调用 `reformulate` 再查；
   - 「拆分图层质量太差 → 提示换图」：`segment_pattern` 返回 `num_components` 过多（噪点）或过少（糊成一块）时，模型调用 `clarify("图层切分质量低，建议上传更清晰/更高对比度的图")`。
5. **最小改造点**：在 `agent_router.run_agent` 里增加一个 `mode="react"` 分支，复用现有 `zhipu_client.chat_tools()`（需我在 `zhipu_client.py` 补一个 `chat_tools(system, messages, tools)` 封装），`main.py` 接口加一个可选字段 `mode` 即可，前端无需改动。

> 这一步建议**等 GLM-4V 打标 + 索引重建（§二）完成、检索质量上来后再上**——否则 ReAct 在脏数据上只会「更努力地查错东西」。先把确定性链路打标跑满，再让 Agent 自主决策。
