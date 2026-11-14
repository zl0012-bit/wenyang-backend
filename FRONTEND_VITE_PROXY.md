# 前端 Vite 代理配置（免跨域联调后端）

> 本沙箱里的 `index.html` / `server.js` / `assets/` 是**已构建的部署产物**，
> 没有 Vite 源码树。下面的代码请放到**你自己前端仓库**的 `vite.config.ts` 中。

## 一、`vite.config.ts`：把 `/api` 代理到本地 FastAPI（8000）

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'   // 若是 React/其他框架，换成对应插件即可

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // 所有 /api 开头的请求，由 Vite 开发服务器转发到后端 8000，
      // 浏览器只和 5173 同源通信 → 天然免 CORS。
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,   // 关键：改写 Host 头，后端看到的来源即为 127.0.0.1:8000
        // rewrite: (p) => p,  // 前后端路径一致（都是 /api/...），无需改写
      },
    },
  },
})
```

**要点**
- `changeOrigin: true` 必加，否则部分后端框架会因 Host 头不匹配拒绝。
- 用 `127.0.0.1` 而非 `localhost`，避免 IPv6 `::1` 解析坑。
- 启用后，**前端再也不写后端绝对地址**，只写相对路径 `/api/...`。

## 二、前端 `fetch` 怎么写（配合代理）

### 1) 纯文本问答（默认确定性链路）

```ts
const res = await fetch('/api/agent_chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    user_input: '帮我找找明清的红色纹样',
    current_page: '纹样宝库',
    has_image: false,
    // mode 不传或传 "default" → 走原确定性链路；传 "react" → 走 ReAct 多轮
  }),
})
const data = await res.json()
console.log(data.answer, data.sources)
```

### 2) 纯文本问答（显式走 ReAct 链路，联调时验证用）

```ts
const res = await fetch('/api/agent_chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    user_input: '明清龙纹和宋代龙纹有什么讲究',
    current_page: '朝代长廊',
    has_image: false,
    mode: 'react',        // ← 仅此处不同
  }),
})
const data = await res.json()
// data.tool_results.react_trace 是每一步的「思考/工具/观察」轨迹，方便你核对多轮决策
```

### 3) 带图片（纹样再设计 / AI 共创）

```ts
const fd = new FormData()
fd.append('user_input', '分析这张纹样的配色，并给出再设计方案')
fd.append('current_page', 'AI共创')
fd.append('image', file)          // <input type="file"> 拿到的 File 对象
// fd.append('mode', 'react')      // 需要多轮自主决策时再加这行

const res = await fetch('/api/agent_chat', { method: 'POST', body: fd })
const data = await res.json()
```

## 三、联调注意

| 场景 | 建议 |
|------|------|
| 本地开发 | 用上面代理即可，**后端 CORS 可保持 `allow_origins=["*"]`**，但最干净是**关闭对前端的 CORS 依赖**（代理已免跨域）。 |
| 生产部署 | 用 nginx 反代 `/api` 到 `127.0.0.1:8000`，**收紧 CORS 到具体域名**，并视情况关掉 `allow_credentials`。 |
| 局域网真机调试 | 手机/其他设备访问你电脑 IP（如 `http://192.168.x.x:5173`），后端仍走 `127.0.0.1:8000`（本机内部）。注意 HTTPS 页面不能调 HTTP API（mixed content），真机调试建议用 http。 |
| 后端没开 | 访问 `/api/...` 会 502/连接拒绝，检查 `./start.sh` 是否启动、端口 8000 是否监听。 |
