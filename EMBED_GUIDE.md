# 前端组件嵌入指南（保姆级）

> 配套文件：`ai-chat.html`（原生 HTML+JS，独立可用）、`AiChat.vue`（Vue3 组件版）。
> 后端接口统一为 `POST /api/agent_chat`，字段：`user_input` / `current_page` / `has_image` / `image`(文件) / `mode`(可选：default|react)。

## 〇、⚠️ 先处理一个安全隐患（重要）

我在你沙箱的部署产物里发现**第二个硬编码的旧智谱 Key**：

- 文件：`assets/copilot/ai_glm.js`
- 第 21-22 行：`baseURL: 'https://open.bigmodel.cn/api/paas/v4/'` 和一个写死的 `apiKey: 'd5b8fbf4****KLDxIKne9xLlmHnV'`
- 第 103-107 行：直接 `fetch(url, { headers: { 'Authorization': 'Bearer ' + cfg.apiKey } })`

这个 Key **不是**你这次吊销并重发的那个（`5d4dec4e…`），是**另一枚泄漏的旧 Key**。请务必也去智谱控制台把它吊销，否则它仍在冒被盗刷风险。

---

## 一、不配 Vite Proxy，直接写 `http://127.0.0.1:8000/api/agent_chat` 会怎样？

**结论：本地开发能用，但生产 HTTPS 站点会失败，且生产 CORS 配置不安全。**

| 场景 | 结果 | 原因 |
|------|------|------|
| 本地：页面 `http://localhost:5173` → 后端 `http://127.0.0.1:8000` | ✅ 可用 | 两端都是 http 同机；FastAPI `allow_origins=["*"]` 放行了跨域读取 |
| 直接双击打开 `ai-chat.html`（`file://`）→ 后端 `http://127.0.0.1:8000` | ✅ 可用 | `file://` 源为 `null`，`*` 同样放行 |
| **生产：HTTPS 页面（如你的 `*.workbuddy.host`）→ 后端 `http://127.0.0.1:8000`** | ❌ 失败 | **Mixed Content**：浏览器禁止 HTTPS 页请求 HTTP 接口 |
| 生产用上面这种 `*` + `allow_credentials=True` | ⚠️ 不安全 | 任何网站都能调你的后端、烧你的 Key |

> 所以「只要 FastAPI 允许了 CORS 就没问题」**只对本地 HTTP 成立**。生产必须：① 收紧 CORS 到具体域名；② 用 nginx 反代 `/api` 到 8000（HTTPS 同域，免 mixed content）。

**最干净的本地方案**还是 Vite proxy（见 `FRONTEND_VITE_PROXY.md`）：把组件里的 `API_BASE` 改成 `''`，请求走同源 `/api/...`，连 CORS 都不用管。

---

## 二、你的旧代码在哪里（要删的就是它）

在沙箱部署产物中，旧直连逻辑集中在：

- `assets/copilot/ai_glm.js` —— **真正的"直连智谱"实现**（含硬编码 Key、baseURL、Bearer fetch）。
- `assets/copilot/ai-copilot.js` —— 调用上面模块的对话 UI 组件（Vue 组件）。
- `assets/index-CmHYjBy8.js` / `assets/vendor-*.js` —— 打包后的引用（无需手动改）。

> 这些是**构建后的压缩产物**（文件名带 hash）。你在自己源码仓库里对应的文件，用下面关键字全局搜就能定位：
> `open.bigmodel.cn` · `zhipuai` · `ZHIPU` · `Bearer` · `api_key` · `apiKey` · `new ZhipuAI`

你源码里通常会看到类似：
```js
// ❌ 旧：直连智谱（要删/改）
const cfg = { baseURL: 'https://open.bigmodel.cn/api/paas/v4/', apiKey: '写死的Key' };
const r = await fetch(cfg.baseURL + '/chat/completions', {
  headers: { 'Authorization': 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'glm-4-flash', messages: [...] })
});
```

---

## 三、三种"粘贴即用"方案（任选其一）

### 方案 A：直接用独立 HTML（最少改动，推荐先验证）
1. 把 `ai-chat.html` 丢到任意可访问路径（或本地直接双击打开）。
2. 确认后端已起：`./start.sh`（会校验 `MODE=real` 才放行）。
3. 打开页面即可对话 / 传图。**完全不碰你现有工程**。

### 方案 B：嵌入现有 Vue 工程（替换旧 copilot 组件）
1. 把 `AiChat.vue` 放进 `src/components/`。
2. 在"AI共创 / 对话"页面：
   ```vue
   <script setup>
   import AiChat from '@/components/AiChat.vue'   // 替换原来的 AiCopilot
   </script>
   <template>
     <AiChat />                                   <!-- 替换原来的 <AiCopilot /> -->
   </template>
   ```
3. 删掉原来页面里 `import ... ai_glm` / `new ZhipuAI(...)` / 直连 `fetch` 的那几行。
4. 若已配 Vite proxy，把 `AiChat.vue` 顶部 `API_BASE` 改成 `''`。

### 方案 C：嵌入现有 HTML 页面
1. 把 `ai-chat.html` 里的 `<style>` 内容贴进你的页面 `<head>`。
2. 把 `<body>` 里的 `.chat` 结构 + `<script>` 贴进页面对应位置。
3. 删掉页面里原来请求智谱的那段 `<script>`。

### React 版（如果你用的是 React，替换成这个组件）
```jsx
// AiChat.jsx —— 依赖同套后端接口，逻辑与上方一致
import { useState, useRef } from 'react';
const API_BASE = 'http://127.0.0.1:8000';
export default function AiChat() {
  const [messages, setMessages] = useState([{ side:'bot', type:'text', text:'你好，我是纹以载道 AI 导览。' }]);
  const [text, setText] = useState(''); const [img, setImg] = useState(null);
  const [loading, setLoading] = useState(false); const [react, setReact] = useState(false);
  const fileRef = useRef(null);
  const send = async () => {
    if (loading) return; const t = text.trim(); const hasImg = !!img;
    if (!t && !hasImg) return;
    setMessages(m => [...m, { side:'user', type:'text', text: (t?t+'\n':'')+(hasImg?'🖼 [图片]':'') }]);
    setText(''); setLoading(true); const mode = react ? 'react' : 'default';
    try {
      let data;
      if (hasImg) {
        const fd = new FormData();
        fd.append('user_input', t || '请分析这张纹样的配色与结构');
        fd.append('current_page', 'AI共创'); fd.append('image', img); fd.append('mode', mode);
        const r = await fetch(API_BASE + '/api/agent_chat', { method:'POST', body: fd });
        data = await r.json(); setImg(null); if (fileRef.current) fileRef.current.value='';
      } else {
        const r = await fetch(API_BASE + '/api/agent_chat', { method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ user_input:t, current_page:'纹样宝库', has_image:false, mode }) });
        data = await r.json();
      }
      setMessages(m => [...m, { side:'bot', type:'bot', data }]);
    } catch (e) {
      setMessages(m => [...m, { side:'bot', type:'error', text:'⚠️ 请求失败：'+e.message }]);
    } finally { setLoading(false); }
  };
  return (
    <div style={{maxWidth:720,height:'82vh',border:'1px solid #e7ddd0',borderRadius:16,display:'flex',flexDirection:'column'}}>
      <div style={{padding:'14px 18px',borderBottom:'1px solid #e7ddd0',display:'flex',justifyContent:'space-between'}}>
        <b>纹以载道 · AI 导览</b>
        <label><input type="checkbox" checked={react} onChange={e=>setReact(e.target.checked)} /> ReAct 多轮</label>
      </div>
      <div style={{flex:1,overflowY:'auto',padding:16}}>
        {messages.map((m,i)=>(
          <div key={i} style={{display:'flex',justifyContent:m.side==='user'?'flex-end':'flex-start',margin:'8px 0'}}>
            <div style={{maxWidth:'78%',padding:'10px 14px',borderRadius:14,whiteSpace:'pre-wrap',
              background:m.side==='user'?'#9c3b2e':'#f3ece1',color:m.side==='user'?'#fff':'#2b2620'}}>
              {m.type==='text' && m.text}
              {m.type==='error' && m.text}
              {m.type==='bot' && (<>
                <div>{m.data.answer}</div>
                {m.data.tool_results?.vision?.extract_color?.palette?.map((c,k)=>(
                  <span key={k} style={{display:'inline-block',margin:'4px',padding:'2px 6px',borderRadius:6,background:c.hex,color:'#fff',fontSize:12}}>{c.hex}</span>
                ))}
                {m.data.sources?.length>0 && <div style={{fontSize:12,color:'#8a7f70'}}>📚 检索到 {m.data.sources.length} 枚相关纹样</div>}
              </>)}
            </div>
          </div>
        ))}
      </div>
      <div style={{borderTop:'1px solid #e7ddd0',padding:12,display:'flex',gap:8}}>
        <input value={text} onChange={e=>setText(e.target.value)} onKeyUp={e=>e.key==='Enter'&&send()}
               placeholder="问问纹样寓意，或上传图片做再设计…" style={{flex:1,padding:'11px 14px',borderRadius:22,border:'1px solid #e7ddd0'}} />
        <button onClick={()=>fileRef.current.click()} style={{border:'1px solid #e7ddd0',borderRadius:22,padding:'0 12px'}}>🖼</button>
        <button onClick={send} disabled={loading} style={{background:'#9c3b2e',color:'#fff',border:'none',borderRadius:22,padding:'0 18px'}}>{loading?'…':'发送'}</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={e=>setImg(e.target.files[0])} />
      </div>
    </div>
  );
}
```

---

## 四、删除旧 fetch 的具体步骤

1. **搜**：在你前端源码根目录全局搜 `open.bigmodel.cn`（或 `zhipuai` / `Bearer` / `apiKey`）。
2. **定位**：找到发起对话的那段 `fetch` / `axios` / `new ZhipuAI(...)`。
3. **删/改**：
   - 若用的是方案 A：整段旧对话逻辑可以**直接删除**，页面改用 `ai-chat.html`。
   - 若用的是方案 B/C：把旧的"请求智谱"函数替换成调用 `sendText()` / `sendImageWithText()`（HTML 版）或 `<AiChat/>`（Vue 版）。
4. **确认干净**：再搜一次 `open.bigmodel.cn` / `Bearer` / `apiKey`，应**无命中**；浏览器 F12 Network 触发请求后，确认请求只发往 `127.0.0.1:8000/api/agent_chat`（或你的 `/api`），**绝不出现** `open.bigmodel.cn`。

> 别忘了：旧 `ai_glm.js` 里的那枚 Key（`d5b8fbf4…`）要去智谱控制台吊销（见第〇节）。
