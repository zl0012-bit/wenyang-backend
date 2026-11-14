# 联调预案 · 纹以载道 RAG + ReAct

> 用途：前端改完、后台打标跑完后，按本表逐项验收。
> 所有后端命令均使用 venv：`/tmp/ragvenv/bin/python`（系统 `python3.11` 缺 SDK，会静默降级为 mock，务必用 venv）。

## 0. 后台打标结果摘要（已自动完成 · 2026-10-21 15:27）

- 打标总数 **574**，成功 **547**，**成功率 95.3%**，失败 27（GLM-4V 输出未过 schema 校验，回退 `meaning_short`）
- `meaning_rich` 平均 **167 字**（最短 93 / 最长 300），**空值率 0.0%**，低置信度 0 条
- 向量库 `chroma_db`：**574 条，embed_mode=real**（确认用真实 embedding-3 重建，非本地哈希）
- 实测检索「明清龙纹」Top3 的 `meaning_rich` 均为 150+ 字扩写文本 → **重建生效、扩写生效**

---

## 一、后台打标验收

### 1) 确认索引重建成功（三步验收）

```bash
cd /workspace/rag

# ① 确认向量库用真实 embedding、且 574 条齐全
/tmp/ragvenv/bin/python -c "import chromadb; c=chromadb.PersistentClient(path='chroma_db'); col=c.get_collection('wenyang_patterns'); print('count=', col.count(), '| mode=', col.metadata.get('embed_mode'))"
# 期望：count=574  mode=real

# ② 确认 meaning_rich 已写入（扩写文本生效，而非空）
/tmp/ragvenv/bin/python test_retrieval_quality.py "明清龙纹"
# 期望：每条显示「扩写后 meaning_rich (1xx 字)」

# ③ 端到端：通过真实接口验证
curl -s -X POST http://127.0.0.1:8000/api/agent_chat \
  -H 'Content-Type: application/json' \
  -d '{"user_input":"明清红色纹样","current_page":"纹样宝库","has_image":false}' \
  | /tmp/ragvenv/bin/python -m json.tool
# 期望：HTTP 200，含 intent / sources / answer，answer 是真实生成（非"离线模式"兜底）
```

### 2) 断点续跑 / 中断恢复

脚本逻辑：`done_ids()` 只把 `_ok:true` 的 pattern 记为已完成，**`_ok:false` 的失败条不计入 done**，因此重跑会**自动跳过已成功的 547 条、重试失败的 27 条**。

```bash
cd /workspace/rag

# 若进程中途被 kill / 断网：直接重跑同一条命令即可续跑（已成功跳过，只补 27 条失败）
nohup /tmp/ragvenv/bin/python glm4v_batch_labeling.py > labeling_resume.log 2>&1 &

# 补跑完成后，重新 merge + 重建索引（rebuild_index.py 永远全量重算，强制真实向量）
/tmp/ragvenv/bin/python glm4v_batch_labeling.py merge
/tmp/ragvenv/bin/python rebuild_index.py --auto-merge

# 最后刷新质检报告
/tmp/ragvenv/bin/python quality_report.py
```

> 说明：当前 27 条失败是 GLM-4V 输出未过 schema 校验（色板需 3-8 个合法 HEX / 母题需 2-10 个），重试有概率通过；即便仍失败，也只是回退到原 `meaning_short`，不影响检索可用。若想把成功率拉到 100%，可再加固 JSON 解析（容错抽取合法 HEX / 母题），需要的话告诉我。

---

## 二、联调测试用例表（项目演示级）

### A. 文本确定性链路（默认 `mode=default`，走 `run_agent`）

| # | 用户输入 | 预期意图 | 预期行为 / 验收点 |
|---|---|---|---|
| A1 | 明清的红色纹样有哪些 | qa | `sources≥1`，命中明清主题纹样；`answer` 引用检索资料，非编造 |
| A2 | 对比明清和宋代龙纹的区别 | comparison | 同时召回明清 + 宋代龙纹；`answer` 做对比陈述 |
| A3 | 缠枝莲有什么文化寓意 | qa | 命中缠枝莲；`answer` 含"连绵不绝/清廉"等寓意 |
| A4 | 苗族纹样有什么特色 | qa | 命中少数民族纹样；`answer` 结合民族特色 |

### B. 带图视觉链路（AI 共创 / 纹样再设计）

| # | 操作 | 预期意图 | 预期行为 / 验收点 |
|---|---|---|---|
| B1 | 上传纹样图 + "分析这张纹样的配色" | redesign | `tool_results.vision.extract_color` 返回主色板（hex+占比）；`answer` 描述主色调 |
| B2 | 上传图 + "帮我做现代海报分层" | redesign | `segment_pattern` 返回图层数量+bbox；`answer` 提及图层切分可用于再设计 |
| B3 | 仅文字"帮我校色"无图 | redesign | `answer` 提示"请上传一张纹样图片" |

### C. ReAct 多轮决策（`mode=react`，走 `run_agent_react`）

| # | 用户输入 | 预期 | 验收点 |
|---|---|---|---|
| C1 | 帮我找一些特别有吉祥寓意的古老纹样，不要近现代的 | qa → 多步 | 首次 `rag_search` 相似度可能偏低（<0.55）→ 触发 `reformulate_query` 换词重试（重写提示词会强制注入「汉/唐/宋/魏晋」等朝代实体）→ 二次检索 → **全程最佳命中 <0.62 时，回答以「虽然未找到完全精准匹配的，但以下是契合吉祥寓意的古老纹样……」温和兜底**（不再返回冰冷提示）；**后端日志出现 `[ReAct] 换词重试`、`重写注入朝代限定`、`早期结束但最佳命中偏低…改用温和兜底合成`** |
| C2 | 明清龙纹和宋代龙纹有什么区别 | comparison → 多步 | 多轮检索 + 对比合成；`tool_results.react_trace` 有完整「思考/工具/观察」轨迹 |
| C3 | 上传图 + "它和哪些传统纹样风格接近" | redesign/qa 混合 | 视觉分析 + 检索交叉论证 |

> 触发 reformulate 的判定：在 `rag_search` 工具执行后，若命中最高 `similarity_score < 0.65` 且尚未 reformulate 过，自动换词重试。阈值常量 `REFORMULATE_THRESHOLD = 0.65`（位于 `agent_router.py`）。

---

## 三、前端改完第一步自测

### 方式一：浏览器控制台直接打接口（最直观）

在已启动 Vite 前端页面按 **F12 → Console**，粘贴：

```js
fetch('/api/agent_chat', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({user_input:'明清红色纹样', current_page:'纹样宝库', has_image:false})
}).then(r => r.json()).then(d => {
  console.log('intent =', d.intent);
  console.log('sources =', (d.sources||[]).length);
  console.log('answer =', (d.answer||'').slice(0,80));
  console.log('完整返回 =', d);
});
```

- 期望：控制台打印 `intent / sources / answer`，且 `answer` 是真实中文解读（非"离线模式"兜底）。
- 因为用了 Vite proxy，`/api` 被转发到 `127.0.0.1:8000`，页面与接口**同源，无需 CORS**。

### 方式二：F12 Network 面板核对（字段匹配）

1. 触发一次提问，在 Network 找到 `agent_chat` 请求：
   - 请求 URL = `http://localhost:5173/api/agent_chat`（同源，经 Vite 代理）；**不应出现** `open.bigmodel.cn` / `api.zhipuai.com`（证明 Key 已不在前端）。
   - Request Payload 字段 = `user_input` / `current_page` / `has_image`（与 `main.py` 解析字段一致）。
2. 响应 200，Preview 里能看到 `intent / confidence / reason / answer / tool_results / sources` 六个字段。
3. 切到 ReAct：把 body 里加 `mode:'react'` 再发一次，后端日志应出现 `[ReAct]` 多轮轨迹，响应多一个 `mode:"react"` 与 `tool_results.react_trace`。

### 必备前提

- 后端已起：`./start.sh`（会自动校验 `MODE=real` 才放行，否则拒绝启动）。
- 验证后端存活：`curl -s http://127.0.0.1:8000/health` → `{"status":"ok"}`。
