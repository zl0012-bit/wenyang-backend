# 前端改造最终自检清单（Checklist）

> 目标：确认前端**已彻底删除硬编码的智谱 Key**，所有 AI 请求**只发往本地 FastAPI（端口 8000）**，
> 且纯文本 / 传图两种模式都能正常联调。
> 后端已就绪：`start.sh` 启动后监听 `0.0.0.0:8000`，CORS `allow_origins=["*"]`。

---

## 一、F12 Network 面板验证（最关键）

1. 打开浏览器 **F12 → Network 面板 → 勾选「Preserve log」→ 过滤选 `Fetch/XHR`**。
2. 在前端触发一次 AI 请求（纯文本问答 / 上传图片再设计都试一次）。
3. 逐条核对每条请求，必须满足以下全部条件：

| 检查项 | 期望结果 | 不合格信号 |
|---|---|---|
| 请求 URL | 仅 `http://127.0.0.1:8000/api/agent_chat` | 出现 `open.bigmodel.cn` / `api.zhipuai.com` / `ZhipuAI` 域名 |
| Request Headers | 无 `Authorization: Bearer <长串>`（除非那是你后端自己的鉴权，且值≠智谱 Key） | 出现 `Authorization: Bearer ZM...` 或真实的智谱 Key |
| Request Payload / Form Data | 无 `api_key` / `ZHIPU_API_KEY` / `Bearer` 字段 | body 里带 key 明文 |
| Response | 来自 `localhost:8000`，HTTP 200 | 502/跨域报错，或响应来自第三方域名 |

4. **源码静态扫描**（在 frontend 项目根目录执行，应无命中或仅残留你自己的后端地址）：
   ```bash
   grep -rniE "ZHIPU|open\.bigmodel\.cn|ZhipuAI\(|Authorization|Bearer|apiKey|VITE_ZHIPU|NEXT_PUBLIC_ZHIPU" src/ 2>/dev/null
   ```
5. **localStorage / SessionStorage 清理**（避免旧 Key 残留被读取）：
   - F12 → Application → Local Storage / Session Storage
   - 搜索 `zhipu` / `api_key` / `token`，**删除一切残留**
   - 或一键清空（控制台）：`localStorage.clear(); sessionStorage.clear();`

---

## 二、接口地址：127.0.0.1 还是 localhost？

**结论：前端统一写 `http://127.0.0.1:8000/api/agent_chat`。**

- `127.0.0.1` 是 IPv4 回环地址，指向确定；`localhost` 在部分系统会优先解析为 IPv6 `::1`。
  后端 `start.sh` 已用 `--host 0.0.0.0`（IPv4 全网卡），两者本地实测都能连，但 `127.0.0.1` 最稳、最不容易踩 IPv6 坑。
- 不要把 Key 写进前端任何常量；所有调用都走 `/api/agent_chat`，由后端持有 Key。

### 跨域（CORS）注意事项
- 当前 `main.py` 配的是 `allow_origins=["*"]` + `allow_credentials=True`：
  - **本地开发能通**（Vite 默认 `http://localhost:5173` 跨域请求 `127.0.0.1:8000` 已被放行）。
  - ⚠️ **生产环境必须收紧**：把 `allow_origins` 改成你的前端真实域名；若前端不依赖 cookie 鉴权，把 `allow_credentials` 设为 `False`——`"*"+credentials` 是安全隐患。
- **推荐（最干净，免 CORS）**：Vite 开发期用 proxy，前端只写相对路径：
  ```ts
  // vite.config.ts
  export default defineConfig({
    server: {
      proxy: { '/api': 'http://127.0.0.1:8000' }
    }
  })
  ```
  前端请求写 `/api/agent_chat` 即可，浏览器视为同源，无需后端开 CORS。

### 局域网 / 多设备联调
- 后端已绑 `0.0.0.0`，可用本机局域网 IP 访问，如 `http://192.168.x.x:8000/api/agent_chat`（前端接口地址同步改成该 IP）。
- ⚠️ **混合内容限制**：若前端页面是 `https://`，浏览器会**拦截**向 `http://` API 的请求（mixed content）。
  解决：前端也走 http，或给后端配 HTTPS / 反代（如 Nginx + 证书）。

---

## 三、功能联调 Checklist

- [ ] 纯文本问答：输入「明清红色纹样」→ 返回含 `intent / answer / sources` 的 JSON，`sources` 有 5 条。
- [ ] 传图再设计：上传 `.webp` → 返回 `tool_results.vision`（主色板 + 图层切分），`answer` 有解读。
- [ ] F12 确认两次请求 URL 都是 `127.0.0.1:8000/api/agent_chat`，**无任何智谱域名/Key 泄露**。
- [ ] 后端日志（`tail -f labeling_pipeline.log` 之外的运行日志）出现 `open.bigmodel.cn ... 200 OK`，说明**只有后端在和智谱通信**。
- [ ] 偶发网络抖动时前端不 500（后端已做 try/except 降级兜底）。

---

## 四、问题速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 前端 `ERR_CONNECTION_REFUSED` | 后端没起 / 端口不对 | 跑 `./start.sh`，确认 `Uvicorn running on 0.0.0.0:8000` |
| 跨域报错 CORS | 前端域不在 `allow_origins` | 临时加域到 `allow_origins`，或用 Vite proxy |
| 请求仍打到 `open.bigmodel.cn` | 前端某处残留直连 Key 的代码 | 回到「一、5」的 grep，搜 `bigmodel` 全量清理 |
| 后端 `mock` 模式（无真实召回） | `.env` 的 Key 未生效 | `cd /workspace/rag && /tmp/ragvenv/bin/python -c "import zhipu_client as z; print(z.MODE)"` 应为 `real` |
