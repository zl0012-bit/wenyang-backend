<template>
  <div class="chat">
    <div class="chat__hd">
      <h1>纹以载道 · AI 导览</h1>
      <label class="mode"><input type="checkbox" v-model="reactMode" /> ReAct 多轮</label>
    </div>

    <div class="chat__body" ref="body">
      <div v-for="(m, i) in messages" :key="i" class="row" :class="'row--' + m.side">
        <div class="bubble" v-if="m.type === 'text'">{{ m.text }}</div>
        <div class="bubble" v-else-if="m.type === 'error'">{{ m.text }}</div>
        <div class="bubble" v-else-if="m.type === 'bot'">
          <div v-if="m.data.answer">{{ m.data.answer }}</div>

          <template v-if="m.data.tool_results?.vision?.extract_color">
            <div class="ttl">🎨 提取到的主色板</div>
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

    <div class="chat__ft">
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
        <button class="btn btn--img" @click="$refs.file.click()">🖼 图片</button>
        <button class="btn btn--send" @click="submit" :disabled="loading">{{ loading ? '…' : '发送' }}</button>
        <input type="file" ref="file" accept="image/*" hidden @change="onPick" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick } from 'vue'

// 配置：本地后端地址。若已配 Vite proxy，改成 '' 走同源 /api
const API_BASE = 'http://127.0.0.1:8000'
const apiUrl = (p) => API_BASE + p
const CURRENT_PAGE_TEXT = '纹样宝库'
const CURRENT_PAGE_IMG = 'AI共创'

const messages = ref([])
const text = ref('')
const reactMode = ref(false)
const pendingImage = ref(null)
const previewUrl = ref('')
const loading = ref(false)
const body = ref(null)

messages.value.push({ side: 'bot', type: 'text', text: '你好，我是「纹以载道」AI 导览。可以问我纹样寓意、对比朝代纹样，或上传图片做配色与结构分析。' })

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
  if (this?.$refs?.file) this.$refs.file.value = ''
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
.chat { width: 100%; max-width: 720px; height: 82vh; background: #fff; border: 1px solid #e7ddd0;
  border-radius: 16px; display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(60,40,20,.1); overflow: hidden; }
.chat__hd { padding: 14px 18px; border-bottom: 1px solid #e7ddd0; display: flex; align-items: center; justify-content: space-between; background: linear-gradient(90deg,#fff,#fbf6ee); }
.chat__hd h1 { font-size: 16px; margin: 0; letter-spacing: 1px; }
.mode { font-size: 12px; color: #8a7f70; display: flex; align-items: center; gap: 6px; }
.chat__body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.row { display: flex; gap: 10px; } .row--user { justify-content: flex-end; } .row--bot { justify-content: flex-start; }
.bubble { max-width: 78%; padding: 10px 14px; border-radius: 14px; line-height: 1.6; font-size: 14px; white-space: pre-wrap; word-break: break-word; }
.row--user .bubble { background: #9c3b2e; color: #fff; border-bottom-right-radius: 4px; }
.row--bot .bubble { background: #f3ece1; border: 1px solid #e7ddd0; border-bottom-left-radius: 4px; }
.palette { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.swatch { width: 56px; text-align: center; font-size: 10px; color: #8a7f70; cursor: pointer; }
.swatch i { display: block; width: 56px; height: 56px; border-radius: 8px; border: 1px solid rgba(0,0,0,.08); margin-bottom: 3px; }
.swatch b { color: #2b2620; font-size: 11px; }
.layers { margin: 8px 0; font-size: 12px; color: #8a7f70; } .layers li { margin: 2px 0; }
.src { margin-top: 8px; font-size: 12px; } .src summary { cursor: pointer; color: #9c3b2e; }
.src__item { padding: 4px 0; border-bottom: 1px dashed #e7ddd0; }
.chat__ft { border-top: 1px solid #e7ddd0; padding: 12px; background: #fff; }
.ft__top { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.preview { position: relative; width: 48px; height: 48px; border-radius: 8px; overflow: hidden; border: 1px solid #e7ddd0; }
.preview img { width: 100%; height: 100%; object-fit: cover; }
.preview button { position: absolute; right: -4px; top: -4px; border: none; background: #9c3b2e; color: #fff; border-radius: 50%; width: 18px; height: 18px; cursor: pointer; font-size: 11px; line-height: 1; }
.ft__row { display: flex; gap: 8px; }
.ft__row input[type=text] { flex: 1; padding: 11px 14px; border: 1px solid #e7ddd0; border-radius: 22px; font-size: 14px; outline: none; }
.btn { border: none; border-radius: 22px; padding: 0 18px; font-size: 14px; cursor: pointer; }
.btn--send { background: #9c3b2e; color: #fff; } .btn--img { background: #f3ece1; color: #2b2620; border: 1px solid #e7ddd0; padding: 0 12px; }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.typing span { display: inline-block; width: 6px; height: 6px; margin: 0 1px; background: #8a7f70; border-radius: 50%; animation: blink 1.2s infinite both; }
.typing span:nth-child(2){ animation-delay:.2s } .typing span:nth-child(3){ animation-delay:.4s }
@keyframes blink { 0%,80%,100%{opacity:.2} 40%{opacity:1} }
</style>
