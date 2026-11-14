# 智谱 API Key 迁移指南：前端 → 后端（安全解耦）

> 目标：前端**彻底不持有**智谱 Key，所有大模型调用经本地 FastAPI `/api/agent_chat` 由后端代理。
> 配套改动：`zhipu_client.py`/`main.py` 已加 `python-dotenv` 自动加载、`requirements.txt` 已加依赖、新增 `.env.example` 与 `.gitignore`。

---

## 一、后端 Key 标准化配置

### 1.1 `.env` 模板（已生成 `.env.example`）

```dotenv
# cp .env.example .env  然后把占位符换成真实 Key
ZHIPU_API_KEY=your_zhipu_api_key_here
# ZHIPU_EMBEDDING_MODEL=embedding-3
# ZHIPU_CHAT_MODEL=glm-4-flash
```

- 文件放在 `rag/.env`（与 `main.py` 同目录）。
- **绝不在 `.env` 里写任何前端用得到的变量**，它只给后端用。
- `zhipu_client.py` 顶部已 `load_dotenv(本目录/.env)`，`main.py` 启动也加载一次；无需再 `export`。

### 1.2 启动日志自查

起服后看控制台首行：
```
INFO 智谱 Key 状态: real（real=已接入智谱大模型，mock=离线兜底）
```
若是 `mock`，说明 `.env` 没读到或 Key 为空——检查 `.env` 路径/内容。

### 1.3 `requirements.txt` 新增依赖

```
python-dotenv==1.2.4
```
安装：`pip install -r requirements.txt`（已含）。

---

## 二、前端旧 Key 的「精准定位与清理」

### 2.1 搜哪些关键字最快定位（全局搜整个前端工程）

在编辑器 / 终端里对前端目录检索以下关键字（大小写都看）：

| 关键字 | 命中大概率是什么 |
|---|---|
| `ZHIPU` / `zhipu` / `bigmodel` | 智谱相关常量/地址 |
| `open.bigmodel.cn` / `bigmodel.cn/api` | **直连智谱 API 的地址**（核心替换点） |
| `Authorization` + `Bearer` | 把 Key 塞进请求头的地方 |
| `apiKey` / `api_key` / `API_KEY` / `apiToken` | Key 变量定义 |
| `localStorage` / `sessionStorage` | 是否把 Key 持久化到了浏览器存储 |
| `ZhipuAI(` / `zhipuai.` | 前端直接 import SDK 调用 |
| `.env` 文件里的 `VITE_` / `VUE_` / `NEXT_PUBLIC_` 前缀变量 | 框架会把带前缀的 env 注入前端，含 Key 即泄漏 |

> Vite/Next 等会把 **`VITE_` / `NEXT_PUBLIC_`** 前缀的环境变量打包进前端代码——哪怕写在 `.env`，只要带这些前缀就等于公开。务必确认前端 `.env` 里**没有**这类前缀的智谱 Key。

### 2.2 若之前用 `localStorage` 存过 Key，前端一键清除

先在浏览器 **F12 → Application → Local Storage** 看键名（常见 `zhipuKey`/`apiKey`/`ZHIPU_API_KEY`/`glmKey`），然后在代码里或控制台执行：

```js
// 精准清除已知键名
['zhipuKey','apiKey','ZHIPU_API_KEY','glmKey','aiKey'].forEach(k => localStorage.removeItem(k));

// 或用正则批量清掉所有疑似 Key（在上线前跑一次即可）
Object.keys(localStorage)
  .filter(k => /key|token|zhipu|glm|api/i.test(k))
  .forEach(k => localStorage.removeItem(k));

console.log('剩余 localStorage:', Object.keys(localStorage));
```

> 仅清前端不够——**同时去后端/部署平台把那个旧 Key 吊销并重新生成**，旧 Key 一旦泄露过就有被盗刷风险。

### 2.3 修改前 vs 修改后（前端请求对比）

**❌ 修改前：前端直连智谱，Key 暴露**
```js
// 危险：Key 写死在前端，任何人打开 DevTools → Sources/Network 都能看到
const res = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + "ZM8xxxxx你的Key",  // ← 暴露!
  },
  body: JSON.stringify({ model: "glm-4-flash", messages: [{role:"user", content: input}] }),
});
const data = await res.json();
renderText(data.choices[0].message.content);
```

**✅ 修改后：前端只发用户输入给本地后端，不带任何 Key**
```js
// 安全：Key 只在后端 .env，前端只传用户输入
const res = await fetch("http://localhost:8000/api/agent_chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },          // ← 没有 Authorization
  body: JSON.stringify({
    user_input: input,            // 仅用户文本
    current_page: "AI共创",       // 仅上下文标签
    has_image: false,
  }),
});
const data = await res.json();    // { intent, answer, tool_results, sources }
renderText(data.answer);          // 直接用后端返回的 answer
// 若后端返回了视觉结果，再渲染色块：
// data.tool_results?.vision?.extract_color?.palette
```

带图场景见 `frontend_guide.md` 第 3 节（用 `FormData` 上传，依然**不含任何 Key**）。

> 完成后用 §三 的 F12 方法验证：**前端发出的请求里既无 `Authorization` 头、也无 `open.bigmodel.cn` 的 URL**。

---

## 三、验证「前后端解耦」成功（浏览器 F12 网络面板）

核心命题：证明「前端不再带 Key 直连智谱」，且「后端真正接管了与智谱的通信」。

### 步骤
1. 打开前端页面 → **F12 → Network**，勾选「Preserve log」。
2. 发一条消息（如「明清的红色纹样有什么」）。
3. 在 Network 列表里找前端发出的请求，逐个核对：
   - **URL 不应出现 `open.bigmodel.cn`** —— 只有 `localhost:8000/api/agent_chat`（或你的后端域名）。
   - 点开该请求 → **Headers → Request Headers**：不应有 `Authorization`；只有 `Content-Type` 等普通头。
   - 点 **Payload**：只有 `user_input` / `current_page` 等，**不应含任何 Key 字符串**（可 Cmd/Ctrl+F 搜 `Bearer`/`ZM`/`key` 应为 0 命中）。
4. 看**后端**是否真的调了智谱（二选一）：
   - 后端控制台应打印 `智谱 Key 状态: real`；
   - 或在后端加一行 debug 日志（临时）：`logger.info("calling zhipu embed/chat, key=%s***", API_KEY[:4])`，确认 Key 来自后端且只对智谱发请求。
5. 确认响应正常：`/api/agent_chat` 返回 200 且 `answer` 有内容 → 说明「用户请求 → 后端 → 智谱 → 后端 → 前端」链路通了，而**智谱的 Key 全程只存在于后端进程内存**。

### 一句话判定
> **前端 Network 里看不到 `Authorization`、看不到 `bigmodel.cn`；后端日志里能看到 `real` 且能拿到智谱返回** → 解耦成功，Key 已安全迁移到后端。

---

## 四、收尾 checklist
- [ ] 后端 `rag/.env` 已填真实 Key，`cp .env.example .env` 的占位符已替换
- [ ] `requirements.txt` 已 `pip install`（含 python-dotenv）
- [ ] 前端全工程搜 `open.bigmodel.cn` / `Bearer` / `ZHIPU` → **0 命中**
- [ ] 前端 `localStorage` 旧 Key 已清除 + **旧 Key 在智谱后台已吊销重生**
- [ ] 前端 `.env` 里无 `VITE_`/`NEXT_PUBLIC_` 前缀的智谱变量
- [ ] `rag/.gitignore` 已忽略 `.env`（防误提交）
- [ ] F12 验证通过（见 §三）
