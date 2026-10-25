# 纹以载道 · 数启新章

> **AI 共创驱动的中国传统非遗纹样数字博物馆**
>
> 一个把「汉唐至明清的非遗纹样」构建成结构化知识库，并用大语言模型让访客**用自然语言问纹样、上传图片做 AI 共创、提出模糊需求由 Agent 自主推理**的开源数字文博项目。

<p align="center">    
  <img src="frontend/favicon.svg" width="64" alt="纹以载道 Logo">    
</p>

<p align="center">    
  <a href="#技术架构"><img src="https://img.shields.io/badge/Arch-Vue3%20%7C%20FastAPI-blue" alt="Arch"></a>    
  <a href="#本地安装与运行"><img src="https://img.shields.io/badge/Runtime-Node18%20%2B%20Python3.11-green" alt="Runtime"></a>    
  <a href="#环境变量配置"><img src="https://img.shields.io/badge/LLM-智谱%20GLM--4--Flash-orange" alt="LLM"></a>    
  <a href="#许可证"><img src="https://img.shields.io/badge/License-MIT-yellow" alt="License"></a>    
</p>

---

## 一、项目简介

「纹以载道」以 **574+ 枚高清中国传统纹样**（云纹、龙纹、宝相花、缠枝莲、八吉祥、三兔共耳……）为资产底座，结合 **智谱 GLM-4-Flash 大模型 + ChromaDB 向量知识库 + OpenCV 视觉工具**，打造一个面向公众的「非遗纹样数字博物馆」与「AI 共创工作台」。

访客可以：

- **用自然语言问纹样** ——「明清和宋代的龙纹有什么区别？」→ 检索知识库并生成考据式长篇回答 + 相关纹样卡片。
- **上传图片做 AI 共创** —— 上传一张纹样，本地 **提取主色板、切分图层**，返回可直接用于再设计的结构化结果。
- **提出模糊 / 口语化需求** ——「找一些特别有吉祥寓意的古老纹样，不要近现代的」→ 系统 **自主多步推理、换词重试、反思纠错**，给出温和兜底推荐。

项目强调 **工程健壮性**：Key 接入防呆校验、Mock 降级可观测、ReAct 防死循环、日志落盘可复盘，并采用 **同源部署**（Node 静态服务 + `/api/*` 反向代理）彻底规避 CORS 与外网暴露风险。

---

## 二、核心特性

| 模块                    | 能力                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------- |
| **智能问答（RAG）**         | 意图识别（qa / comparison / redesign / other）→ ChromaDB 向量召回 top-5 → GLM-4-Flash 基于检索资料生成考据式回答 |
| **视觉共创（OpenCV 本地处理）** | `extract_color`（K-Means 主色板 + 像素占比）、`segment_pattern`（Canny 边缘 + 连通域图层切分），全程本地、不上传原图      |
| **ReAct 多轮自主决策**      | `mode=react` 进入「思考–工具–观察」循环，自动换词重试与反思纠错，最多 `max_steps=3` 步                                |
| **防死循环 + 温和兜底**       | 命中偏低时自动软化话术；步数耗尽也抽取全程最高分命中强制合成，绝不返回冰冷提示                                                   |
| **全链路可观测**            | `[ReAct]` 决策轨迹同时输出终端并落盘 `react_trace.log`，可截图复盘                                           |
| **国风交互体验**            | 磨砂宣纸质感 UI、纹样配图卡片、AI 对话详情毛玻璃弹窗、个人中心创作 / 收藏 / 对话记录                                          |
| **部署友好**              | 前端纯静态托管，后端 FastAPI；同源代理彻底规避跨域，支持云服务器 / Vercel / 本地一键启动                                    |

---

## 三、技术架构

```
┌──────────────────────── 浏览器 (SPA) ────────────────────────┐
│  个人中心 / 纹样宝库 / AI 共创工作台（ai-workshop）              │
│  技术栈：原生 HTML + 编译后 JS Bundle + 运行时注入脚本          │
└───────────────────────────┬──────────────────────────────────┘
                             │  HTTP 静态资源 + POST /api/agent_chat
┌─────────────────── Node 静态服务器 (端口 3000) ──────────────┐
│  frontend/server.js：托管 SPA + 历史路由回退 + /api/* 反向代理  │
└────────────────────────────┬─────────────────────────────────┘
                             │  http://127.0.0.1:8000
┌──────────────────── FastAPI 后端 (端口 8000) ────────────────┴──────────┐
│  main.py  →  路由分发 /api/agent_chat                                    │
│    ├─ mode=default → agent_router.run_agent（确定性 RAG 链路）           │
│    └─ mode=react   → agent_router.run_agent_react（ReAct 链路）         │
│                                                                         │
│  ├─ intent_router   意图识别 (qa / comparison / redesign / other)       │
│  ├─ rag_search      ChromaDB 向量检索（embedding-3 向量）               │
│  ├─ vision_tools    OpenCV：extract_color / segment_pattern            │
│  └─ zhipu_client    智谱 GLM-4-Flash / GLM-4V-Flash / embedding-3      │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
              ┌────────────────┴─────────────────┐
        ChromaDB 持久化索引         智谱 AI 大模型 API
        (chroma_db/, 574+ chunks)   (glm-4-flash / glm-4v-flash / embedding-3)
```

### 技术栈一览

| 层          | 技术                                                                                    |
| ---------- | ------------------------------------------------------------------------------------- |
| **前端**     | 原生 HTML/CSS/JS（编译产物 Bundle）+ Vue3 组件源码参考 + GSAP 动效；Node 静态服务器做同源代理                    |
| **后端与中间层** | Python 3.11 · FastAPI · Uvicorn · Pydantic · ChromaDB（向量库）· OpenCV / NumPy（视觉）        |
| **AI 能力**  | 智谱 GLM-4-Flash（文本生成）· GLM-4V-Flash（视觉理解）· embedding-3（向量化）· ReAct 自主决策                |
| **部署与运维**  | 同源反向代理规避 CORS · 一键唤醒脚本（`restart_frontend.sh` / `restart_backend.sh`）· 支持云服务器 / Vercel |

---

## 四、目录结构

```text
纹以载道/
├── frontend/                 # 前端（纯静态 SPA + Node 同源代理服务器）
│   ├── index.html            #   入口页面
│   ├── server.js             #   生产静态服务器 + /api/* 反向代理到后端 8000
│   ├── package.json          #   启动脚本：npm run start（= node server.js）
│   ├── assets/               #   编译后 JS/CSS Bundle、纹样交互脚本、copilot 等
│   ├── patterns/             #   574+ 枚纹样原图（.webp），项目核心数据集
│   ├── avatars/              #   用户头像素材
│   ├── admin/                #   纹样数据管理后台
│   ├── mock_users.js         #   演示用 Mock 数据（收藏 / 创作 / AI 对话）
│   ├── profile_enhance.js    #   个人中心运行时增强脚本
│   └── *.inject.js           #   运行时注入脚本（纹样详情、反馈、悬浮等）
├── backend/                  # 后端（FastAPI RAG + AI Agent）
│   ├── main.py               #   应用入口与 /api/agent_chat 路由
│   ├── agent_router.py       #   确定性 RAG 链路 / ReAct 多轮链路
│   ├── intent_router.py      #   意图识别
│   ├── rag_search.py         #   ChromaDB 向量检索
│   ├── vision_tools.py       #   OpenCV 视觉工具（主色板 / 图层切分）
│   ├── zhipu_client.py       #   智谱 SDK 封装（含 real/mock 双模式）
│   ├── rebuild_index.py      #   本地重建向量索引
│   ├── requirements.txt      #   Python 依赖
│   ├── .env.example          #   环境变量模板（含 ZHIPU_API_KEY）
│   └── chroma_db/            #   运行时生成的向量索引（不入库，需重建）
├── docs/                     # 项目文档（答辩手册、技术亮点等）
├── .env.example              # 项目级环境变量模板
├── .gitignore
├── restart_frontend.sh       # 前端一键唤醒（杀旧进程 + 启动 + 自检）
├── restart_backend.sh        # 后端一键唤醒（venv + uvicorn + /health 自检）
└── README.md
```

---

## 五、本地安装与运行

> 前置依赖：**Node.js ≥ 18**、**Python 3.11**、一个可用的 **智谱 API Key**。

### 第 1 步：克隆并准备环境变量

```bash
git clone <your-repo-url> wenyang-museum
cd wenyang-museum

# 配置后端密钥（切勿提交真实 .env）
cp .env.example backend/.env
# 然后编辑 backend/.env，把 ZHIPU_API_KEY 换成你的真实 Key
```

### 第 2 步：启动后端（FastAPI）

```bash
cd backend

# 建议用虚拟环境（避免污染系统 Python）
python3.11 -m venv /tmp/ragvenv
source /tmp/ragvenv/bin/activate        # Windows: .\ragvenv\Scripts\activate
pip install -r requirements.txt

# 首次运行需重建向量索引（约 1–2 分钟，读 patterns 与知识库）
python rebuild_index.py

# 启动（生产）
uvicorn main:app --host 0.0.0.0 --port 8000
# 或带热重载的开发模式
uvicorn main:app --reload --port 8000
```

> 也可用仓库自带脚本：`bash restart_backend.sh`（会锁定 venv 解释器并自检 `/health`）。

### 第 3 步：启动前端（静态服务 + 同源代理）

```bash
cd frontend
npm install        # 仅安装运行 server.js 所需依赖（如有）
npm run start      # = node server.js，默认端口 3000
```

> 也可用仓库自带脚本：`bash restart_frontend.sh`（会杀掉旧进程、后台启动并自检 `http://localhost:3000`）。

### 第 4 步：访问

打开浏览器访问 **<http://localhost:3000>** ：

- 纹样宝库、个人中心、AI 共创工作台均已就绪；
- AI 对话入口：`http://localhost:3000/ai`；
- 后端健康检查：`http://localhost:8000/health`。

---

## 六、环境变量配置

后端通过 `backend/.env` 读取配置（已加入 `.gitignore`，不会入库）：

| 变量                      | 必填 | 说明                            |
| ----------------------- | -- | ----------------------------- |
| `ZHIPU_API_KEY`         | ✅  | 智谱 API Key，文本 / 视觉 / 向量三种能力共用 |
| `ZHIPU_CHAT_MODEL`      | ❌  | 文本模型，默认 `glm-4-flash`         |
| `ZHIPU_VISION_MODEL`    | ❌  | 视觉模型，默认 `glm-4v-flash`        |
| `ZHIPU_EMBEDDING_MODEL` | ❌  | 向量模型，默认 `embedding-3`         |
| `PORT`                  | ❌  | 后端端口，默认 `8000`                |

> `zhipu_client.py` 内置 `mock` 模式：当未配置 Key 时自动降级为本地模拟回答，便于无 Key 联调前端（生产必须切到 `real` 模式）。

---

## 七、API 概览

### `POST /api/agent_chat`

统一的智能体对话入口，支持纯文本与图文混合输入。

**请求（纯文本）**

```json
{
  "user_input": "明清和宋代的龙纹有什么区别？",
  "current_page": "纹样宝库",
  "has_image": false
}
```

**请求（带图片，multipart/form-data）**

```
fields: user_input, current_page, image(文件)
```

**响应**

```json
{
  "intent": "comparison",
  "confidence": 0.92,
  "reason": "用户在做跨朝代纹样对比",
  "answer": "……（考据式长篇回答）",
  "tool_results": [ { "tool": "query_heritage_db", "hits": 5 } ],
  "sources": [ "G01", "A12", "P08" ]
}
```

`mode=react` 时进入多步自主推理，返回中 `tool_results` 会包含完整「思考–工具–观察」轨迹。

---

## 八、数据集说明

- **`frontend/patterns/`**：项目核心纹样数据集，574+ 枚高清 `.webp` 原图，按编号（如 `G01` 云纹、`A12` 团窠、`P08` 缠枝莲）组织。
- **知识库**：后端在 `chroma_db/` 中维护向量索引，由 `rebuild_index.py` 基于 `patterns_raw.json` / `pattern_inventory_*.csv` 等元数据构建（索引为运行时产物，不入库，请按上文自行重建）。
- **演示账号**：前端内置 Mock 用户 `test@wenyang-museum.com / Test123456`，含示例收藏、创作与 AI 对话记录。

---

## 九、团队信息

> 以下为占位符，请替换为真实信息后再提交。

| 角色      | 姓名        | 职责               | 联系方式                   |
| ------- | --------- | ---------------- | ---------------------- |
| 项目负责人   | `{{曾子琳}}` | 整体架构 / 项目管理      | `{{885640167@qq.com}}` |
| 前端开发    | `{{邱泳欣}}` | 页面搭建/交互实现  | `{{qiu6626@qq.com}}`            |
| 后端 / AI | `{{曾子琳}}` | API开发/RAG知识库构建  | `{{885640167@qq.com}}` |
| 设计 / 文案 | `{{邱泳欣}}` | 视觉规范 / 纹样考据 / 内容 | `{{qiu6626@qq.com}}`            |

**指导老师**：`{{申妙芳}}`　**参赛赛道**：`{{AI Web网页开发挑战赛}}`　**所属院校 / 单位**：`{{广州科技职业技术大学}}`

---

## 十、开发计划（Roadmap）

- [ ] 向量索引增量更新与多模态检索
- [ ] AI 共创「文生图」直出纹样（接入图像生成模型）
- [ ] 个人中心多用户体系与云端同步
- [ ] 移动端 PWA 与离线纹样册

---

## 十一、许可证

本项目采用 **MIT License**（详见 `LICENSE`）。纹样图片版权归相应文博机构与创作者所有，仅用于非商业展示与教学演示。

---

<p align="center">    
  纹以载道 · 数启新章 —— 让千年纹样，在一问一答间重新生长。    
</p>
