/* ============================================================================
 * ai_actions.js —— AI 共创结果区「一键复制色卡 / 一键下载原图」
 * ----------------------------------------------------------------------------
 * 覆盖三套真实 UI（均为压缩 bundle，无 Vue 源码，采用 DOM 注入增强，不动底层）：
 *   · /ai 工作台（Shadow DOM）：智能配色结果 = .wsrx__row--bot .wsrx__bubble
 *                              纹样共创设计图 = img[alt=非遗纹样设计方案].cp-img-in
 *   · /workshop（ai-workshop.html）：.row--bot .bubble
 *   · 首页「纹宝」悬浮球：.ai-chat__msg.is-bot .ai-chat__bubble
 *
 * 任务一：气泡下方正则提取全部 16 进制色值，**逐个循环渲染成可视化色块**
 *         （等价 Vue 的 v-for；深色白字 / 浅色黑字、Hover「点击复制该色值」、
 *         单击复制单色），并渲染国风「📋 复制色卡 (Hex)」按钮：
 *         点击时把色值拼成 ['#a', '#b', '#c'] 数组格式写入剪贴板，
 *         navigator.clipboard.writeText() 优先（execCommand 兜底），
 *         成功后按钮变「✅ 已复制」+ 国风 Toast。
 *         说明：本项目是 Vite 构建产物，没有 .vue 源码；压缩 bundle 里内置
 *         AiColor 组件的 v-for 色卡在当前工作台不渲染（实测 0 个色块），
 *         真实结果由 ws-real.js 的 .wsrx__bubble 承载，故在此做等价循环渲染。
 * 任务二：设计图 <img> 下方渲染「⬇️ 下载高清原图」按钮：
 *         同源/data/blob → 直接 a[download]；跨域 → fetch 转 Blob → a[download]；
 *         CORS 失败 → 同源代理 /api/image_proxy；再失败 → 打开原图兜底。
 *
 * 全程幂等 + MutationObserver 防抖 + disconnect/observe 防死循环；样式分别注入
 * 主文档与各 ShadowRoot。任何异常只影响按钮，绝不打断原有对话/生成流程。
 * ========================================================================== */
(function () {
  'use strict';

  var STYLE_ID = 'wsact-style';
  var COPY_CLS = 'wsact-copy';   // 复制色卡按钮
  var DL_CLS = 'wsact-dl';       // 下载原图按钮
  var SLOT_CLS = 'wsact-slot';   // 按钮容器
  var ROW_CLS = 'wsact-row';     // 让气泡行变 column，使按钮落在气泡下方

  var CSS = [
    /* ── 按钮：与「↻ 重新设计」同源的白底圆角 + 金红 hover ── */
    '.wsact-btn{display:inline-flex;align-items:center;gap:6px;font-family:inherit;',
    'font-size:13px;font-weight:600;letter-spacing:.02em;line-height:1.2;cursor:pointer;',
    'padding:8px 15px;border-radius:12px;border:1px solid #e3d9c2;color:#5b4a38;',
    'background:linear-gradient(180deg,#fffdf8 0%,#fbf5e9 100%);',
    'box-shadow:0 1px 2px rgba(90,60,20,.07);',
    'transition:border-color .22s ease,color .22s ease,background .22s ease,',
    'box-shadow .22s ease,transform .22s ease}',
    '.wsact-btn::before{content:"";width:5px;height:5px;border-radius:1px;',
    'background:#c9a227;transform:rotate(45deg);flex:0 0 auto;opacity:.85}',
    '.wsact-btn:hover{border-color:#8B0000;color:#8B0000;',
    'background:linear-gradient(180deg,#fff8ec 0%,#f7e7cf 100%);',
    'box-shadow:0 5px 16px rgba(139,0,0,.16);transform:translateY(-1px)}',
    '.wsact-btn:active{transform:translateY(0);box-shadow:0 1px 3px rgba(139,0,0,.18)}',
    '.wsact-btn:disabled{opacity:.55;cursor:wait;transform:none}',
    '.wsact-btn.is-ok{border-color:#2f7d5b;color:#1e6849;',
    'background:linear-gradient(180deg,#f2fbf5 0%,#e4f5ea 100%)}',
    '.wsact-btn.is-ok::before{background:#2f7d5b}',
    /* 小巧版（色卡按钮） */
    '.wsact-btn--sm{font-size:12px;padding:6px 12px;border-radius:10px}',
    /* 容器 + 让气泡行改为纵向，按钮落在气泡下方并对齐左缘 */
    '.wsact-slot{display:block;margin:2px 0 0}',
    '.wsrx__row--bot.wsact-row,.row--bot.wsact-row{display:flex;',
    'flex-direction:column;align-items:flex-start;gap:7px}',
    '.wsact-slot--dl{margin-top:10px}',
    /* 旧版纯文字预览：保留选择器但不再输出，避免残留 DOM 撑高布局 */
    '.wsact-hex{display:none}',
    /* ── 可视化色卡：v-for 等价循环渲染的色块 ── */
    '.wsact-palette{position:relative;z-index:3;display:flex;flex-wrap:wrap;',
    'gap:10px;align-items:flex-start;margin:9px 0 2px;padding:0;max-width:100%}',
    /* 标题下方留出 Hover 提示的空间，避免 tooltip 压住说明文字 */
    '.wsact-palette__label{display:block;flex:0 0 100%;width:100%;margin:0 0 26px;',
    'font-size:11px;letter-spacing:.06em;color:#9a8f80;font-family:inherit;line-height:1.4}',
    '.wsact-swatch{position:relative;display:flex;flex-direction:column;',
    'justify-content:flex-end;align-items:center;box-sizing:border-box;',
    'width:88px;height:68px;padding:0 4px 9px;margin:0;border-radius:12px;',
    'border:1px solid rgba(0,0,0,.12);cursor:pointer;',
    'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;font-weight:700;',
    'letter-spacing:.02em;line-height:1.2;-webkit-tap-highlight-color:transparent;',
    'box-shadow:0 2px 8px rgba(60,40,20,.16),inset 0 1px 0 rgba(255,255,255,.3);',
    'transition:transform .22s ease,box-shadow .22s ease,border-color .22s ease}',
    '.wsact-swatch::before{content:"";position:absolute;left:9px;right:9px;top:8px;',
    'height:1px;border-radius:1px;background:rgba(255,255,255,.4)}',
    '.wsact-swatch__hex{position:relative;z-index:1;display:block;white-space:nowrap}',
    '.wsact-swatch.is-dark{color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.5)}',
    '.wsact-swatch.is-light{color:#111;text-shadow:0 1px 2px rgba(255,255,255,.5)}',
    '.wsact-swatch:hover,.wsact-swatch:focus-visible{transform:translateY(-3px) scale(1.045);',
    'z-index:4;border-color:rgba(201,162,39,.95);',
    'box-shadow:0 10px 22px rgba(60,40,20,.26),inset 0 1px 0 rgba(255,255,255,.32)}',
    '.wsact-swatch:active{transform:translateY(-1px) scale(1.01)}',
    '.wsact-swatch:focus-visible{outline:2px solid #c9a227;outline-offset:2px}',
    /* Hover 小提示「点击复制该色值」 */
    '.wsact-swatch::after{content:attr(data-tip);position:absolute;left:50%;',
    'bottom:calc(100% + 2px);transform:translate(-50%,4px);white-space:nowrap;',
    'pointer-events:none;padding:5px 10px;border-radius:8px;',
    'font-family:inherit;font-size:11px;font-weight:500;letter-spacing:.02em;',
    'color:#f7e7c4;background:linear-gradient(135deg,#3a1f18 0%,#5a2620 100%);',
    'border:1px solid rgba(201,162,60,.55);box-shadow:0 6px 18px rgba(30,10,5,.3);',
    'opacity:0;transition:opacity .2s ease,transform .2s ease}',
    '.wsact-swatch:hover::after,.wsact-swatch:focus-visible::after{opacity:1;',
    'transform:translate(-50%,0)}',
    '.wsact-swatch.is-copied{border-color:#2f7d5b;',
    'box-shadow:0 0 0 2px rgba(47,125,91,.4),0 8px 20px rgba(60,40,20,.2)}',
    '@media(max-width:560px){.wsact-swatch{width:74px;height:60px;font-size:10px}',
    '.wsact-palette{gap:8px}}',
    /* ── 国风 Toast ── */
    '.wsact-toast{position:fixed;left:50%;bottom:44px;transform:translate(-50%,16px);',
    'z-index:2147483647;max-width:min(86vw,520px);padding:12px 22px;border-radius:14px;',
    'background:linear-gradient(135deg,#3a1f18 0%,#5a2620 100%);',
    'border:1px solid rgba(201,162,60,.55);color:#f7e7c4;font-size:13.5px;',
    'letter-spacing:.04em;line-height:1.5;text-align:center;',
    'box-shadow:0 12px 36px rgba(30,10,5,.42),inset 0 0 0 1px rgba(255,230,170,.09);',
    'opacity:0;pointer-events:none;transition:opacity .3s ease,transform .3s ease}',
    '.wsact-toast::before{content:"❖";display:inline-block;margin-right:9px;',
    'color:#e6c778;font-size:13px}',
    '.wsact-toast.is-on{opacity:1;transform:translate(-50%,0)}',
    '@media(max-width:560px){.wsact-btn{font-size:12px;padding:7px 12px}}'
  ].join('');

  /* ---------------------------------------------------------------- 工具 */
  /** 把样式注入到目标节点所在的根（主文档 head 或 ShadowRoot），各根独立且幂等。 */
  function injectCSS(root) {
    var host;
    if (root && root.head && typeof root.head.appendChild === 'function') host = root.head;
    else if (root && typeof root.appendChild === 'function') host = root;
    else host = document.head;
    if (!host) return;
    var found = host.getElementById
      ? host.getElementById(STYLE_ID)
      : (host.querySelector ? host.querySelector('#' + STYLE_ID) : null);
    if (found) return;
    var st = document.createElement('style');
    st.id = STYLE_ID; st.textContent = CSS;
    try { host.appendChild(st); } catch (e) { /* 忽略 */ }
  }

  /** 提取文本中所有 16 进制色值（6 位/3 位），保序去重，保持原文大小写。 */
  function extractHex(text) {
    var re = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
    var m, out = [], seen = Object.create(null);
    while ((m = re.exec(text || '')) !== null) {
      var key = m[0].toUpperCase();
      if (!seen[key]) { seen[key] = 1; out.push(m[0]); }
    }
    return out;
  }

  /** 拼成设计师可直接粘贴的数组字面量：['#9e2933', '#c3272b', '#c8963c'] */
  function formatArray(hex) {
    return '[' + hex.map(function (h) { return "'" + h + "'"; }).join(', ') + ']';
  }

  /** WCAG 相对亮度判定深浅：深色配白字，浅色配黑字。
      3 位缩写先展开成 6 位；非法值按深色兜底。 */
  function isDarkColor(hex) {
    var h = String(hex || '').replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return true;
    var lin = function (c) {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    var r = lin(parseInt(h.slice(0, 2), 16));
    var g = lin(parseInt(h.slice(2, 4), 16));
    var b = lin(parseInt(h.slice(4, 6), 16));
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 0.42;
  }

  /* 单色复制反馈：流式打字机会不断重建色卡，反馈态存在模块级变量里，
     重建后由 syncCopyFeedback 重新贴回，避免刚点完「✓ 已复制」就被冲掉；
     过期后同样由它清除（1.4s 轮询扫描会触发一次同步）。 */
  var copiedState = { hex: '', until: 0 };
  function syncCopyFeedback(pal) {
    if (!pal) return;
    var active = !!copiedState.hex && Date.now() < copiedState.until;
    var sw = pal.querySelectorAll('.wsact-swatch');
    Array.prototype.forEach.call(sw, function (s) {
      var h = s.getAttribute('data-hex');
      var on = active && h === copiedState.hex;
      s.classList.toggle('is-copied', on);
      var t = s.querySelector('.wsact-swatch__hex');
      if (t) t.textContent = on ? '✓ 已复制' : h;
    });
  }

  /** 单个色块：填充色 + 内部 Hex 文字 + Hover 提示 + 单击复制单色。 */
  function makeSwatch(hex) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'wsact-swatch ' + (isDarkColor(hex) ? 'is-dark' : 'is-light');
    b.style.backgroundColor = hex;
    b.setAttribute('data-hex', hex);
    b.setAttribute('data-tip', '点击复制该色值');
    b.setAttribute('aria-label', '复制色值 ' + hex);
    var label = document.createElement('span');
    label.className = 'wsact-swatch__hex';
    label.textContent = hex;
    b.appendChild(label);
    b.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      writeClipboard(hex).then(function () {
        var pal = b.parentNode;
        copiedState = { hex: hex, until: Date.now() + 1400 };
        syncCopyFeedback(pal);
        toast('已复制 ' + hex + ' 到剪贴板');
        setTimeout(function () {
          if (copiedState.hex === hex) copiedState = { hex: '', until: 0 };
          syncCopyFeedback(pal);
        }, 1450);
      }).catch(function () { toast('复制失败，请手动复制 ' + hex); });
    });
    return b;
  }

  /** 等价 Vue 的 v-for：对提取到的每个色值循环渲染一个色块。
      用 data-hex 签名做幂等，流式打字机期间只在色值集合变化时重建。 */
  function renderPalette(pal, hex) {
    if (!pal) return;
    var sig = hex.join('|');
    if (pal.getAttribute('data-hex') !== sig) {
      pal.setAttribute('data-hex', sig);
      pal.textContent = '';
      if (!hex.length) {
        pal.style.display = 'none';
      } else {
        pal.style.display = '';
        var tip = document.createElement('span');
        tip.className = 'wsact-palette__label';
        tip.textContent = '🎨 AI 配色方案 · ' + hex.length + ' 色（点击色块复制单色）';
        pal.appendChild(tip);
        hex.forEach(function (h) { pal.appendChild(makeSwatch(h)); });
      }
    }
    // 无论本轮是否重建，都同步一次「✓ 已复制」反馈（含过期清除）
    syncCopyFeedback(pal);
  }

  /** 取气泡的可见正文，排除注入其中的 <style>/<script> 与本脚本注入的色卡 UI。
      AiGallery 会把画廊样式 <style> 放进气泡容器，其 CSS 里的 #RRGGBB
      不是用户色卡；色块自身的 Hex 也不能反过来参与提取，否则会自激。 */
  function bubbleText(el) {
    if (!el) return '';
    if (!el.cloneNode) return el.textContent || '';
    try {
      var c = el.cloneNode(true);
      var bad = c.querySelectorAll
        ? c.querySelectorAll('style,script,noscript,.wsact-slot,.wsact-palette,.wsact-swatch,.wsact-hex')
        : [];
      Array.prototype.forEach.call(bad, function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
      return c.textContent || '';
    } catch (e) {
      return el.textContent || '';
    }
  }

  function makeBtn(label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'wsact-btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      try { onClick(ev, b); } catch (e) { /* 不打断 UI */ }
    });
    return b;
  }

  /* ------------------------------------------------------- 国风 Toast */
  var toastEl = null, toastTimer = null;
  function toast(msg) {
    injectCSS(document);
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'wsact-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    // 强制重排以触发过渡
    void toastEl.offsetWidth;
    toastEl.classList.add('is-on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toastEl) toastEl.classList.remove('is-on');
    }, 2400);
  }

  /* --------------------------------------------------------- 剪贴板 */
  function writeClipboard(text) {
    return new Promise(function (resolve, reject) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(resolve, function () {
          legacyCopy(text) ? resolve() : reject(new Error('clipboard denied'));
        });
      } else {
        legacyCopy(text) ? resolve() : reject(new Error('clipboard unavailable'));
      }
    });
  }
  function legacyCopy(text) {
    // textarea 必须放在主文档 body（ShadowRoot 内 execCommand 通常不生效）
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    var ok = false;
    try {
      ta.select(); ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
    } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  /* ----------------------------------------------------------- 下载 */
  function fileName(url, mime) {
    var ext = 'png';
    if (mime) {
      if (/jpeg|jpg/i.test(mime)) ext = 'jpg';
      else if (/webp/i.test(mime)) ext = 'webp';
      else if (/svg/i.test(mime)) ext = 'svg';
      else if (/gif/i.test(mime)) ext = 'gif';
      else if (/png/i.test(mime)) ext = 'png';
    } else {
      var m = /\.(png|jpe?g|webp|svg|gif)(?:\?|#|$)/i.exec(url || '');
      if (m) ext = /jpe?g/i.test(m[1]) ? 'jpg' : m[1].toLowerCase();
    }
    var d = new Date(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    var stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
                '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    return '纹以载道-设计方案-' + stamp + '.' + ext;
  }

  function isSameOrigin(url) {
    try {
      var u = new URL(url, location.href);
      if (u.protocol === 'data:' || u.protocol === 'blob:') return true;
      return u.origin === location.origin;
    } catch (e) { return true; }
  }

  /* 已知不返回 Access-Control-Allow-Origin 的图片 CDN（智谱 CogView 水印图等）。
     对它们直接走同源代理，不再做必然失败的跨域 fetch —— 那会在控制台留下
     CORS 报错噪声。其他跨域域名仍先尝试直连 fetch，失败才回落代理。 */
  var PROXY_FIRST_HOSTS = ['ufileos.com', 'bigmodel.cn', 'zhipuai.cn'];
  function proxyFirst(url) {
    try {
      var h = new URL(url, location.href).hostname.toLowerCase();
      return PROXY_FIRST_HOSTS.some(function (d) {
        return h === d || h.slice(-(d.length + 1)) === '.' + d;
      });
    } catch (e) { return false; }
  }

  /* 嗅探真实图片格式：CDN 常把 JPEG 数据标成 image/png，仅看 Content-Type
     会给出错误扩展名。读前 12 字节魔数判定，失败时静默沿用原命名。 */
  function detectExt(blob) {
    try {
      return blob.slice(0, 12).arrayBuffer().then(function (buf) {
        var a = new Uint8Array(buf);
        if (a[0] === 0xFF && a[1] === 0xD8 && a[2] === 0xFF) return 'jpg';
        if (a[0] === 0x89 && a[1] === 0x50 && a[2] === 0x4E && a[3] === 0x47) return 'png';
        if (a[0] === 0x52 && a[1] === 0x49 && a[2] === 0x46 && a[3] === 0x46 &&
            a[8] === 0x57 && a[9] === 0x45 && a[10] === 0x42 && a[11] === 0x50) return 'webp';
        if (a[0] === 0x47 && a[1] === 0x49 && a[2] === 0x46) return 'gif';
        return null;
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function clickAnchor(href, name, revoke) {
    var a = document.createElement('a');
    a.href = href; a.download = name; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      a.remove();
      if (revoke) { try { URL.revokeObjectURL(href); } catch (e) {} }
    }, 30000);
  }

  function downloadImage(url, btn) {
    var original = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳ 正在获取原图…';
    var restore = function () {
      btn.disabled = false;
      btn.textContent = original;
    };

    // ① 同源 / data: / blob: —— 直接 a[download]
    if (isSameOrigin(url)) {
      clickAnchor(url, fileName(url));
      btn.classList.add('is-ok'); btn.textContent = '✅ 已开始下载';
      toast('高清原图已开始下载，请查看浏览器下载栏');
      setTimeout(function () { restore(); btn.classList.remove('is-ok'); }, 1800);
      return;
    }

    // ② 跨域 —— fetch 转 Blob。已知无 CORS 头的 CDN 直接走同源代理，
    //    其余域名先尝试直连 fetch，失败才回落代理（server.js 转发 /api/* 到后端）。
    var tryFetch = function (target) {
      return fetch(target, { mode: 'cors', credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      });
    };
    var proxyURL = '/api/image_proxy?url=' + encodeURIComponent(url);
    var first = proxyFirst(url)
      ? tryFetch(proxyURL)
      : tryFetch(url).catch(function () { return tryFetch(proxyURL); });
    first
      .then(function (blob) {
        if (!blob || !blob.size) throw new Error('empty blob');
        // 用魔数修正扩展名，避免 CDN 把 JPEG 标成 image/png 导致存成错后缀
        return detectExt(blob).then(function (ext) {
          var name = fileName(url, blob.type);
          if (ext) name = name.replace(/\.[a-z0-9]+$/i, '.' + ext);
          return { blob: blob, name: name };
        });
      })
      .then(function (got) {
        var obj = URL.createObjectURL(got.blob);
        clickAnchor(obj, got.name, true);
        btn.classList.add('is-ok'); btn.textContent = '✅ 已下载';
        toast('高清原图已保存（' + (got.blob.size / 1024).toFixed(0) + ' KB）');
        setTimeout(function () { restore(); btn.classList.remove('is-ok'); }, 1900);
      })
      .catch(function () {
        // ③ 兜底：让浏览器直接处理（可能新窗口打开），并给出可操作提示
        var a = document.createElement('a');
        a.href = url; a.download = fileName(url); a.target = '_blank';
        a.rel = 'noopener'; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(function () { a.remove(); }, 1000);
        restore();
        toast('已打开原图，可在图片上右键「另存为」保存高清文件');
      });
  }

  /* ------------------------------- 任务一：可视化色卡 + 复制色卡按钮 */
  var BUBBLE_SEL = '.wsrx__bubble, .bubble, .ai-chat__bubble';
  var COPY_LABEL = '📋 复制色卡 (Hex)';

  /** 点击时从 slot 反查当前气泡正文，避免闭包持有被流式重建掉的旧节点。 */
  function hexFromSlot(slot) {
    var row = slot.parentNode;
    var bubble = row ? row.querySelector(BUBBLE_SEL) : null;
    return extractHex(bubbleText(bubble || row));
  }

  function bindCopy(row, bubble) {
    var hex = extractHex(bubbleText(bubble));
    var slot = row.querySelector(':scope > .' + SLOT_CLS + '--copy');

    if (!slot) {
      slot = document.createElement('div');
      slot.className = SLOT_CLS + ' ' + SLOT_CLS + '--copy';

      // ② 一键复制色卡：数组格式 ['#a', '#b', '#c']
      var btn = makeBtn(COPY_LABEL, COPY_CLS + ' wsact-btn--sm', function (ev, b) {
        var cur = hexFromSlot(slot);
        if (!cur.length) { toast('未识别到 Hex 色值'); return; }
        writeClipboard(formatArray(cur)).then(function () {
          b.classList.add('is-ok');
          b.textContent = '✅ 已复制 (' + cur.length + ' 色数组)';
          toast('已复制 ' + cur.length + ' 色数组，可直接粘贴到设计软件');
          setTimeout(function () {
            b.classList.remove('is-ok');
            b.textContent = COPY_LABEL;
          }, 1900);
        }).catch(function () { toast('复制失败，请手动选中色值复制'); });
      });
      slot.appendChild(btn);
      row.appendChild(slot);
      row.classList.add(ROW_CLS);
    } else {
      // 兼容旧版残留：移除纯文字预览（已被可视化色卡取代）
      var stale = slot.querySelector(':scope > .wsact-hex');
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    }

    // ① 可视化色卡放在按钮上方、紧贴气泡下方；幂等重建，流式期间随色值增长更新
    var pal = slot.querySelector(':scope > .wsact-palette');
    if (!pal) {
      pal = document.createElement('div');
      pal.className = 'wsact-palette';
      pal.setAttribute('data-hex', '');
      slot.insertBefore(pal, slot.firstChild);
    }
    renderPalette(pal, hex);
  }

  /* 内置 AiColor 组件（#copilot=color 独立模式）的色卡面板兼容：
     色块是 button[title^="点击复制"]，把「复制色卡」放到色卡网格上方标题旁。 */
  function bindCopyPanel(root) {
    var swatches = root.querySelectorAll('button[title^="点击复制"]');
    if (!swatches.length) return;
    var grid = swatches[0].parentElement;
    var panel = grid && grid.parentElement;
    if (!panel || panel.querySelector(':scope > .' + SLOT_CLS + '--copy')) return;
    var slot = document.createElement('div');
    slot.className = SLOT_CLS + ' ' + SLOT_CLS + '--copy';
    var btn = makeBtn('📋 复制色卡 (Hex)', COPY_CLS + ' wsact-btn--sm', function (ev, b) {
      var hex = [];
      Array.prototype.forEach.call(
        panel.querySelectorAll('button[title^="点击复制"]'),
        function (s) {
          Array.prototype.forEach.call(
            extractHex((s.getAttribute('title') || '') + ' ' + (s.textContent || '')),
            function (h) { if (hex.indexOf(h) === -1) hex.push(h); }
          );
        }
      );
      if (!hex.length) { toast('未识别到 Hex 色值'); return; }
      writeClipboard(formatArray(hex)).then(function () {
        b.classList.add('is-ok');
        b.textContent = '✅ 已复制 (' + hex.length + ' 色数组)';
        toast('已复制 ' + hex.length + ' 色数组，可直接粘贴到设计软件');
        setTimeout(function () {
          b.classList.remove('is-ok');
          b.textContent = COPY_LABEL;
        }, 1900);
      }).catch(function () { toast('复制失败，请手动选中色值复制'); });
    });
    slot.appendChild(btn);
    if (grid.insertAdjacentElement) grid.insertAdjacentElement('afterend', slot);
    else if (grid.nextSibling) panel.insertBefore(slot, grid.nextSibling);
    else panel.appendChild(slot);
  }

  /* ---------------------------------------------- 任务二：下载原图按钮 */
  var IMG_SEL = 'img[alt="非遗纹样设计方案"], img.cp-img-in';
  function bindDownload(img) {
    var parent = img.parentNode;
    if (!parent) return;
    if (parent.querySelector(':scope > .' + SLOT_CLS + '--dl')) return;
    var slot = document.createElement('div');
    slot.className = SLOT_CLS + ' ' + SLOT_CLS + '--dl';
    var btn = makeBtn('⬇️ 下载高清原图', DL_CLS, function (ev, b) {
      var src = img.currentSrc || img.getAttribute('src') || '';
      if (!src) { toast('暂无可下载的图片'); return; }
      downloadImage(src, b);
    });
    slot.appendChild(btn);
    // 插到 <img> 正下方
    if (img.insertAdjacentElement) img.insertAdjacentElement('afterend', slot);
    else if (img.nextSibling) parent.insertBefore(slot, img.nextSibling);
    else parent.appendChild(slot);
  }

  /* ------------------------------------------------------------ 扫描 */
  function scanRoot(root) {
    if (!root || !root.querySelectorAll) return;
    injectCSS(root);

    // ① 含 Hex 的 bot 气泡 → 复制色卡按钮
    var rows = root.querySelectorAll('.wsrx__row--bot, .row--bot, .ai-chat__msg.is-bot');
    Array.prototype.forEach.call(rows, function (row) {
      var bubble = row.querySelector(BUBBLE_SEL) || row;
      var old = row.querySelector(':scope > .' + SLOT_CLS + '--copy');
      // 只认可见正文里的色值；纯问答气泡里画廊 <style> 的 CSS 颜色不算色卡，
      // 若之前误挂过按钮则主动清理，避免刷新后残留。
      if (!extractHex(bubbleText(bubble)).length) {
        if (old && old.parentNode === row) {
          row.removeChild(old);
          row.classList.remove(ROW_CLS);
        }
        return;
      }
      try { bindCopy(row, bubble); } catch (e) {}
    });

    // ② 设计方案图 <img>（有真实 src）→ 下载按钮
    var imgs = root.querySelectorAll(IMG_SEL);
    Array.prototype.forEach.call(imgs, function (img) {
      var src = img.getAttribute('src') || '';
      if (!src || src.length < 8) return;           // 跳过空的上传预览
      try { bindDownload(img); } catch (e) {}
    });

    // ③ 内置 AiColor 色卡面板
    try { bindCopyPanel(root); } catch (e) {}
  }

  /* ------------------------------------------ MutationObserver 管理 */
  var observers = [];      // { root, mo }
  var scanTimer = null;
  var roots = [];          // 已注册的根：document + 各 ShadowRoot

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
      scanTimer = null;
      safeScan();
    }, 90);
  }

  function observe(root) {
    if (!root || typeof MutationObserver === 'undefined') return;
    injectCSS(root);
    var mo = new MutationObserver(function () {
      // 全部 mutation 无条件参与 90ms 防抖调度。scanRoot 幂等（已挂按钮就不再写
      // DOM），所以自身写入引起的回调只会带来一次空扫描，不会死循环，也不会
      // 因「扫描锁」吞掉流式重建的真实变化。
      scheduleScan();
    });
    try {
      mo.observe(root === document ? document.documentElement : root, {
        childList: true, subtree: true, characterData: true
      });
      observers.push({ root: root, mo: mo });
      roots.push(root);
    } catch (e) { /* 某些根不可观察 */ }
  }

  function discoverRoots() {
    // 主文档
    if (!roots.length) observe(document);
    // 动态发现 ShadowRoot（/ai 工作台是一个 open shadow host）
    var hosts = document.querySelectorAll('.ai-copilot-host, [data-wsact-shadow]');
    Array.prototype.forEach.call(hosts, function (h) {
      if (h.shadowRoot && roots.indexOf(h.shadowRoot) === -1) observe(h.shadowRoot);
    });
  }

  /** 执行一次全量扫描。scanRoot 内部所有写入都是幂等的，因此不需要扫描锁：
      锁反而会在严格模式下因变量未声明而抛错，吞掉整轮扫描。 */
  function safeScan() {
    discoverRoots();
    roots.forEach(function (r) {
      try { scanRoot(r); } catch (e) {}
    });
  }

  window.AiActions = {
    scan: function (root) {
      if (root && root !== document) { try { scanRoot(root); } catch (e) {} }
      else safeScan();
    },
    extractHex: extractHex,
    formatArray: formatArray,
    isDarkColor: isDarkColor,
    bubbleText: bubbleText,
    renderPalette: renderPalette,
    toast: toast
  };

  // 启动：立即 + DOMContentLoaded + 延时补扫（Vue/Shadow DOM 挂载较晚）
  function boot() { discoverRoots(); scheduleScan(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      injectCSS(document); boot();
    });
  } else {
    injectCSS(document); boot();
  }
  [600, 1600, 3200].forEach(function (ms) { setTimeout(boot, ms); });
  // 低频轮询兜底：流式打字机期间 DOM 可能被整体重建，MutationObserver 偶发
  // 丢失时仍能保证按钮最终出现（幂等写入，无副作用）。
  setInterval(function () { if (!document.hidden) scheduleScan(); }, 1400);
  window.addEventListener('hashchange', boot);
  window.addEventListener('popstate', boot);
})();
