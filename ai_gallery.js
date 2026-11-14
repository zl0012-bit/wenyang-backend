/* ============================================================
 * ai_gallery.js —— AI 回答的「站内纹样配图画廊」
 * ------------------------------------------------------------
 * 后端 /api/agent_chat（META 块）与 /api/agent_chat_json / /api/guide_chat
 * 会在文字之外返回 { images: [url...], patterns: [{id,name,image,href,label}] }。
 * 本模块负责把图片渲染成气泡下方的横向缩略图画廊：
 *   · 圆角卡片、hover 微微放大、点击直达该纹样详情页
 *   · window.AiGallery.render(container, payload) 供 ws-real.js / ai-workshop.html 调用
 *   · 自动 hook /api/guide_chat（主站 AI 导览悬浮球「纹宝」为压缩 bundle，
 *     不便改动）：以 TransformStream 逐块剥离 \u0000IMAGES\u0000 元数据，
 *     保留打字机效果，再把画廊挂到最新一条 bot 气泡上。
 * 任何异常都只影响画廊，绝不阻断原有对话。
 * ============================================================ */
(function () {
  'use strict';

  var CSS = [
    '.aig{margin:10px 0 2px;font-family:"Noto Sans SC",system-ui,sans-serif}',
    '.aig__hd{display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:11px;',
    'letter-spacing:.06em;color:#8a6a2f}',
    '.aig__hd::before{content:"";width:14px;height:1px;background:#c89b3c}',
    '.aig__row{display:flex;gap:8px;overflow-x:auto;padding:1px 1px 6px;scrollbar-width:thin}',
    '.aig__card{position:relative;flex:0 0 auto;width:86px;border-radius:10px;overflow:hidden;',
    'text-decoration:none;background:#fff;border:1px solid rgba(200,155,60,.38);',
    'box-shadow:0 2px 8px rgba(60,40,20,.14);',
    'transition:transform .28s cubic-bezier(.22,1,.36,1),box-shadow .28s ease}',
    '.aig__card:hover{transform:scale(1.05);box-shadow:0 7px 18px rgba(60,40,20,.3);z-index:2}',
    '.aig__card img{display:block;width:100%;height:86px;object-fit:cover;background:#f6f3ec}',
    '.aig__name{display:block;position:absolute;left:0;right:0;bottom:0;padding:12px 3px 4px;',
    'font-size:11px;line-height:1.3;text-align:center;color:#f7eecf;',
    'background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.78));',
    'text-shadow:0 1px 3px rgba(0,0,0,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '@media(max-width:560px){.aig__card{width:74px}.aig__card img{height:74px}}'
  ].join('');

  /** 样式需注入到目标节点所在的根：主文档或 ShadowRoot（样式隔离，必须分别注入）。
   *  注意：不要直接把本函数当 DOMContentLoaded 回调传进去 —— 回调首参是 Event，
   *  不是节点，会导致 appendChild 报错。这里同时做了类型兜底。 */
  function injectCSS(root) {
    var host;
    if (root && root.head && typeof root.head.appendChild === 'function') host = root.head;
    else if (root && typeof root.appendChild === 'function') host = root;
    else host = document.head;
    if (host.getElementById ? host.getElementById('aig-style')
                           : host.querySelector && host.querySelector('#aig-style')) return;
    var st = document.createElement('style');
    st.id = 'aig-style'; st.textContent = CSS;
    host.appendChild(st);
  }

  /** 在气泡容器底部追加画廊；幂等，重复调用不会叠加。 */
  function render(container, payload) {
    if (!container || !payload || !window.AiGallery) return null;
    injectCSS(container.getRootNode());
    var images = payload.images || [];
    var metas = payload.patterns || [];
    if (!images.length && !metas.length) return null;
    var exist = container.querySelector(':scope > .aig');
    if (exist) return exist;

    var wrap = document.createElement('div');
    wrap.className = 'aig';
    var hd = document.createElement('div');
    hd.className = 'aig__hd';
    hd.textContent = '馆内相关纹样 · 点击查看详情';
    wrap.appendChild(hd);

    var row = document.createElement('div');
    row.className = 'aig__row';
    var list = images.length ? images : metas.map(function (m) { return m.image; });
    list.forEach(function (src, i) {
      if (!src) return;
      var meta = metas[i] || {};
      var a = document.createElement('a');
      a.className = 'aig__card';
      a.href = meta.href || '/library';
      a.title = '查看「' + (meta.name || '纹样') + '」详情';
      var img = document.createElement('img');
      img.src = src;
      img.alt = meta.name || '纹样';
      img.loading = 'lazy';
      img.onerror = function () { a.style.display = 'none'; };
      a.appendChild(img);
      var nm = document.createElement('span');
      nm.className = 'aig__name';
      nm.textContent = meta.label || meta.name || '纹样';
      a.appendChild(nm);
      row.appendChild(a);
    });
    if (!row.childNodes.length) return null;
    wrap.appendChild(row);
    container.appendChild(wrap);
    return wrap;
  }

  /* ---------- 主站 AI 导览悬浮球（/api/guide_chat）自动接入 ---------- */
  var MARK = '\u0000IMAGES\u0000';
  var queue = [];
  var timers = [];

  function latestBotBubble() {
    var sels = [
      '.ai-assistant__panel .ai-chat__msg.is-bot .ai-chat__bubble',
      '.ai-chat__msg.is-bot .ai-chat__bubble',
      '.ai-chat__bubble'
    ];
    for (var i = 0; i < sels.length; i++) {
      var list = document.querySelectorAll(sels[i]);
      if (list.length) return list[list.length - 1];
    }
    return null;
  }

  function flush() {
    if (!queue.length) return;
    var bubble = latestBotBubble();
    if (!bubble) return;
    render(bubble, queue.shift());
  }

  function schedule() {
    timers.forEach(clearTimeout);
    timers = [];
    [120, 400, 900, 1800].forEach(function (ms) {
      timers.push(setTimeout(flush, ms));
    });
  }

  function hookGuideChat() {
    if (window.__AIG_HOOKED__) return;
    window.__AIG_HOOKED__ = true;
    var orig = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var p = orig.apply(this, arguments);
      if (url.indexOf('/api/guide_chat') === -1) return p;
      return p.then(function (res) {
        if (!res || !res.body || typeof TransformStream === 'undefined') return res;
        var dec = new TextDecoder('utf-8'), enc = new TextEncoder();
        var buf = '', meta = '', inMeta = false, done = false;

        function consume() {
          if (!inMeta || done) return;
          var nl = meta.indexOf('\n');
          if (nl === -1) return;
          done = true;
          try {
            var payload = JSON.parse(meta.slice(0, nl));
            if (payload && (payload.images || payload.patterns)) {
              queue.push(payload);
              schedule();
            }
          } catch (e) { /* 元数据残片，忽略 */ }
        }

        var ts = new TransformStream({
          transform: function (chunk, ctrl) {
            buf += dec.decode(chunk, { stream: true });
            if (inMeta) { meta += buf; buf = ''; consume(); return; }
            var i = buf.indexOf(MARK);
            if (i !== -1) {
              var clean = buf.slice(0, i);
              if (clean) ctrl.enqueue(enc.encode(clean));
              meta = buf.slice(i + MARK.length);
              buf = ''; inMeta = true;
              consume();
              return;
            }
            // 末尾保留 MARK.length-1 个字符，防止标记跨 chunk 被切断
            var keep = MARK.length - 1;
            if (buf.length > keep) {
              ctrl.enqueue(enc.encode(buf.slice(0, buf.length - keep)));
              buf = buf.slice(buf.length - keep);
            }
          },
          flush: function (ctrl) {
            if (!inMeta && buf) ctrl.enqueue(enc.encode(buf));
            else { meta += buf; consume(); }
          }
        });
        var headers = new Headers(res.headers);
        headers.delete('content-length');
        return new Response(res.body.pipeThrough(ts), {
          status: res.status, statusText: res.statusText, headers: headers
        });
      });
    };
  }

  window.AiGallery = { render: render, schedule: schedule };
  hookGuideChat();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { injectCSS(); });
  } else {
    injectCSS();
  }
})();
