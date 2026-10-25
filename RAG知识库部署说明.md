# 纹以载道 · RAG 知识库与向量化 —— 部署说明

> 配套任务：搭建 RAG 知识库 + 向量化 574 枚纹样数据
> 后端框架：NestJS 10（项目已有） · 向量库：Chroma v2 · 嵌入模型：BGE / 通义千问 / text-embedding-3-small（生产） · 零依赖中文 TF-IDF（沙箱兜底）
> 状态：**Phase 1（零依赖验证）+ Phase 2（真实环境导入 + 检索验证）+ Phase 3（RAG 问答接口接入 + 真实嵌入对比）均已完成**

---

## 一、交付物清单

| 文件 | 说明 |
| --- | --- |
| `src/modules/vector/vector.service.ts` | 向量化服务（封装 `addDocument` / `search` / `getEmbedding` / `count` / `isAvailable`），Chroma **v2** REST，集合名→UUID 缓存解析 |
| `src/ai/ai.service.ts` | RAG 问答核心：`chat()` 向量检索优先（无 LLM 密钥时由真实检索结果构造引用，保证「查看详情」指向馆内资料）+ `search()` 直接检索端点 |
| `src/ai/ai.controller.ts` | AI 路由：`/api/ai/chat`（问答）+ `/api/ai/search`（直接检索）+ recognize/generate/story/color/transfer/feedback |
| `src/ai/ai.module.ts` | 装配 AiModule（注入 VectorModule，提供 `VectorService`） |
| `src/vector/seed.ts` | 批量导入脚本（`npx tsx src/vector/seed.ts`，支持 `--dry-run`） |
| `src/vector/data/patterns.ts` | 574 枚纹样知识源包装（派生典型应用场景） |
| `src/vector/data/patterns-574.json` | 574 枚纹样原始数据（与前端同源，未改动） |
| `src/vector/data/dynasties.ts` · `crafts.ts` · `regions.ts` | 8 朝代 / 6 技艺 / 15 区域知识源 |
| `scripts/local_embed_server.py` | **嵌入桥服务**（OpenAI 兼容 `/v1/embeddings`）：让无 Docker / 无密钥的沙箱也能经真实 HTTP 拿到嵌入向量；后端 `BGE`（默认）或 `EMBED_BACKEND=tfidf` 零依赖中文 TF-IDF |
| `scripts/seed_run.sh` | 真实导入包装：先按 name 删除旧集合，再设环境变量跑 `seed.ts` |
| `scripts/run_all.sh` | 一站式流水线：端口检查 → 启动 Chroma + 嵌入服务 → seed → 检索验证（前台跑，避免后台子进程被沙箱回收） |
| `scripts/cleanup.sh` | 清理残留嵌入 / Chroma 进程（Git Bash 兼容，`pkill -f` + `taskkill` 兜底），避免端口 9999 / 8000 冲突 |
| `scripts/embed_comparison.result.json` | TF-IDF vs BGE 同 30 条查询对比报告（命中率 / top1 相似度 / 未命中） |
| `scripts/verify_rag_live.py` | 实时打 `/api/ai/chat`（5 题）+ `/api/ai/search` 验收脚本 |
| `scripts/verify_kb.py` | Phase 1 验证（本地 Chroma，5 条验收查询） |
| `scripts/verify_kb.result.json` | Phase 1 验证结果 |
| `scripts/verify_kb_extended.py` | Phase 2 扩充验证（**30 条，六类覆盖**，Chroma v2 name→UUID 解析） |
| `scripts/verify_kb_extended.result.json` | Phase 2 验证结果（命中数 / 命中率 / 平均相关度 / 未命中分析） |
| `docker-compose.yml` | 生产基础设施：MySQL + Redis + Chroma |

> `vector.service.ts` 是项目已有模块，本次补齐了 `getEmbedding`、四参 `addDocument`、`count`，并支持无密钥 / 不可达时自动降级。

---

## 二、部署步骤

### 步骤 1 · 启动向量数据库 Chroma（v2）
```bash
# 方式 A：docker run
docker run -d -p 8000:8000 -v ./chroma-data:/chroma/chroma chromadb/chroma
# 方式 B：docker-compose（已含 Redis/MySQL）
cd server && docker compose up -d
```
Chroma 端点：`http://localhost:8000`，健康检查 `GET /api/v2/heartbeat`。

### 步骤 2 · 安装依赖
```bash
cd server && npm install          # 含 tsx / @nestjs/axios 等
```

### 步骤 3 · 配置环境变量（`.env`）
```ini
VECTOR_DB_URL=http://localhost:8000
# 嵌入模型三选一（填入密钥后 seed 真正写入向量）：
EMBEDDING_API_BASE=https://dashscope.aliyuncs.com/api/v1   # 通义千问
EMBEDDING_API_KEY=sk-xxxxx
EMBEDDING_MODEL=text-embedding-v3
# 备选：OpenAI text-embedding-3-small / 自建 BGE 服务
```
> 密钥为空或 `FORCE_DEMO=true` 时 `getEmbedding` 返回 `null`，`addDocument` 返回 `false`（不写入），后端回退关键词检索 / mock —— 这是设计内降级，不是报错。

### 步骤 4 · 批量向量化导入（生产）
```bash
cd server
npx tsx src/vector/seed.ts --dry-run     # 仅统计，确认 603 篇待导入
npx tsx src/vector/seed.ts               # 正式写入 Chroma
```
写入两个集合：
- `pattern_knowledge`（574 纹样 + 8 朝代 + 6 技艺 + 15 区域 = **603** 篇）—— RAG 主集合
- `pattern`（仅 574 枚纹样）—— 兼容 `/api/patterns/search`

### 步骤 5 · 沙箱无密钥导入（本环境已实跑）
本环境无 Docker / 无嵌入密钥 / 外网模型下载受限于网络与内存。改用 **本地嵌入桥** 真实跑通整条链路：
```bash
# 1) 起 Chroma（若未起）
/c/Users/88564/.workbuddy/binaries/python/envs/default/Scripts/chroma.exe run --path .chroma --port 8000 --host 0.0.0.0 &

# 2) 起嵌入桥（TF-IDF 兜底后端，轻量不 OOM）
EMBED_BACKEND=tfidf EMBED_PORT=9999 \
  /c/Users/88564/.workbuddy/binaries/python/envs/default/Scripts/python.exe scripts/local_embed_server.py &

# 3) 真实导入 603 条
bash scripts/seed_run.sh          # 或：bash scripts/run_all.sh 跑全流水线
```
> **生产替换真实嵌入**：把步骤 2 的 `EMBED_BACKEND=tfidf` 去掉（默认 `bge`），`EMBEDDING_API_BASE` 指向真实 BGE / 云端点即可。`run_all.sh` 默认 `tfidf` 是为沙箱稳定性；上线时删掉该环境变量即切回 BGE。

### 步骤 6 · 检索验证
```bash
# 生产检索（需 Chroma + 嵌入密钥）
curl -X POST http://localhost:3000/api/ai/chat -d '{"query":"敦煌藻井纹样"}'
# 独立验证（不依赖外网模型）
python scripts/verify_kb_extended.py
```

---

## 三、本环境验证结果（Phase 2，已真实跑通）

| 指标 | 数值 |
| --- | --- |
| seed 写入集合 | `pattern_knowledge` = **603**，`pattern` = **574**（共 1177 次写入，失败 **0**） |
| 嵌入后端 | `local_embed_server` · `EMBED_BACKEND=tfidf`（零依赖中文 TF-IDF，12008 维） |
| 向量库 | Chroma **v2** `http://localhost:8000/api/v2` |
| 检索验证查询数 | **30**（六类：纹样名 8 / 寓意 6 / 朝代 4 / 技艺 4 / 区域 4 / 组合 4） |
| 命中数 / 命中率 | **29 / 96.7%**（验收阈值 ≥ 80%） |
| 平均 top1 相似度 | 0.2643 |
| 平均 top5 相似度 | 0.2098 |
| 未命中 | 1 条（`[朝代] 唐代流行的纹样`，TF-IDF 词面对该措辞区分度不足，top5 未含 `type=dynasty` 或关键词文档） |
| 报错 | **无** |

30 条验证逐条结果见 `scripts/verify_kb_extended.result.json`（含 top5、相似度、命中判定、未命中分析）。

> 相似度绝对值偏低属正常：TF-IDF 为高维稀疏向量，余弦相似度天然偏小；**检索质量以「命中率」衡量**，96.7% 已满足验收。接入真实语义嵌入（BGE / 通义千问）后，跨义近词（如「云纹」↔「流云」）召回会更强，相似度绝对值也会升高。

---

## 四、关键实现说明（避坑）

1. **Chroma v2 以 UUID 寻址集合**：`/query` `/count` `/add` 的路径段是集合 **UUID**，不是 name。本仓库统一在 `vector.service.ts` 与验证脚本中先用 `GET /collections/{name}` 解析出 UUID 再调用——否则直接传 name 会返回 **HTTP 400**。删除集合用 **name**（`DELETE /collections/{name}`）。
2. **嵌入桥与种子同构**：seed 写入与 verify 检索必须走**同一个嵌入后端**，否则余弦距离无意义。`seed_run.sh` 与 `verify_kb_extended.py` 的 `EMBEDDING_API_BASE` / `EMBED_URL` 必须指向同一个 `local_embed_server` 实例（本环境均为 `:9999`）。
3. **BGE 在受限后台进程易 OOM**：BGE 权重 95.8M 已缓存，但沙箱后台子进程加载 torch 跑 603 次推理时易 OOM 崩溃；故沙箱验证切换 `EMBED_BACKEND=tfidf`（纯 Python + math，无 torch 依赖、稳定）。生产环境资源充足，默认 `bge` 即可。
4. **Git Bash 下 curl 发中文 body 会被编成 GBK**，导致服务端 UTF-8 解码 500；验证 / 探测一律用 Python `urllib` 客户端（强制 `encode('utf-8')`）。
5. **会话重启会清空后台进程**：Chroma 与嵌入服务需重新手动拉起（见步骤 5）。

---

## 五、文档切分与元数据规范

- **切分策略**：每枚纹样 / 每个朝代 / 每种技艺 / 每个区域 = 1 个文档（共 603）。
- **纹样文档内容**：纹样名称 / 分类 / 起源朝代 / 流行时期 / 文化寓意 / 形态特征 / 典型应用场景 / 承载技艺。
- **元数据字段**：`id, type, name, category, dynasty, craft[], source, url`（朝代 / 技艺 / 区域另含各自字段）。
- **空列表兜底**：部分纹样 `crafts` 或区域 `crafts/ethnicGroups` 可能为空，导入时统一转为 `["未标注"]`，满足 Chroma「列表元数据不得为空」约束。

---

## 六、已知约束与后续

1. **Phase 2 已在沙箱真实跑通**：`seed.ts` 经本地嵌入桥写入 603 条、0 失败；30 条检索验证命中率 96.7%。此前文档所述「seed.ts 无法实跑」为 Phase 1 阶段结论，现已推翻。
2. **沙箱嵌入为 TF-IDF 兜底**：非真实语义模型，仅用于链路与检索质量验证；生产接入 BGE / 通义千问后，验证脚本将 `EMBEDDING_API_BASE` 指向真实端点即可复用（查询 / 判定逻辑不变）。
3. **RAG 问答接口（`/api/ai/chat` + `/api/ai/search`）已接入并验证通过**：向量检索优先，无 LLM 密钥时自动降级为「演示模式」——仍由真实检索结果构造引用（`url` / `type`），保证「查看详情」指向馆内资料；配置 LLM 密钥后自动切换为真实讲解。详见第七、八节。
4. 574 枚纹样图片、前端展示不在本次范围。

---

## 七、RAG 问答接口（Phase 3，已接入并验证）

### 7.1 接入内容
- `AiController` 新增 `/api/ai/chat`（问答）与 `/api/ai/search`（直接向量检索）两个端点（`/api/ai/chat` 接受 `{ message, context }`，`/api/ai/search` 接受 `{ query, topK }`）。
- `AiService.chat()`：优先调用 `VectorService.search` 对 `pattern_knowledge` 做语义检索（topK=5）；**即使 LLM 不可用，也由真实检索结果构造 `references`（`patternId` / `name` / `url` / `type`）**，确保「查看详情」链接指向馆内资料，而非空引用或泛化 mock。
- `AiService.search()`：供前端检索 / 联想，仅返回真实命中（含 `type` / `url` / `dynasty` / `category`），无命中返回空数组。

### 7.2 三层降级策略
1. **向量库不可用** → `VectorService.isAvailable()` 返回 false，`search` 返回空，service 回退 `mock.retrieveKnowledge` 关键词匹配。
2. **LLM 不可用（无密钥）** → `LlmProvider.chat` 返回 null，service 进入「演示模式」：`demo=true`，回复提示「配置 LLM 密钥后纹宝将为你展开讲解」，引用仍来自真实检索结果。
3. **前端** → `src/api/ai.ts` 的 `chatWithAi` 默认 `USE_MOCK` 走本地 mock；接入后端后展示真实回答与「查看详情」链接，并对演示模式做明显标识。

### 7.3 验收验证（实时调用，5 题全 PASS）
| 问题 | retrieved | refs | demo | 引用纹样示例（真实检索） |
| --- | --- | --- | --- | --- |
| 云纹和雷纹的区别 | 5 | 5 | true | 云雷纹 / 卷云纹 / 火纹（青铜） |
| 苗族蜡染蝴蝶纹的寓意 | 5 | 5 | true | 蝴蝶妈妈纹 / 白族扎染蝴蝶纹 / 蝴蝶纹 |
| 唐代纹样的特点 | 5 | 5 | true | 喜相逢 / 翔凤纹 / 游鳞纹 |
| 龙纹的演变 | 5 | 5 | true | 龙章纹 / 苗族龙纹 / 团龙纹（敦煌） |
| 敦煌藻井纹样 | 5 | 5 | true | 藻井莲花纹 / 藻井三兔纹 / 藻井团花纹 |

- `/api/ai/search?query=敦煌藻井纹样` → 5 条真实命中，`url=/pattern/...`、`type=pattern`、top1 相似度 0.62–0.82。
- 验证脚本：`scripts/verify_rag_live.py`（实时打接口，结论 chat/search 均 PASS）。
- 返回结构示例（`/api/ai/chat`）：
  ```json
  {
    "reply": "（演示模式）馆内资料库已检索到与「敦煌藻井纹样」相关的纹样：藻井莲花纹、藻井三兔纹、藻井团花纹……可点击「查看详情」深入了解。",
    "references": [ { "patternId": "P-D13", "name": "藻井莲花纹", "url": "/pattern/D13", "type": "pattern" } ],
    "suggestions": [ ... ],
    "demo": true,
    "source": "mock",
    "retrieved": 5
  }
  ```

---

## 八、真实嵌入对比（TF-IDF vs BGE）

同 30 条查询（六类：纹样名 / 寓意 / 朝代 / 技艺 / 区域 / 组合）对比，详见 `scripts/embed_comparison.result.json`（生成于 2026-10-17）。seed / verify 走同一嵌入后端以保证余弦距离可比。

| 指标 | TF-IDF（沙箱兜底） | BGE-small-zh-v1.5 |
| --- | --- | --- |
| 向量维度 | 12008 | 512 |
| 命中数 / 命中率 | 29 / **96.7%** | 28 / **93.3%** |
| 平均 top1 相似度 | 0.2643 | **0.6552**（≈ 2.5×） |
| 平均 top5 相似度 | 0.2098 | 0.6328 |
| 未命中 | 唐代流行的纹样 | 唐代流行的纹样 / 云南民族的纹样 |

**结论**：两者均 ≥ 80% 验收阈值。
- **TF-IDF**：零依赖、轻量、沙箱稳定，命中率略高（高维稀疏向量余弦相似度天然偏低，检索质量以命中率衡量）。
- **BGE**：首位相关度与置信度显著更高（top1 相似度约 2.5 倍），跨义近词（如「云纹」↔「流云」）召回更强，接入真实 LLM 时能提供更精准上下文、回答质量更优。
- **沙箱默认 `EMBED_BACKEND=tfidf`**；生产资源充足时去掉该环境变量即切回 BGE（`run_all.sh` 注释已说明）。当前 Chroma 中以 TF-IDF 向量为准，与 `run_all.sh` 一致。
