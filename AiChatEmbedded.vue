<template>
  <!-- ============================================================
    AiChatEmbedded.vue —— 图二外壳 × 图一真心脏 合并版
    融合策略：
      ① 保留图二「智能体共创工作台」红头 + 工具标签行（标签会根据
         后端真实 tool_results 自动点亮，演示科技感拉满）
      ② 中间空白圆圈区域 → 替换为真正的对话流 + 输入框（无米黄外框）
      ③ 底部「本地模拟」黄条已删除，请求直达 /api/agent_chat
    如果只想把聊天核心粘进你现有组件：
      复制【聊天核心：开始】~【聊天核心：结束】两段 + script 中同名逻辑即可
  ============================================================ -->
  <div class="ws">
    <!-- ① 图二红头外壳（样式按你站点变量微调即可） -->
    <header class="ws__hd">
      <div class="ws__badge">AI</div>
      <div class="ws__ttl">
        <h2>智能体共创工作台</h2>
        <p>AI 导览 · 纹学活态 · 层区导览讲解</p>
      </div>
    </header>

    <!-- ② 工具标签行：st 里对应工具被真实调用后自动点亮 + 呼吸光效 -->
    <div class="ws__tags">
      <span class="tag" :class="{ 'tag--on': st.functionCalling }">⚡ Function Calling</span>
      <span class="tag" :class="{ 'tag--on': st.queryDb }">🔎 query_heritage_db</span>
      <span class="tag" :class="{ 'tag--on': st.genPattern }">🎨 generate_pattern_image</span>
      <span class="tag" :class="{ 'tag--on': st.glmLive }">🔴 智谱 GLM-4-Flash 实时调用</span>
    </div>

    <!-- ③ 聊天核心：开始（替代原空白圆圈区域，粘进你组件时从这里复制） -->
    <section class="card">
      <div class="card__hd">
        <span class="card__ttl">🧭 AI 导览 <small>极议复盘 · 查点指导</small></span>
        <label class="react-switch">
          <input type="checkbox" v-model="reactMode" />
          ReAct 多轮
        </label>
      </div>

      <div class="body" ref="body">
        <div v-for="(m, i) in messages" :key="i" class="row" :class="'row--' + m.side">
          <div class="bubble" v-if="m.type === 'text' || m.type === 'error'">{{ m.text }}</div>

          <div class="bubble" v-else-if="m.type === 'bot'">
            <div v-if="m.data.answer">{{ m.data.answer }}</div>

            <template v-if="m.data.tool_results?.vision?.extract_color">
              <div class="ttl">🎨 提取到的主色板（点击复制色值）</div>
              <div class="palette">
                <div v-for="(c, k) in m.data.tool_results.vision.extract_color.palette" :key="k"
                     class="swatch" @click="copy(c.hex)">
                  <i :style="{ background: c.hex }"></i>
                  <b>{{ c.hex }}</b>{{ (c.ratio * 100).toFixed(0) }}%
                </div>
              </div>
            </template>

            <template v-if="m.data.tool_results?.vision?.segment_pattern">
              <ul class="layers">
                <li>🔪 共切分出 <b>{{ m.data.tool_results.vision.segment_pattern.num_components }}</b> 个图层</li>
                <li v-for="(l, k) in m.data.tool_results.vision.segment_pattern.layers.slice(0, 3)" :key="k">
                  图层 #{{ l.label }}：面积占比 {{ (l.area_ratio * 100).toFixed(1) }}%
                </li>
              </ul>
            </template>

            <details class="src" v-if="m.data.sources?.length">
              <summary>📚 检索到 {{ m.data.sources.length }} 枚相关纹样</summary>
              <div class="src__item" v-for="(s, k) in m.data.sources.slice(0, 5)" :key="k">
                <b>{{ s.name }}</b> · {{ s.origin_std }} · {{ s.theme }}
                <span>相似度 {{ s.score }}</span>
              </div>
            </details>
          </div>

          <div class="bubble typing" v-else-if="m.type === 'typing'"><span></span><span></span><span></span></div>
        </div>
      </div>

      <div class="ft">
        <div class="ft__top" v-if="pendingImage">
          <div class="preview">
            <img :src="previewUrl" alt="预览" />
            <button @click="clearImage">×</button>
          </div>
          <span>已选图片，发送时将一并上传</span>
        </div>
        <div class="ft__row">
          <input type="text" v-model="text" @keyup.enter="submit"
                 placeholder="问问纹样的寓意、对比朝代纹样，或上传图片做再设计…" />
          <button class="btn btn--img" @click="$refs.file.click()">🖼</button>
          <button class="btn btn--send" @click="submit" :disabled="loading">{{ loading ? '…' : '发送' }}</button>
          <input type="file" ref="file" accept="image/*" hidden @change="onPick" />
        </div>
      </div>
    </section>
    <!-- 聊天核心：结束 -->
  </div>
</template>

<script setup>
import { ref, reactive, nextTick } from 'vue'

/* ===================== 配置 ===================== */
// 推荐：同源部署（server.js 已把 /api/* 反代到 8000），置空走相对路径，
// 外网/手机访问零 CORS 问题。若你的 Vite 工程直连后端，改为 'http://127.0.0.1:8000'
// 并配置 vite.proxy（见 rag/FRONTEND_VITE_PROXY.md）。
const API_BASE = ''
const apiUrl = (p) => API_BASE + p
const CURRENT_PAGE_TEXT = '纹样宝库'
const CURRENT_PAGE_IMG = 'AI共创'

/* ===================== 状态 ===================== */
const messages = ref([])
const text = ref('')
const reactMode = ref(false)
const pendingImage = ref(null)
const previewUrl = ref('')
const loading = ref(false)
const body = ref(null)

// 工具标签点亮状态：每次收到真实响应后由 markTools() 更新
const st = reactive({
  functionCalling: false,  // 任一工具被调用（含 ReAct trace）
  queryDb: false,          // rag_search 命中（对应 query_heritage_db）
  genPattern: false,       // 视觉工具产出（对应 generate_pattern_image 前置能力）
  glmLive: false,          // 首次真实 HTTP 200 后常亮
})

messages.value.push({ side: 'bot', type: 'text', text: '你好，我是「纹以载道」AI 导览。可以问我纹样寓意、对比朝代纹样，或上传图片做配色与结构分析。' })

/* ===================== 工具标签联动 ===================== */
// 把后端 tool_results 映射到图二顶部标签，实现「真调用才点亮」
function markTools(data) {
  const tr = data.tool_results || {}
  const rag = tr.rag?.count > 0 || (data.sources?.length || 0) > 0
  const vision = !!(tr.vision?.extract_color || tr.vision?.segment_pattern)
  const reacted = (tr.react_trace?.length || 0) > 0
  // 标签联动严格对照需求三条：
  if (rag) st.queryDb = true                       // RAG 命中 → query_heritage_db 呼吸发光
  if (vision) st.genPattern = true                 // 视觉工具调用 → generate_pattern_image 发光
  if (reacted) st.functionCalling = true           // 仅 ReAct 多轮触发 → Function Calling 发光
  st.glmLive = true                                // 首次真实 HTTP 200 → GLM 实时调用常亮
}

/* ===================== 聊天核心逻辑（与 AiChat.vue 一致） ===================== */
const copy = (hex) => navigator.clipboard?.writeText(hex)
async function scrollDown() { await nextTick(); if (body.value) body.value.scrollTop = body.value.scrollHeight }

function onPick(e) {
  const f = e.target.files[0]
  if (!f) return
  pendingImage.value = f
  previewUrl.value = URL.createObjectURL(f)
}
function clearImage() {
  pendingImage.value = null
  previewUrl.value = ''
  const file = document.querySelector('input[type=file]')
  if (file) file.value = ''
}

function pushTyping() {
  messages.value.push({ side: 'bot', type: 'typing' })
  scrollDown()
  return messages.value.length - 1
}
function removeTyping(idx) { messages.value.splice(idx, 1) }
function pushError(msg) { messages.value.push({ side: 'bot', type: 'error', text: '⚠️ ' + msg }); scrollDown() }

async function submit() {
  if (loading.value) return
  const hasImg = !!pendingImage.value
  const t = text.value.trim()
  if (!t && !hasImg) return

  messages.value.push({ side: 'user', type: 'text', text: (t ? t + '\n' : '') + (hasImg ? '🖼 [图片]' : '') })
  text.value = ''
  const typingIdx = pushTyping()
  loading.value = true
  const mode = reactMode.value ? 'react' : 'default'

  try {
    let data
    if (hasImg) {
      const fd = new FormData()
      fd.append('user_input', t || '请分析这张纹样的配色与结构，并给出再设计建议')
      fd.append('current_page', CURRENT_PAGE_IMG)
      fd.append('image', pendingImage.value)
      fd.append('mode', mode)
      const resp = await fetch(apiUrl('/api/agent_chat'), { method: 'POST', body: fd })
      if (!resp.ok) throw new Error('HTTP ' + resp.status)
      data = await resp.json()
      clearImage()
    } else {
      const resp = await fetch(apiUrl('/api/agent_chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_input: t, current_page: CURRENT_PAGE_TEXT, has_image: false, mode })
      })
      if (!resp.ok) throw new Error('HTTP ' + resp.status)
      data = await resp.json()
    }
    removeTyping(typingIdx)
    markTools(data)                                   // ★ 点亮顶部工具标签
    messages.value.push({ side: 'bot', type: 'bot', data })
    scrollDown()
  } catch (e) {
    removeTyping(typingIdx)
    pushError('请求失败：' + e.message + '。请确认后端已启动（./start.sh）且地址正确。')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
/* ===================== 红白主题适配（替换图一所有米黄色） ===================== */
.ws {
  --red: #9c3b2e;            /* 主红（用户气泡/发送按钮，与图二中国红同族） */
  --red-deep: #7c2418;
  --red-tint: #fdf5f2;       /* 机器人气泡底：米色 → 红调极浅 */
  --red-line: rgba(156, 59, 46, .18);
  --gold: #c9a063;           /* 图二金色点缀 */
  display: flex; flex-direction: column; gap: 12px;
}

/* —— 图二红头外壳 —— */
.ws__hd { display: flex; align-items: center; gap: 12px; color: #fff; }
.ws__badge { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, var(--gold), #a8823f);
  display: flex; align-items: center; justify-content: center; font-weight: 700; color: #fff; }
.ws__ttl h2 { margin: 0; font-size: 16px; letter-spacing: 1px; }
.ws__ttl p { margin: 2px 0 0; font-size: 11px; opacity: .85; }

/* —— 工具标签行：默认灰暗，被真实调用后点亮 + 呼吸光 —— */
.ws__tags { display: flex; gap: 8px; flex-wrap: wrap; }
.tag { font-size: 11px; padding: 4px 10px; border-radius: 20px; color: #9a8f86;
  background: rgba(255,255,255,.55); border: 1px solid rgba(0,0,0,.06); transition: all .3s; }
.tag--on { color: #fff; background: var(--red); border-color: var(--red-deep);
  box-shadow: 0 0 0 0 rgba(156,59,46,.5); animation: pulse 1.8s infinite; }
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(156,59,46,.45); }
  70% { box-shadow: 0 0 0 8px rgba(156,59,46,0); }
  100% { box-shadow: 0 0 0 0 rgba(156,59,46,0); }
}

/* —— 聊天卡：无米黄外框，白底红影，融入图二卡片 —— */
.card { position: relative; z-index: 10;           /* ★ 整卡浮在悬浮球之上 */
  display: flex; flex-direction: column; min-height: 420px; max-height: 66vh;
  background: #fff; border-radius: 14px; overflow: hidden;
  box-shadow: 0 10px 32px rgba(124,36,24,.16); }
.card__hd { padding: 12px 16px; background: linear-gradient(90deg, var(--red), var(--red-deep));
  color: #fff; display: flex; align-items: center; justify-content: space-between; }
.card__ttl { font-size: 14px; font-weight: 600; }
.card__ttl small { font-weight: 400; font-size: 11px; opacity: .8; margin-left: 6px; }
.react-switch { font-size: 12px; display: flex; align-items: center; gap: 6px; cursor: pointer; }
.react-switch input { accent-color: var(--gold); width: 15px; height: 15px; cursor: pointer; }

/* 对话列表：自身滚动， overscroll 防滚动穿透 */
.body { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 16px;
  display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; } .row--user { justify-content: flex-end; }
.bubble { max-width: 78%; padding: 10px 14px; border-radius: 14px; line-height: 1.65;
  font-size: 14px; white-space: pre-wrap; word-break: break-word; }
.row--user .bubble { background: var(--red); color: #fff; border-bottom-right-radius: 4px; }
.row--bot .bubble { background: var(--red-tint); border: 1px solid var(--red-line); border-bottom-left-radius: 4px; }
.ttl { font-size: 12px; color: var(--red-deep); margin-top: 8px; font-weight: 600; }
.palette { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.swatch { width: 56px; text-align: center; font-size: 10px; color: #9a8f86; cursor: pointer; }
.swatch i { display: block; width: 56px; height: 56px; border-radius: 8px; border: 1px solid rgba(0,0,0,.08); margin-bottom: 3px; }
.swatch b { color: #3a2a24; font-size: 11px; }
.layers { margin: 8px 0 0; font-size: 12px; color: #9a8f86; } .layers li { margin: 2px 0; }
.src { margin-top: 8px; font-size: 12px; } .src summary { cursor: pointer; color: var(--red); }
.src__item { padding: 4px 0; border-bottom: 1px dashed var(--red-line); }

/* 输入区：置顶层级，保证悬浮球永不遮挡 */
.ft { position: relative; z-index: 20; border-top: 1px solid var(--red-line); padding: 12px; background: #fff; }
.ft__top { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; font-size: 12px; color: #9a8f86; }
.preview { position: relative; width: 48px; height: 48px; border-radius: 8px; overflow: hidden; border: 1px solid var(--red-line); }
.preview img { width: 100%; height: 100%; object-fit: cover; }
.preview button { position: absolute; right: -4px; top: -4px; border: none; background: var(--red); color: #fff;
  border-radius: 50%; width: 18px; height: 18px; cursor: pointer; font-size: 11px; line-height: 1; }
.ft__row { display: flex; gap: 8px; }
.ft__row input[type=text] { flex: 1; padding: 11px 14px; border: 1px solid var(--red-line);
  border-radius: 22px; font-size: 14px; outline: none; }
.ft__row input[type=text]:focus { border-color: var(--red); box-shadow: 0 0 0 3px rgba(156,59,46,.12); }
.btn { border: none; border-radius: 22px; padding: 0 18px; font-size: 14px; cursor: pointer; }
.btn--send { background: linear-gradient(135deg, var(--red), var(--red-deep)); color: #fff; }
.btn--img { background: var(--red-tint); border: 1px solid var(--red-line); padding: 0 12px; }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.typing span { display: inline-block; width: 6px; height: 6px; margin: 0 1px; background: var(--red);
  border-radius: 50%; animation: blink 1.2s infinite both; }
.typing span:nth-child(2){ animation-delay:.2s } .typing span:nth-child(3){ animation-delay:.4s }
@keyframes blink { 0%,80%,100%{opacity:.2} 40%{opacity:1} }
</style>
