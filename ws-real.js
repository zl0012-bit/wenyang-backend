/* ==========================================================================
   ws-real.js —— 主站 AI 助手（Shadow DOM copilot）真接入补丁
   --------------------------------------------------------------------------
   背景：主站的「智能体共创工作台」由 assets/copilot/ai-copilot.js 挂载，
   全部 UI 位于 .ai-copilot-host 的 open Shadow DOM 内，聊天逻辑是本地模拟
   （ai_glm.js）。本补丁不改编译产物，运行时做三件事：
     1) 隐藏假消息列表 / 假输入行 / 报错横幅；
     2) 把真实聊天组件（fetch /api/agent_chat：文本 + 图片上传 + ReAct 开关）
        挂进当前 Tab 的聊天卡片；
     3) 把真实响应映射到 .cp__chip 标签行：RAG 命中 → query_heritage_db、
        视觉工具 → generate_pattern_image、ReAct 多轮 → Function Calling、
        HTTP 200 → GLM-4-Flash 实时流式，点亮带呼吸光效。
   Tab 切换 / 路由跳转后卡片重建时，MutationObserver 会自动重新打补丁，
   会话历史保留（模块级缓存）。
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------- 会话缓存（按板块隔离，互不串台） ---------------- */
  var HISTORIES = {};   // key: 板块名 -> [{side,kind,text,data,imgSrc,welcome?}]
  var lastTab = null;   // 上次渲染的板块（用于检测切换并刷新当前卡片）
  function normalizeTab(name) {
    // 去掉开头的图标 emoji，只留中文板块名（如 "🔍纹样识别" -> "纹样识别"）
    return (name || '').replace(/^[^\u4e00-\u9fff]+/, '').trim() || 'AI 导览';
  }
  function curTab() { return normalizeTab(activeTabName(getSR())); }
  function getHistory(tab) {
    if (!HISTORIES[tab]) HISTORIES[tab] = [];
    return HISTORIES[tab];
  }
  function welcomeFor(tab) {
    var map = {
      '纹样识别': '你好，我是「纹以载道」纹样识别助手。描述你看到的纹样（造型 / 颜色 / 载体），我来帮你辨认。',
      '纹样共创': '你好，我是「纹以载道」文创设计助手。告诉我主题与载体，我为你生成设计方案。',
      'AI 导览': '你好，我是「纹以载道」AI 导览（已接入真实模型与后端）。可以问我纹样寓意、对比不同朝代纹样，或上传图片做分析。',
      '故事剧场': '你好，我是「纹以载道」故事编剧。给我一个纹样或主题，我为你写一段微故事。',
      '智能配色': '你好，我是「纹以载道」配色设计师。给我纹样主题与载体，我输出一套 5 色方案。',
      '问答知识库': '你好，我是「纹以载道」知识库讲解员。问我任何关于非遗纹样的问题吧。'
    };
    return map[tab] || '你好，我是「纹以载道」AI 助手（已接入真实模型与后端）。可以问我纹样寓意、对比朝代纹样，或上传图片做分析。';
  }

  /* ---------------- CSS（注入 Shadow Root） ---------------- */
  var CSS = ''
    + '.wsrx{display:flex;flex-direction:column;flex:1;min-height:0;font-family:inherit}'
    // 卡片本体是 Tailwind 的 max-w-3xl(768px)，在 1110px 的宿主里两侧各空 179px，
    // 成段故事读起来像窄栏。只放宽「聊天卡」这一张，纹样共创的双栏工作台不动。
    + '.cp__body > section.mx-auto:has(.wsrx){max-width:900px !important}'
    // 消息列表
    + '.wsrx__body{flex:1;min-height:0;overflow-y:auto;padding:18px 22px;display:flex;flex-direction:column;gap:14px}'
    + '.wsrx__row{display:flex}.wsrx__row--user{justify-content:flex-end}'
    // 气泡加宽：故事/导览这类成段正文原来被 82% 挤成窄条，读起来费劲。
    // 机器人侧放到 94% 并加大内边距与行高；用户侧保持 78%，避免长问题铺满整行。
    + '.wsrx__bubble{max-width:94%;padding:14px 20px;border-radius:16px;line-height:1.78;font-size:14.5px;white-space:pre-wrap;word-break:break-word}'
    // 用户侧 85% + 等比内边距：成句提问不再被挤成两行小方块
    + '.wsrx__row--user .wsrx__bubble{max-width:85%;padding:12px 18px;line-height:1.62;font-size:14px}'
    + '.wsrx__row--user .wsrx__bubble{background:#8B0000;color:#fff;border-bottom-right-radius:4px}'
    + '.wsrx__row--bot .wsrx__bubble{background:#fdf5f2;border:1px solid rgba(139,0,0,.18);border-bottom-left-radius:4px;color:#3a2a24}'
    + '.wsrx__err{background:#fdecea;color:#a1261b;border:1px solid #f3c2bb;padding:12px 18px;border-radius:12px;font-size:13px;max-width:92%;line-height:1.7}'
    + '.wsrx__sec{font-size:12px;color:#8B0000;margin-top:8px;font-weight:600}'
    + '.wsrx__pal{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}'
    + '.wsrx__sw{width:54px;text-align:center;font-size:10px;color:#9a8f86;cursor:pointer}'
    + '.wsrx__sw i{display:block;width:54px;height:54px;border-radius:8px;border:1px solid rgba(0,0,0,.08);margin-bottom:3px}'
    + '.wsrx__sw b{color:#3a2a24;font-size:11px}'
    + '.wsrx__layers{margin:8px 0 0;font-size:12px;color:#9a8f86;padding-left:16px}'
    + '.wsrx__imgwrap{position:relative;margin-top:8px;max-width:300px}'
    + '.wsrx__imgwrap img,.wsrx__imgwrap canvas{width:100%;border-radius:10px;display:block;border:1px solid rgba(139,0,0,.18)}'
    + '.wsrx__imgwrap canvas{position:absolute;left:0;top:0;pointer-events:none}'
    + '.wsrx__src{margin-top:8px;font-size:12px}'
    + '.wsrx__src summary{cursor:pointer;color:#8B0000}'
    + '.wsrx__srci{padding:4px 0;border-bottom:1px dashed rgba(139,0,0,.18)}'
    // 纹样共创 · AI 生成效果图
    + '.wsrx__gen{margin-top:10px}'
    + '.wsrx__gen .wsrx__sec{display:flex;align-items:center;gap:8px}'
    + '.wsrx__gen .wsrx__sec a{font-weight:400;font-size:11px;color:#9a8f86;text-decoration:underline;margin-left:auto}'
    + '.wsrx__genimg{display:block;width:100%;max-width:320px;aspect-ratio:1/1;object-fit:cover;'
    +   'border-radius:10px;border:1px solid rgba(139,0,0,.18);margin-top:6px;background:#fdf5f2}'
    + '.wsrx__genph{width:100%;max-width:320px;aspect-ratio:1/1;border-radius:10px;'
    +   'border:1px dashed rgba(139,0,0,.28);background:linear-gradient(110deg,#fdf5f2 30%,#f6e9e3 50%,#fdf5f2 70%);'
    +   'background-size:200% 100%;animation:wsrxGenShine 1.4s linear infinite;'
    +   'display:grid;place-items:center;font-size:12px;color:#9a8f86;margin-top:6px}'
    + '@keyframes wsrxGenShine{0%{background-position:200% 0}100%{background-position:-200% 0}}'
    // 底部输入区
    + '.wsrx__ft{border-top:1px solid rgba(139,0,0,.15);padding:10px 12px;background:#fff}'
    + '.wsrx__ftop{display:flex;gap:10px;align-items:center;margin-bottom:8px;font-size:12px;color:#9a8f86}'
    + '.wsrx__pv{position:relative;width:44px;height:44px;border-radius:8px;overflow:hidden;border:1px solid rgba(139,0,0,.2)}'
    + '.wsrx__pv img{width:100%;height:100%;object-fit:cover}'
    + '.wsrx__pv button{position:absolute;right:-4px;top:-4px;border:none;background:#8B0000;color:#fff;border-radius:50%;width:18px;height:18px;cursor:pointer;font-size:11px;line-height:1}'
    + '.wsrx__frow{display:flex;gap:8px}'
    + '.wsrx__in{flex:1;padding:10px 14px;border:1px solid rgba(139,0,0,.2);border-radius:22px;font-size:14px;outline:none;background:#fff;color:#3a2a24}'
    + '.wsrx__in:focus{border-color:#8B0000;box-shadow:0 0 0 3px rgba(139,0,0,.12)}'
    + '.wsrx__btn{border:none;border-radius:22px;padding:0 16px;font-size:14px;cursor:pointer}'
    + '.wsrx__btn--send{background:linear-gradient(135deg,#8B0000,#A52A2A);color:#fff;font-weight:600}'
    + '.wsrx__btn--img{background:#fdf5f2;border:1px solid rgba(139,0,0,.2);padding:0 12px}'
    + '.wsrx__react{display:inline-flex;align-items:center;gap:5px;cursor:pointer;user-select:none}'
    + '.wsrx__react input{accent-color:#cfa23c;width:14px;height:14px;cursor:pointer}'
    + '.wsrx__typing span{display:inline-block;width:6px;height:6px;margin:0 1px;background:#9a8f86;border-radius:50%;animation:wsrxBlink 1.2s infinite both}'
    + '.wsrx__typing span:nth-child(2){animation-delay:.2s}.wsrx__typing span:nth-child(3){animation-delay:.4s}'
    + '@keyframes wsrxBlink{0%,80%,100%{opacity:.2}40%{opacity:1}}'
    // 极速预判：点击发送同帧出现「AI 正在思考…」+ 三点跳动，首字到达即被替换
    + '.wsrx__thinking{display:flex;align-items:center;min-height:22px}'
    + '.wsrx__thinking-txt{font-size:12px;color:#9a8f86;letter-spacing:.06em;margin-right:7px}'
    + '.wsrx__thinking i{display:inline-block;width:6px;height:6px;margin:0 1px;background:#9a8f86;border-radius:50%;animation:wsrxBlink 1.2s infinite both}'
    + '.wsrx__thinking i:nth-of-type(2){animation-delay:.2s}.wsrx__thinking i:nth-of-type(3){animation-delay:.4s}'
    // 标签点亮
    + '.cp__chip.wsrx-on{background:#8B0000!important;color:#fff6d8!important;border-color:#8B0000!important;'
    + 'box-shadow:0 0 0 0 rgba(139,0,0,.5);animation:wsrxPulse 1.8s infinite}'
    + '@keyframes wsrxPulse{0%{box-shadow:0 0 0 0 rgba(139,0,0,.45)}70%{box-shadow:0 0 0 8px rgba(139,0,0,0)}100%{box-shadow:0 0 0 0 rgba(139,0,0,0)}}';

  /* ---------------- 工具 ---------------- */
  function getSR() {
    var host = document.querySelector('.ai-copilot-host');
    return host && host.shadowRoot ? host.shadowRoot : null;
  }
  function ensureStyle(sr) {
    if (sr.getElementById('wsrx-style')) return;
    var st = document.createElement('style');
    st.id = 'wsrx-style';
    st.textContent = CSS;
    sr.appendChild(st);
  }
  function activeTabName(sr) {
    if (!sr) return 'AI 导览';
    var t = sr.querySelector('.cp__tab.is-on') || sr.querySelector('.cp__tab');
    return (t && t.textContent || '').trim() || 'AI 导览';
  }
  function litChip(sr, keyword) {
    sr.querySelectorAll('.cp__chip').forEach(function (c) {
      if ((c.textContent || '').indexOf(keyword) !== -1) c.classList.add('wsrx-on');
    });
  }
  function markTools(sr, data) {
    var tr = (data && data.tool_results) || {};
    var rag = (tr.rag && tr.rag.count > 0) || ((data.sources || []).length > 0);
    var vision = !!(tr.vision && (tr.vision.extract_color || tr.vision.segment_pattern));
    var reacted = !!(tr.react_trace && tr.react_trace.length > 0);
    if (rag) litChip(sr, 'query_heritage_db');
    if (vision) litChip(sr, 'generate_pattern_image');
    if (reacted) litChip(sr, 'Function Calling');
    litChip(sr, 'GLM-4-Flash');
  }

  /* ---------------- 渲染 ---------------- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  /** 首个 delta 到达时把「正在思考」气泡换成正文，幂等。 */
  function clearThinking(b) {
    if (b && b.classList && b.classList.contains('wsrx__thinking')) {
      b.classList.remove('wsrx__thinking');
      b.textContent = '';
    }
  }
  /** 构造一个带文案 + 三点动画的极速预判 Loading 气泡。 */
  function thinkingBubble() {
    var b = el('div', 'wsrx__bubble wsrx__thinking', '');
    b.innerHTML = '<span class="wsrx__thinking-txt">AI 正在思考…</span><i></i><i></i><i></i>';
    return b;
  }
  function renderInto(body, entry) {
    var row = el('div', 'wsrx__row wsrx__row--' + entry.side);
    if (entry.kind === 'text') {
      row.appendChild(el('div', 'wsrx__bubble', entry.text));
    } else if (entry.kind === 'error') {
      var er = el('div', 'wsrx__err', '⚠️ ' + entry.text);
      row.appendChild(er); row.style.justifyContent = 'flex-start';
    } else if (entry.kind === 'typing') {
      var tp = el('div', 'wsrx__bubble wsrx__typing');
      tp.innerHTML = '<span></span><span></span><span></span>';
      row.appendChild(tp);
    } else if (entry.kind === 'rich') {
      var b = el('div', 'wsrx__bubble');
      var d = entry.data || {};
      if (d.answer) b.appendChild(el('div', null, d.answer));
      var tr = d.tool_results || {};
      // 色板
      var colors = tr.vision && tr.vision.extract_color;
      if (colors && colors.palette && colors.palette.length) {
        b.appendChild(el('div', 'wsrx__sec', '🎨 提取到的主色板（点击色块复制 Hex）'));
        var pal = el('div', 'wsrx__pal');
        colors.palette.forEach(function (c) {
          var s = el('div', 'wsrx__sw');
          s.innerHTML = '<i style="background:' + c.hex + '"></i><b>' + c.hex + '</b>' + (c.ratio * 100).toFixed(0) + '%';
          s.title = '点击复制 ' + c.hex;
          s.addEventListener('click', function () { navigator.clipboard && navigator.clipboard.writeText(c.hex); });
          pal.appendChild(s);
        });
        b.appendChild(pal);
      }
      // 图层 bbox
      var seg = tr.vision && tr.vision.segment_pattern;
      if (seg && entry.imgSrc) {
        var wrap = el('div', 'wsrx__imgwrap');
        var img = document.createElement('img'); img.src = entry.imgSrc;
        var cv = document.createElement('canvas');
        img.onload = function () {
          cv.width = img.clientWidth; cv.height = img.clientHeight;
          var ctx = cv.getContext('2d');
          var sx = img.clientWidth / img.naturalWidth, sy = img.clientHeight / img.naturalHeight;
          (seg.layers || []).slice(0, 12).forEach(function (ly, i) {
            var p = ly.bbox;
            ctx.strokeStyle = 'hsl(' + ((i * 47) % 360) + ' 70% 45%)'; ctx.lineWidth = 2;
            ctx.strokeRect(p[0] * sx, p[1] * sy, p[2] * sx, p[3] * sy);
            ctx.fillStyle = 'hsl(' + ((i * 47) % 360) + ' 70% 45%)';
            ctx.font = '11px sans-serif';
            ctx.fillText('#' + ly.label, p[0] * sx + 2, p[1] * sy + 12);
          });
        };
        wrap.appendChild(img); wrap.appendChild(cv);
        b.appendChild(wrap);
      }
      if (seg) {
        var ul = el('ul', 'wsrx__layers');
        ul.innerHTML = '<li>🔪 共切分出 <b>' + seg.num_components + '</b> 个图层（可用于分层再设计）</li>' +
          (seg.layers || []).slice(0, 3).map(function (l) {
            return '<li>图层 #' + l.label + '：面积占比 ' + (l.area_ratio * 100).toFixed(1) + '%</li>';
          }).join('');
        b.appendChild(ul);
      }
      // 来源
      if (d.sources && d.sources.length) {
        var det = el('details', 'wsrx__src');
        det.appendChild(el('summary', null, '📚 检索到 ' + d.sources.length + ' 枚相关纹样'));
        d.sources.slice(0, 5).forEach(function (s) {
          var it = el('div', 'wsrx__srci');
          it.innerHTML = '<b>' + s.name + '</b> · ' + s.origin_std + ' · ' + s.theme +
            ' <span style="color:#9a8f86">相似度 ' + s.score + '</span>';
          det.appendChild(it);
        });
        b.appendChild(det);
      }
      // 多模态配图：文字气泡下方渲染站内纹样缩略图画廊（点击直达纹样详情页）
      if (d.images && d.images.length && window.AiGallery) {
        try { window.AiGallery.render(b, d); } catch (e) { /* 画廊异常不影响正文 */ }
      }
      // 纹样共创专属：追加「AI 生成效果图」区（真实调用 /api/generate_image）
      // agent_chat 只回文字方案 + 馆内参考纹样，用户看不到"新生成的作品"；
      // 这里补上真正的文生图结果，让共创闭环（生成 → 预览 → 下载）。
      if (entry.genPrompt) {
        mountGeneratedImage(b, entry);
      }
      if (!b.childNodes.length) b.textContent = '（暂无返回内容）';
      row.appendChild(b);
    }
    body.appendChild(row);
    body.scrollTop = body.scrollHeight;
  }
  /* ---------------- 纹样共创：把用户口语描述包装成生图提示词 ---------------- */
  function buildGenPrompt(text) {
    var t = (text || '').trim().replace(/[。.]$/, '');
    return t + '，中国传统纹样平面图案设计，白底，正视图，构图居中，线条清晰，' +
      '适合印花与文创应用，无文字无水印，高清';
  }

  /* ---------------- 纹样共创：真实文生图结果挂载 ---------------- */
  // agent_chat 返回的是文字设计方案 + 馆内参考纹样，不是"新作品"。
  // 这里调 /api/generate_image（智谱 CogView）生成一张真正的效果图，
  // 完成后追加到气泡内；失败则静默降级为纯文字方案，不影响演示节奏。
  function mountGeneratedImage(bubble, entry) {
    var box = el('div', 'wsrx__gen');
    box.innerHTML =
      '<div class="wsrx__sec">🎨 AI 生成效果图</div>' +
      '<div class="wsrx__genph">正在绘制纹样…</div>';
    bubble.appendChild(box);
    var ph = box.querySelector('.wsrx__genph');

    if (entry.genUrl) { renderGenImg(box, entry.genUrl); return; }

    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 120000) : null;

    fetch('/api/generate_image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: entry.genPrompt, size: '1024x1024' }),
      signal: ctl ? ctl.signal : undefined
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (timer) clearTimeout(timer);
        if (!j || !j.url) throw new Error((j && j.error) || 'empty');
        entry.genUrl = j.url;          // 记入历史，切走再切回不重复生图
        renderGenImg(box, j.url);
        litChip(document.querySelector('.ai-copilot-host') &&
                document.querySelector('.ai-copilot-host').shadowRoot, 'generate_pattern_image');
      })
      .catch(function () {
        if (timer) clearTimeout(timer);
        // 生图失败：安静降级，保留上方文字方案
        box.innerHTML = '<div class="wsrx__sec">💡 设计要点（生图服务暂不可用，已保留方案）</div>';
      });
  }

  function renderGenImg(box, url) {
    var img = document.createElement('img');
    img.className = 'wsrx__genimg';
    img.alt = 'AI 生成的纹样效果图';
    img.src = url;
    img.onerror = function () {
      box.innerHTML = '<div class="wsrx__sec">💡 效果图加载失败，已保留文字方案</div>';
    };
    box.innerHTML = '<div class="wsrx__sec">🎨 AI 生成效果图 <a href="' + url +
      '" target="_blank" rel="noopener" download>下载原图</a></div>';
    box.appendChild(img);
    var b = box.closest('.wsrx__body');
    if (b) b.scrollTop = b.scrollHeight;
  }

  function repaint(body) {
    var tab = curTab();
    var H = getHistory(tab);
    if (!H.length) {
      H.push({ side: 'bot', kind: 'text', text: welcomeFor(tab), welcome: true });
    }
    body.innerHTML = '';
    H.forEach(function (e) { renderInto(body, e); });
  }

  /* ---------------- 打补丁：替换单个聊天卡 ---------------- */
  function patchCard(sr, card) {
    if (card.__wsrx) return;
    card.__wsrx = true;

    // 1) 找假节点
    var input = card.querySelector('input, textarea');
    var fakeRow = null;
    if (input) {
      fakeRow = input.parentElement;
      while (fakeRow && fakeRow !== card && !(fakeRow.querySelector('button'))) fakeRow = fakeRow.parentElement;
    }
    var fakeList = null;
    Array.prototype.some.call(card.querySelectorAll('div'), function (d) {
      var c = (d.className || '').toString();
      if (c.indexOf('space-y-4') !== -1 && c.indexOf('overflow-y-auto') !== -1) { fakeList = d; return true; }
      return false;
    });
    // 报错横幅（「当前端点」/「AI 连接异常」）
    card.querySelectorAll('div,section').forEach(function (d) {
      var t = d.textContent || '';
      if ((t.indexOf('当前端点') !== -1 || t.indexOf('AI 连接异常') !== -1) && d.children.length && d.children.length <= 6 && t.length < 220) {
        d.style.display = 'none';
      }
    });

    // 旧版共创空壳面板：cp__body 里残留的「AI 工作流 / 设计方案图 / 设计思路」
    // 三栏骨架永远空白（真实结果由本补丁的 wsrx 聊天区承载），却占掉
    // 600+px 高度把聊天区挤到折叠线以下，录屏时观感极差 —— 直接隐藏。
    var cpBody = card.querySelector('.cp__body') || card;
    Array.prototype.forEach.call(cpBody.children, function (ch) {
      if (ch.classList && ch.classList.contains('wsrx')) return;   // 保留真实聊天区
      var t = ch.textContent || '';
      if (t.indexOf('AI 工作流') !== -1 || t.indexOf('设计方案图') !== -1 || t.indexOf('设计思路') !== -1) {
        ch.style.display = 'none';
      }
    });

    // 2) 隐藏假 UI
    if (fakeList) fakeList.style.display = 'none';
    if (fakeRow) fakeRow.style.display = 'none';

    // 3) 挂真实聊天
    var wrap = el('div', 'wsrx');
    wrap.innerHTML =
      '<div class="wsrx__body"></div>' +
      '<div class="wsrx__ft">' +
        '<div class="wsrx__ftop" style="display:none">' +
          '<div class="wsrx__pv"><img alt="预览"/><button title="移除">×</button></div>' +
          '<span>已选图片，发送时将一并上传</span>' +
        '</div>' +
        '<div class="wsrx__frow">' +
          '<label class="wsrx__react"><input type="checkbox"/> ReAct 多轮</label>' +
          '<input class="wsrx__in" type="text" placeholder="问问纹样的寓意、对比朝代纹样，或上传图片做再设计…"/>' +
          '<button class="wsrx__btn wsrx__btn--img" title="上传图片">🖼</button>' +
          '<button class="wsrx__btn wsrx__btn--send">发送</button>' +
          '<input type="file" accept="image/*" hidden/>' +
        '</div>' +
      '</div>';
    card.appendChild(wrap);

    var body = wrap.querySelector('.wsrx__body');
    var inEl = wrap.querySelector('.wsrx__in');
    var sendB = wrap.querySelector('.wsrx__btn--send');
    var imgB = wrap.querySelector('.wsrx__btn--img');
    var fileEl = wrap.querySelector('input[type=file]');
    var reactEl = wrap.querySelector('.wsrx__react input');
    var pvArea = wrap.querySelector('.wsrx__ftop');
    var pvImg = pvArea.querySelector('img');
    var pvClr = pvArea.querySelector('button');
    var pending = null;

    repaint(body);

    function scrollDown() { body.scrollTop = body.scrollHeight; }
    // 以「发送时所在板块」为归属，避免异步返回时用户已切走导致串台
    function makeApi(tab) {
      function push(entry) { getHistory(tab).push(entry); if (curTab() === tab) renderInto(body, entry); }
      function pushTyping() { var e = { side: 'bot', kind: 'typing' }; getHistory(tab).push(e); if (curTab() === tab) renderInto(body, e); return e; }
      function removeEntry(e) { var H = getHistory(tab); var i = H.indexOf(e); if (i !== -1) H.splice(i, 1); if (curTab() === tab) { var rows = body.children; if (rows[i]) rows[i].remove(); } }
      return { push: push, pushTyping: pushTyping, removeEntry: removeEntry };
    }

    function clearImage() { pending = null; fileEl.value = ''; pvArea.style.display = 'none'; }
    pvClr.addEventListener('click', clearImage);
    // 暴露给 Tab 切换逻辑：切走时清空本板块的图片临时状态，杜绝跨板块串台
    if (typeof sec !== 'undefined' && sec) sec.__clearImage = clearImage;
    imgB.addEventListener('click', function () { fileEl.click(); });
    fileEl.addEventListener('change', function () {
      var f = fileEl.files[0]; if (!f) return;
      pending = f;
      pvImg.src = URL.createObjectURL(f);
      pvArea.style.display = 'flex';
    });

    function submit() {
      if (submit._busy) return;
      var text = inEl.value.trim();
      if (!text && !pending) return;
      var hasImg = !!pending;
      var submitTab = curTab();
      var api = makeApi(submitTab);
      var page = submitTab;
      // 纯文本 / 创作类板块（故事剧场、AI 导览、问答知识库）不使用图片：
      // 强制丢弃可能残留的「待上传图片」flag，避免跨板块串台（如把图误带进故事剧场触发再设计逻辑）。
      var NO_IMG_TABS = { '故事剧场': 1, 'AI 导览': 1, '问答知识库': 1 };
      if (NO_IMG_TABS[page]) { hasImg = false; clearImage(); }
      // 取当前板块独立历史（排除欢迎语），作为多轮上下文发给后端
      var hist = getHistory(submitTab)
        .filter(function (e) { return !e.welcome; })
        .map(function (e) {
          if (e.side === 'user') return { role: 'user', content: (e.text || '').replace(/\n🖼 \[图片\]$/, '').trim() };
          var c = e.kind === 'rich' ? ((e.data && e.data.answer) || '') : (e.text || '');
          if (!c) return null;
          return { role: 'assistant', content: c };
        })
        .filter(function (m) { return m && m.content; });

      api.push({ side: 'user', kind: 'text', text: (text ? text + '\n' : '') + (hasImg ? '🖼 [图片]' : '') });
      inEl.value = '';

      // —— 纹样识别 Tab + 带图：走流式视觉识别接口 /api/vision_identify（打字机效果）——
      if (hasImg && page === '纹样识别') {
        submit._busy = true;
        // 打字机气泡（同时记入板块历史，切走再切回仍可还原）
        var streamEntry = { side: 'bot', kind: 'text', text: '' };
        getHistory(submitTab).push(streamEntry);
        var srow = el('div', 'wsrx__row wsrx__row--bot');
        var sbub = thinkingBubble();
        srow.appendChild(sbub); body.appendChild(srow); scrollDown();
        litChip(sr, 'GLM-4-Flash');
        var vfd = new FormData();
        vfd.append('user_input', text || '请识别这张纹样图案并介绍');
        vfd.append('image', pending);
        var vst = prefStyle();
        if (vst) vfd.append('style', vst);
        streamVisionIdentify(vfd,
          function (delta) {
            clearThinking(sbub);
            streamEntry.text += delta;
            sbub.textContent = streamEntry.text;
            scrollDown();
          },
          function () { submit._busy = false; clearImage(); scrollDown(); },
          function (errMsg) {
            clearThinking(sbub);
            streamEntry.text = '⚠️ ' + errMsg + '。请确认后端已启动（./start.sh）。';
            sbub.textContent = streamEntry.text;
            submit._busy = false; clearImage();
          });
        return;
      }

      submit._busy = true;
      var mode = reactEl.checked ? 'react' : 'default';

      // 打字机气泡（同时记入板块历史，切走再切回仍可还原）
      var streamEntry = { side: 'bot', kind: 'text', text: '' };
      getHistory(submitTab).push(streamEntry);
      var srow = el('div', 'wsrx__row wsrx__row--bot');
      var sbub = thinkingBubble();
      srow.appendChild(sbub); body.appendChild(srow); scrollDown();
      litChip(sr, 'GLM-4-Flash');

      // finish 约定先 removeEntry(typing) 再 push rich；这里把 streamEntry 当 typing，
      // onDone 即把临时 text 气泡升级为含参考来源的 rich 气泡。
      var typing = streamEntry;

      var finish = function (data, imgSrc) {
        api.removeEntry(typing);
        var entry = { side: 'bot', kind: 'rich', data: data, imgSrc: imgSrc || null };
        // 纹样共创：把用户描述包装成生图提示词，交由 mountGeneratedImage 出真实效果图
        if (page === '纹样共创' && text) {
          entry.genPrompt = buildGenPrompt(text);
        }
        api.push(entry);
        markTools(sr, data);
        submit._busy = false;
      };
      var fail = function (msg) {
        api.removeEntry(typing);
        api.push({ side: 'bot', kind: 'error', text: msg + '。请确认后端已启动（./start.sh）。' });
        submit._busy = false;
      };
      // 重试提示：仅渲染到当前板块（防止异步切走后串台）
      var onRetryHint = function (errMsg, n) {
        api.push({ side: 'bot', kind: 'text', text: '⏳ ' + errMsg + '，正在第 ' + n + ' 次重试…' });
      };

      if (hasImg) {
        var fd = new FormData();
        fd.append('user_input', text || '请分析这张纹样的配色与结构，并给出再设计建议');
        fd.append('current_page', page);
        fd.append('image', pending);
        fd.append('mode', mode);
        fd.append('history', JSON.stringify(hist));
        var fr = new FileReader();
        fr.onload = function () {
          var dataURL = fr.result;
          callAgentStream(fd, true, {
            onRetry: onRetryHint,
            onDelta: function (d) { clearThinking(sbub); streamEntry.text = d; sbub.textContent = d; scrollDown(); },
            onDone: function (meta) {
              finish({
                answer: streamEntry.text,
                sources: (meta && meta.sources) || [],
                tool_results: (meta && meta.tool_results) || {},
                intent: (meta && meta.intent) || null,
                images: (meta && meta.images) || [],
                patterns: (meta && meta.patterns) || []
              }, dataURL || null);
              clearImage();
            },
            onError: function (msg) { clearImage(); fail(msg); }
          });
        };
        fr.readAsDataURL(pending);
      } else {
        callAgentStream(
          { user_input: text, current_page: page, has_image: false, mode: mode, history: hist },
          false,
          {
            onRetry: onRetryHint,
            onDelta: function (d) { clearThinking(sbub); streamEntry.text = d; sbub.textContent = d; scrollDown(); },
            onDone: function (meta) {
              finish({
                answer: streamEntry.text,
                sources: (meta && meta.sources) || [],
                tool_results: (meta && meta.tool_results) || {},
                intent: (meta && meta.intent) || null,
                images: (meta && meta.images) || [],
                patterns: (meta && meta.patterns) || []
              }, null);
            },
            onError: function (msg) { fail(msg); }
          }
        );
      }
    }
    sendB.addEventListener('click', submit);
    inEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  }

  /* ---------------- 带超时与重试的 agent_chat 请求 ---------------- */
  // 防「慢响应 → 网关 524 超时」：单次请求 60s 超时（AbortController），
  // 超时/网络错误自动重试 1 次（指数退避），重试前通过 onRetry 给出提示。
  var FETCH_TIMEOUT = 60000;   // 单次请求超时（毫秒）
  var FETCH_RETRIES = 1;       // 超时/网络错误重试次数
  // 偏好联动：读取个人中心「偏好设置」保存的风格（localStorage.wenyao:preferences），
  // 随每次 agent_chat 请求携带 style 字段，后端据此拼接 System Prompt。
  function prefStyle() {
    try {
      var p = JSON.parse(localStorage.getItem('wenyao:preferences') || 'null');
      return (p && p.favoriteStyle) ? String(p.favoriteStyle) : '';
    } catch (e) { return ''; }
  }
  function _wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function callAgent(body, isFormData, opts) {
    opts = opts || {};
    var style = prefStyle();
    if (style) {
      if (isFormData) { try { body.append('style', style); } catch (e) { /* ignore */ } }
      else { try { body = Object.assign({}, body, { style: style }); } catch (e) { /* ignore */ } }
    }
    function attempt() {
      var ac = new AbortController();
      var to = setTimeout(function () { ac.abort(); }, FETCH_TIMEOUT);
      var init = { method: 'POST', signal: ac.signal };
      if (isFormData) init.body = body;
      else { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
      return fetch('/api/agent_chat', init)
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(function (data) { clearTimeout(to); return { ok: true, data: data }; })
        .catch(function (e) {
          clearTimeout(to);
          var isTimeout = !!(e && e.name === 'AbortError');
          var error = isTimeout
            ? ('请求超时（>' + Math.round(FETCH_TIMEOUT / 1000) + 's），后端响应较慢或网关超时')
            : ('网络错误：' + (e && e.message ? e.message : '未知'));
          return { ok: false, error: error, isTimeout: isTimeout };
        });
    }
    return (async function () {
      for (var i = 0; i <= FETCH_RETRIES; i++) {
        var r = await attempt();
        if (r.ok) return r;
        if (i < FETCH_RETRIES) {
          if (typeof opts.onRetry === 'function') opts.onRetry(r.error, i + 1);
          await _wait(2000 * (i + 1));   // 退避 2s / 4s
        }
      }
      return r;
    })();
  }

  /* ---------------- 流式 agent_chat 请求（打字机效果） ---------------- */
  // 与 streamVisionIdentify 同款：fetch + ReadableStream.getReader 逐块消费。
  // 后端首行以 \u0000META\u0000{json}\n 发送结构化元数据（intent/sources/tool_results），
  // 其后为 answer 纯文本，逐块回调 onDelta 实现打字机；onDone 传回 meta 供渲染参考来源。
  function callAgentStream(body, isFormData, opts) {
    opts = opts || {};
    var style = prefStyle();
    if (style) {
      if (isFormData) { try { body.append('style', style); } catch (e) { /* ignore */ } }
      else { try { body = Object.assign({}, body, { style: style }); } catch (e) { /* ignore */ } }
    }
    function attempt() {
      return new Promise(function (resolve) {
        var ac = new AbortController();
        var to = setTimeout(function () { ac.abort(); }, FETCH_TIMEOUT);
        var init = { method: 'POST', signal: ac.signal };
        if (isFormData) init.body = body;
        else { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
        fetch('/api/agent_chat', init).then(function (res) {
          if (!res.ok) { clearTimeout(to); resolve({ ok: false, error: 'HTTP ' + res.status }); return; }
          var reader = res.body.getReader();
          var decoder = new TextDecoder('utf-8');
          var raw = '';
          var meta = null;
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) return;
              var chunk = decoder.decode(r.value, { stream: true });
              if (chunk) {
                raw += chunk;
                if (meta === null && raw.indexOf('\u0000META\u0000') === 0) {
                  var nl = raw.indexOf('\n');
                  if (nl !== -1) {
                    var metaStr = raw.slice('\u0000META\u0000'.length, nl);
                    try { meta = JSON.parse(metaStr); } catch (e) { meta = {}; }
                    raw = raw.slice(nl + 1);
                    if (opts.onDelta && raw) opts.onDelta(raw);
                    return pump();
                  }
                  return pump();
                }
                if (opts.onDelta) opts.onDelta(raw);
              }
              return pump();
            });
          }
          return pump().then(function () {
            clearTimeout(to);
            resolve({ ok: true, text: raw, meta: meta });
          });
        }).catch(function (e) {
          clearTimeout(to);
          var isTimeout = !!(e && e.name === 'AbortError');
          resolve({
            ok: false,
            error: isTimeout
              ? ('请求超时（>' + Math.round(FETCH_TIMEOUT / 1000) + 's），后端响应较慢或网关超时')
              : ('网络错误：' + (e && e.message ? e.message : '未知'))
          });
        });
      });
    }
    (async function () {
      for (var i = 0; i <= FETCH_RETRIES; i++) {
        var r = await attempt();
        if (r.ok) { if (opts.onDone) opts.onDone(r.meta); return; }
        if (i < FETCH_RETRIES) {
          if (opts.onRetry) opts.onRetry(r.error, i + 1);
          await _wait(2000 * (i + 1));
        } else {
          if (opts.onError) opts.onError(r.error);
        }
      }
    })();
  }

  /* ---------------- 流式视觉识别（/api/vision_identify 打字机） ---------------- */
  // 消费后端 text/plain 流式响应，逐块回调 onDelta，结束/出错回调 onDone/onError。
  function streamVisionIdentify(formData, onDelta, onDone, onError) {
    var ac = new AbortController();
    var to = setTimeout(function () { ac.abort(); }, FETCH_TIMEOUT);
    fetch('/api/vision_identify', { method: 'POST', body: formData, signal: ac.signal })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var reader = res.body.getReader();
        var decoder = new TextDecoder('utf-8');
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            var chunk = decoder.decode(r.value, { stream: true });
            if (chunk) onDelta(chunk);
            return pump();
          });
        }
        return pump();
      })
      .then(function () { clearTimeout(to); if (onDone) onDone(); })
      .catch(function (e) {
        clearTimeout(to);
        var msg = (e && e.name === 'AbortError')
          ? ('请求超时（>' + Math.round(FETCH_TIMEOUT / 1000) + 's），后端响应较慢或网关超时')
          : ('网络错误：' + (e && e.message ? e.message : '未知'));
        if (onError) onError(msg);
      });
  }

  /* ---------------- 纹样共创：保留原版双栏工作台并要求接真实后端 ---------------- */
  // ai-copilot.js 内部原本就编译进了完整的「非遗文创设计师」双栏工作台：
  //   输入框 + ✨开始设计 + 三条快捷词（b() 会填词并直接触发生成）
  //   左栏 AI 工作流（需求解析→检索非遗特征→绘制设计方案→生成方案总结）+ 设计思路
  //   右栏 设计方案图
  // 早期 ws-real 把它整块换成聊天框，导致双栏消失、快捷词点了没反应。
  // 现改为：识别出该卡片后**不打聊天补丁**，只在捕获阶段接管「开始设计 / 快捷词 /
  // 回车」三个入口，用真实后端驱动原有 DOM，排版与质感完全保持原样。
  function isDesignBench(sec) {
    var t = sec.textContent || '';
    return t.indexOf('AI 工作流') !== -1 && t.indexOf('设计方案图') !== -1;
  }

  var WD_STEPS = [
    { icon: '🧠', title: '需求解析', act: '正在理解文创需求与载体…', done: '需求解析完成' },
    { icon: '📚', title: '检索非遗特征', act: '正在检索《中国纹样史》…', done: '已检索馆内纹样资料' },
    { icon: '🎨', title: '绘制设计方案', act: '正在为方案绘制纹样…', done: '方案图已生成' },
    { icon: '✨', title: '生成方案总结', act: '正在整理设计思路…', done: '方案总结完成' }
  ];

  function bindDesignBench(sr, sec) {
    if (sec.__wdBound) return;
    var input = sec.querySelector('input[type="text"]');
    var runBtn = null;
    Array.prototype.forEach.call(sec.querySelectorAll('button'), function (b) {
      if (/开始设计|停止/.test((b.textContent || '').trim())) runBtn = b;
    });
    if (!input || !runBtn) return;
    sec.__wdBound = true;

    // 左栏卡片（h3 = AI 工作流）
    var leftCard = null;
    Array.prototype.forEach.call(sec.querySelectorAll('h3'), function (h) {
      if ((h.textContent || '').indexOf('AI 工作流') !== -1) leftCard = h.parentElement;
    });
    var emptyHint = null;
    if (leftCard) {
      Array.prototype.forEach.call(leftCard.children, function (c) {
        if (c.tagName === 'P') emptyHint = c;
      });
    }
    var thinkP = sec.querySelector('p.whitespace-pre-wrap');
    var stage = sec.querySelector('.cp-design-stage');
    // Vue 的空状态提示「等待生成…」（我们自己写正文，需手动收起）
    var waitHint = null;
    Array.prototype.forEach.call(sec.querySelectorAll('p'), function (x) {
      if ((x.textContent || '').trim() === '等待生成…') waitHint = x;
    });

    var busy = false;
    var aborter = null;

    function setInput(v) {
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function paintSteps(states, descs) {
      if (!leftCard) return;
      if (emptyHint) emptyHint.style.display = 'none';
      var ol = leftCard.querySelector('ol.wd-steps');
      if (!ol) {
        ol = document.createElement('ol');
        ol.className = 'wd-steps';
        leftCard.appendChild(ol);
      }
      ol.innerHTML = WD_STEPS.map(function (s, i) {
        var st = states[i] || 'pending';
        var desc = (descs && descs[i]) ||
                   (st === 'done' ? s.done : (st === 'active' ? s.act : ''));
        var dot = st === 'done' ? '#C9A227' : (st === 'active' ? '#8B0000' : '#cbd5e1');
        var bd = st === 'done' ? '#C9A227' : (st === 'active' ? '#8B0000' : '#e2e8f0');
        var bg = st === 'pending' ? '#f8fafc' : '#FBF1E6';
        var tx = st === 'pending' ? '#94a3b8' : '#5b3a29';
        return '<li class="wd-step">' +
          '<span class="wd-step__dot" style="background:' + dot + '">' +
            (st === 'done' ? '✓' : (i + 1)) + '</span>' +
          '<div class="wd-step__box" style="border-color:' + bd + ';background:' + bg + ';color:' + tx + '">' +
            '<div class="wd-step__title">' + s.icon + ' ' + s.title +
              (st === 'active' ? '<em>进行中…</em>' : '') + '</div>' +
            (desc ? '<p class="wd-step__desc">' + desc + '</p>' : '') +
          '</div></li>';
      }).join('');
    }

    function showImage(url, caption) {
      if (!stage) return;
      Array.prototype.forEach.call(stage.children, function (c) {
        if (c.tagName !== 'H3') c.style.display = 'none';
      });
      var img = stage.querySelector('img.wd-stage-img');
      if (!img) {
        img = document.createElement('img');
        img.className = 'wd-stage-img';
        img.alt = '非遗纹样设计方案';
        stage.appendChild(img);
      }
      img.style.display = 'block';
      img.src = url;
      var cap = stage.querySelector('p.wd-stage-cap');
      if (caption) {
        if (!cap) { cap = document.createElement('p'); cap.className = 'wd-stage-cap'; stage.appendChild(cap); }
        cap.style.display = 'block';
        cap.textContent = caption;
      } else if (cap) { cap.style.display = 'none'; }
      litChip(sr, 'generate_pattern_image');
    }

    function setBusy(on) {
      busy = on;
      runBtn.textContent = on ? ' ■ 停止 ' : ' ✨ 开始设计 ';
      runBtn.style.opacity = on ? '.85' : '';
      input.disabled = on;
    }

    function buildPrompt(text) {
      return (text || '').replace(/[。.！!]$/, '') +
        '，中国传统纹样平面图案设计，白底，正视图，构图居中，线条清晰，适合印花与文创应用，高清';
    }

    function run(text) {
      if (busy) return;
      setBusy(true);
      var descs = ['', '', '', ''];
      var states = ['active', 'pending', 'pending', 'pending'];
      paintSteps(states, descs);
      if (thinkP) thinkP.textContent = '';
      if (waitHint) waitHint.style.display = 'none';
      if (stage) {
        Array.prototype.forEach.call(stage.children, function (c) {
          if (c.tagName !== 'H3') c.style.display = '';
        });
        var old = stage.querySelector('img.wd-stage-img');
        if (old) old.remove();
        var oldCap = stage.querySelector('p.wd-stage-cap');
        if (oldCap) oldCap.remove();
      }
      litChip(sr, 'Function Calling');

      var acc = '', gotMeta = false, gotFirst = false;
      var AC = window.AbortController ? new AbortController() : null;
      var sig = AC ? AC.signal : undefined;
      aborter = AC;

      fetch('/api/agent_chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_input: text, current_page: '纹样共创' }),
        signal: sig
      }).then(function (res) {
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        var rd = res.body.getReader(), dec = new TextDecoder();
        var buf = '';
        function pump() {
          return rd.read().then(function (r) {
            if (r.done) return;
            buf += dec.decode(r.value, { stream: true });
            // 首块 META：需求解析完成 → 进入检索步骤
            if (!gotMeta) {
              var mi = buf.indexOf('\u0000META\u0000');
              if (mi === 0) {
                var nl = buf.indexOf('\n', mi);
                if (nl === -1) return pump();
                var metaRaw = buf.slice(mi + 6, nl);
                buf = buf.slice(nl + 1);
                gotMeta = true;
                states[0] = 'done'; states[1] = 'active';
                paintSteps(states, descs);
                try {
                  var meta = JSON.parse(metaRaw);
                  var pats = meta.patterns || [];
                  if (pats.length) {
                    descs[1] = '已检索：' + pats[0].name +
                      (pats.length > 1 ? ' 等 ' + pats.length + ' 枚纹样' : '');
                    litChip(sr, 'query_heritage_db');
                  }
                  states[1] = 'done'; states[2] = 'active';
                  paintSteps(states, descs);
                } catch (e) {
                  states[1] = 'done'; states[2] = 'active';
                  paintSteps(states, descs);
                }
              } else if (mi > 0) {
                buf = buf.slice(mi);
                gotMeta = true;
              } else {
                return pump();
              }
            }
            // 正文：逐字进「设计思路」
            var cut = buf.indexOf('\u0000IMAGES\u0000');
            var chunk = cut === -1 ? buf : buf.slice(0, cut);
            if (!gotFirst && chunk.trim()) {
              gotFirst = true;
              litChip(sr, 'GLM-4-Flash');
            }
            if (cut === -1) {
              acc += chunk; buf = '';
            } else {
              acc += chunk; buf = buf.slice(cut);
              if (thinkP) thinkP.textContent = acc;
              return;
            }
            if (thinkP) thinkP.textContent = acc;
            return pump();
          });
        }
        return pump();
      }).then(function () {
        if (thinkP && !acc.trim()) thinkP.textContent = '（已生成设计方案，详见右侧效果图）';
        states[2] = 'done'; states[3] = 'active';
        paintSteps(states, descs);
        return fetch('/api/generate_image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: buildPrompt(text), size: '1024x1024' }),
          signal: sig
        }).then(function (r) { return r.json(); });
      }).then(function (j) {
        states[3] = 'done';
        paintSteps(states, descs);
        if (j && j.url) {
          showImage(j.url, '');
        } else if (stage) {
          var ph = document.createElement('p');
          ph.className = 'wd-stage-cap';
          ph.textContent = '生图服务暂不可用，已保留左侧设计思路。';
          stage.appendChild(ph);
        }
        setBusy(false);
        aborter = null;
      }).catch(function (e) {
        var aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e)));
        states[3] = 'done';
        paintSteps(states, descs);
        if (aborted) {
          if (thinkP && !acc.trim()) thinkP.textContent = '（已停止生成）';
        } else {
          if (thinkP) thinkP.textContent = '⚠️ ' + (e && e.message ? e.message : '请求失败') + '，请确认后端已启动。';
        }
        setBusy(false);
        aborter = null;
      });
    }

    // 捕获阶段抢占：Vue 的 @click 绑在按钮上（冒泡），这里先手拦下，
    // 避免它走内置 mock 逻辑，改由真实后端驱动。
    sec.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      var t = (b.textContent || '').trim();
      var isRun = /开始设计|停止/.test(t);
      var isQuick = !isRun && b.className && String(b.className).indexOf('rounded-full') !== -1;
      if (!isRun && !isQuick) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      if (busy) {
        // 「■ 停止」：中断当前生成
        if (isRun && aborter) { try { aborter.abort(); } catch (err) { } }
        return;
      }
      if (isRun) {
        var v = (input.value || '').trim();
        if (v) run(v);
      } else {
        setInput(t);
        run(t);
      }
    }, true);

    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      if (busy) return;
      var v = (input.value || '').trim();
      if (v) run(v);
    }, true);
  }

  function ensureDesignCSS(sr) {
    if (sr.getElementById && sr.getElementById('wd-style')) return;
    var st = document.createElement('style');
    st.id = 'wd-style';
    st.textContent =
      '.wd-steps{list-style:none;margin:0;padding:0;position:relative;margin-left:12px;border-left:1px solid #e2e8f0}' +
      '.wd-step{position:relative;margin:0 0 20px 20px}' +
      '.wd-step:last-child{margin-bottom:0}' +
      '.wd-step__dot{position:absolute;left:-31px;top:2px;display:flex;align-items:center;justify-content:center;' +
        'width:20px;height:20px;border-radius:50%;color:#fff;font-size:11px;font-weight:700}' +
      '.wd-step__box{border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px;transition:all .25s ease}' +
      '.wd-step__title{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:600}' +
      '.wd-step__title em{margin-left:auto;font-style:normal;font-size:11px;opacity:.7}' +
      '.wd-step__desc{margin:4px 0 0;font-size:12px;line-height:1.6;opacity:.8}' +
      '.wd-stage-img{max-height:320px;width:auto;border-radius:8px;box-shadow:0 6px 20px rgba(91,58,41,.18);' +
        'animation:wdImgIn .5s ease both}' +
      '.wd-stage-cap{margin:12px 0 0;max-width:100%;font-size:11px;line-height:1.6;color:#64748b;text-align:center}' +
      '@keyframes wdImgIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}';
    (sr.head || sr).appendChild(st);
  }

  /* ---------------- 扫描 ---------------- */
  function scan() {
    var sr = getSR();
    if (!sr) return;
    ensureStyle(sr);
    // 板块切换检测：切换后把每张已打补丁的卡片重绘为「当前板块」独立历史
    var tab = curTab();
    if (tab !== lastTab) {
      lastTab = tab;
      sr.querySelectorAll('.cp__body section.mx-auto, .cp__body section').forEach(function (sec) {
        if (!sec.__wsrx) return;
        var b = sec.querySelector('.wsrx__body');
        if (b) repaint(b);
        // 切换板块时清空各板块残留的图片临时状态（如「等待上传图片」flag / 预览）
        if (typeof sec.__clearImage === 'function') sec.__clearImage();
      });
    }
    // cp__body 下所有卡片（任意 Tab）
    sr.querySelectorAll('.cp__body section.mx-auto, .cp__body section').forEach(function (sec) {
      if (!sec.querySelector('input, textarea')) return;
      if (!sec.querySelector('button')) return;
      // 纹样共创：原版双栏工作台保持不动，只接管交互
      if (isDesignBench(sec)) {
        ensureDesignCSS(sr);
        bindDesignBench(sr, sec);
        return;
      }
      patchCard(sr, sec);
    });
  }

  /* ---------------- 启动观察 ---------------- */
  var t = null;
  function schedule() { clearTimeout(t); t = setTimeout(scan, 60); }
  function boot() {
    scan();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    var sr = getSR();
    if (sr) new MutationObserver(schedule).observe(sr, { childList: true, subtree: true });
    setInterval(scan, 1500);   // 兜底轮询（Shadow DOM 重建场景）
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
