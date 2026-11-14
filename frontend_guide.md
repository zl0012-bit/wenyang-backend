# 前端改造指南：从「直连智谱」改为「走后端 Agent 调度」

> 目标：把前端原来直接打智谱 API 的请求**拦截**到本地 FastAPI `/api/agent_chat`，
> 由后端统一做 意图分类 → RAG 检索 / 视觉分析 → GLM-4-Flash 生成。
> 采用「先文本、后图片」联调策略：接口同时兼容 JSON（纯文本）与 FormData（带图）。

---

## 0. 前置：后端先跑起来

```bash
cd rag
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
# 健康检查： curl http://localhost:8000/health
```

前端开发服务器（Vite 默认 5173 / Webpack 默认 3000）与后端 8000 跨端口，
已在 `main.py` 配好 `CORSMiddleware(allow_origins=["*"])`，**无需前端再配代理**也能联调。
（生产环境请把 `allow_origins` 收紧为你的域名。）

---

## 1. 原来是怎么直连智谱的（要替换掉的代码）

```ts
// ❌ 旧：前端直接持有 Key，直连智谱
const ZHIPU_API_KEY = "sk-xxxxxxxxxxxx"; // ← 硬编码，危险！

async function askZhipu(prompt: string) {
  const resp = await fetch(
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ZHIPU_API_KEY}`, // ← Key 暴露在浏览器
      },
      body: JSON.stringify({
        model: "glm-4-flash",
        messages: [{ role: "user", content: prompt }],
      }),
    }
  );
  const data = await resp.json();
  return data.choices[0].message.content;
}
```

**问题**：`ZHIPU_API_KEY` 出现在浏览器源码/网络面板里，任何人都能扒走刷爆你的额度。

---

## 2. 改成请求本地后端 `/api/agent_chat`

```ts
// ✅ 新：只认后端，Key 留在后端
const AGENT_API = "http://localhost:8000/api/agent_chat";

type AgentResp = {
  intent: "qa" | "redesign" | "comparison" | "other";
  confidence: number;
  reason?: string;
  answer: string;
  tool_results: any;
  sources: Array<{
    pattern_id: string; name: string; theme: string;
    origin_std: string; category_group: string; score: number;
  }>;
};
```

---

## 3-a. 纯文本对话（JSON）

```ts
async function sendText(userInput: string, currentPage: string) {
  const resp = await fetch(AGENT_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_input: userInput,
      current_page: currentPage,   // 例：首页 / 纹样宝库 / 朝代长廊 / 非遗技艺馆 / AI共创
      has_image: false,
    }),
  });
  return (await resp.json()) as AgentResp;
}
```

---

## 3-b. 带图片上传（FormData）

```ts
async function sendWithImage(userInput: string, currentPage: string, file: File) {
  const form = new FormData();
  form.append("user_input", userInput);     // 例如“分析这张纹样的配色”
  form.append("current_page", currentPage);  // 例如 “AI共创”
  form.append("image", file);               // <input type="file"> 拿到的 File
  // ⚠️ 不要手动设置 Content-Type，浏览器会自动带 boundary

  const resp = await fetch(AGENT_API, { method: "POST", body: form });
  return (await resp.json()) as AgentResp;
}
```

> 后端会自动：存图到 `rag/uploads/` → 调视觉工具链 → 返回后**删除临时图**。

---

## 4. 解析后端 JSON 并渲染

```tsx
function render(resp: AgentResp) {
  // 4.1 意图徽标
  const intentLabel: Record<string, string> = {
    qa: "文博问答", redesign: "纹样再设计", comparison: "对比考据", other: "通用对话",
  };

  // 4.2 文本回答
  <p>{resp.answer}</p>

  // 4.3 检索来源（qa / comparison 才有）
  {resp.sources?.map(s => (
    <li key={s.pattern_id}>
      {s.name} · {s.origin_std} · {s.theme} · 相似度 {s.score}
    </li>
  ))}

  // 4.4 色块渲染（redesign 的视觉结果才有）
  {resp.tool_results?.vision?.extract_color?.palette?.map(c => (
    <span
      key={c.hex}
      style={{
        display: "inline-block", width: 48, height: 48,
        background: c.hex, marginRight: 8,
        title: `${c.hex} 占比${Math.round(c.ratio * 100)}%`,
      }}
    />
  ))}
}
```

`redesign` 时 `tool_results.vision` 形如：
```json
{
  "extract_color": { "dominant": "#9D2933", "palette": [ {"hex":"#9D2933","rgb":[157,41,51],"ratio":0.42}, ... ] },
  "segment_pattern": { "num_components": 7, "layers": [ {"label":1,"bbox":[10,20,90,80],"area":...,"area_ratio":0.07}, ... ] }
}
```

---

## 5. 安全提醒（必做）

1. **删除前端硬编码的智谱 Key**：全项目搜 `sk-` / `ZHIPU_API_KEY` / `Authorization: Bearer`，一律移除。
2. **Key 只在后端**：`.env` 里 `ZHIPU_API_KEY=sk-xxx`，后端 `zhipu_client.py` 从环境变量读取，绝不出现在响应里。
3. **前端只调 `/api/agent_chat`**，不要留任何直达 `open.bigmodel.cn` 的 fetch。
4. **生产收紧 CORS**：`allow_origins` 改为你的前端域名白名单；本地联调用 `*` 即可。
5. **可选加固**：后端对 `user_input` 做长度/敏感词限制，对上传图片做类型与大小校验（`image_path` 仅接受图片 MIME）。

---

## 6. 联调顺序建议（先文本、后图片）

1. `curl` 纯文本 JSON → 确认意图分类 + RAG 检索 + 回答。
2. 浏览器跑 `sendText` → 确认前端渲染。
3. 上传一张纹样图走 `sendWithImage` → 确认 `tool_results.vision` 返回 + 色块渲染。
4. 配好 `ZHIPU_API_KEY` 后复跑，验证真实自然语言回答。
