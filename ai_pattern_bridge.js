/* ============================================================
 * ai_pattern_bridge.js —— 全局「纹样知识挑战」悬浮小组件
 * ------------------------------------------------------------
 * 替代原「纹样库联动」悬浮件；纯前端 Mock 数据，零网络请求、零大模型。
 *
 * 设计原则（不破坏主站）：
 *   · 独立于 Vue 渲染树，注入 DOM + 轮询保活，抗 SPA 重渲染；
 *   · 悬浮球沿用 id #aiCoFab，直接复用 float_drag_inject.js 的
 *     鼠标/触摸拖拽、视口约束、位置记忆、双击复位、拖拽后抑制误点击；
 *   · 面板改为 #wbQuizPanel，按悬浮球实时位置自行贴附，不与旧
 *     syncBridgePanel（找 #aiCoBridge）冲突；
 *   · 视觉沿用 :root 令牌，与「纹宝 AI 导览」同一套宣纸黄 / 暗红 /
 *     描金 / 毛玻璃语言；
 *   · 保留 decorateCards()：纹样卡片上的「✦ AI 共创」入口不丢失；
 *   · 任何异常只影响本面板，绝不污染主站其它功能。
 * ============================================================ */
(function () {
  'use strict';

  /* —— 5 道固定题目（严禁实时生成；解析逐字照录）—— */
  var QUIZ = [
    {
      q: '被称为「苗族精神史的无字史书」，且常用蝴蝶作为图腾的技艺是？',
      opts: ['A. 苏州刺绣', 'B. 苗族蜡染', 'C. 景德镇陶瓷', 'D. 蔚县剪纸'],
      ans: 1,
      exp: '苗族蜡染以冰纹与母题承载着创世神话，蝴蝶妈妈是苗族的始祖图腾。'
    },
    {
      q: '中国古代「宝相花」纹样，最常出现在哪个历史时期的艺术作品中？',
      opts: ['A. 夏商周', 'B. 汉代', 'C. 唐代', 'D. 清代'],
      ans: 2,
      exp: '宝相花是唐代非常流行的吉祥纹样，常出现在铜镜、织锦和金银器上。'
    },
    {
      q: '具有「圆弧卷曲、舒展流动」形态特征，寓意高升如意的几何纹样是？',
      opts: ['A. 云纹', 'B. 雷纹', 'C. 龙纹', 'D. 盘长纹'],
      ans: 0,
      exp: '云纹象征着吉祥如意，是古代器物上极为常见的装饰纹样。'
    },
    {
      q: '在传统纹样中，常用来代表「江山永固、潮涌不息」的纹样是？',
      opts: ['A. 缠枝纹', 'B. 海水江崖纹', 'C. 忍冬纹', 'D. 葡萄纹'],
      ans: 1,
      exp: '海水江崖纹常用于古代龙袍下摆，寓意江山永固。'
    },
    {
      q: '在中国传统纹样中，有一种植物纹样以藤蔓、卷草为基础，线条连绵不断，寓意「生生不息、吉庆连绵」，它是？',
      opts: ['A. 云雷纹', 'B. 缠枝纹', 'C. 饕餮纹', 'D. 联珠纹'],
      ans: 1,
      exp: '缠枝纹又称「万寿藤」，因其结构连绵不断，故有「生生不息」之意，是瓷器、织锦上极为常见的经典纹样。'
    }
  ];

  var FAB_ID = 'aiCoFab';
  var PANEL_ID = 'wbQuizPanel';
  var STYLE_ID = 'wbQuizStyle';
  var TOTAL = QUIZ.length;
  var PASS = 30;             /* 及格线：答对 3 题 */

  var st = { idx: 0, score: 0, right: 0, picked: -1, done: false, open: false };
  var refs = {};

  /* —— 国风样式：与「纹宝 AI 导览」共用 :root 令牌 —— */
  var CSS = [
    '#' + FAB_ID + '{position:fixed;z-index:2147483630;width:64px;height:64px;padding:0;',
    'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;',
    'border-radius:50%;border:2px solid var(--c-gold,#c89b3c);cursor:pointer;',
    'font-family:var(--font-title,serif);color:var(--c-paper,#f7f3ec);',
    'background:radial-gradient(circle at 34% 26%,#b8323f,var(--c-primary,#8b1a1a) 62%,#661318);',
    'box-shadow:var(--shadow-lg,0 16px 48px rgba(26,26,46,.18)),',
    '0 0 0 5px color-mix(in srgb,var(--c-gold,#c89b3c) 16%,transparent),',
    'inset 0 2px 0 rgba(255,255,255,.28);',
    'transition:transform .22s var(--ease,ease),box-shadow .22s var(--ease,ease),background .3s ease}',
    '#' + FAB_ID + ':hover{transform:scale(1.07);',
    'box-shadow:var(--shadow-lg,0 16px 48px rgba(26,26,46,.18)),',
    '0 0 0 7px color-mix(in srgb,var(--c-gold,#c89b3c) 22%,transparent)}',
    '#' + FAB_ID + '.is-open{background:radial-gradient(circle at 34% 26%,#d8ab55,var(--c-gold,#c89b3c) 62%,#9a6d1c)}',
    '#' + FAB_ID + ' .wbq-face{font-size:23px;line-height:1;font-family:var(--font-title,serif)}',
    '#' + FAB_ID + ' .wbq-cap{font-size:10px;letter-spacing:2px;line-height:1.2;font-weight:700}',

    '#' + PANEL_ID + '{position:fixed;z-index:2147483620;width:392px;',
    'max-width:calc(100vw - 24px);max-height:calc(100vh - 96px);overflow-y:auto;',
    'scrollbar-width:none;-ms-overflow-style:none;',
    'background:linear-gradient(165deg,var(--c-paper,#f7f3ec) 0%,var(--bg,#f4e6c0) 100%);',
    'backdrop-filter:blur(10px) saturate(125%);-webkit-backdrop-filter:blur(10px) saturate(125%);',
    'border:1px solid color-mix(in srgb,var(--c-gold,#c89b3c) 55%,transparent);',
    'border-radius:var(--radius-lg,16px);',
    'box-shadow:var(--shadow-lg,0 16px 48px rgba(26,26,46,.18)),',
    'var(--shadow-gold,0 6px 20px rgba(200,155,60,.28)),inset 0 1px 0 rgba(255,255,255,.65);',
    'font-family:var(--font-body,sans-serif);color:var(--text,var(--c-ink,#2c2c2c));',
    'opacity:0;transform:translateY(10px) scale(.98);pointer-events:none;',
    'transition:opacity .25s var(--ease,ease),transform .25s var(--ease,ease)}',
    '#' + PANEL_ID + '.open{opacity:1;transform:none;pointer-events:auto}',
    /* 隐藏滚动条：Chrome/Safari(WebKit) 与 Firefox(scrollbar-width) 双覆盖 */
    '#' + PANEL_ID + '::-webkit-scrollbar{width:0;height:0;display:none}',
    '#' + PANEL_ID + '::-webkit-scrollbar-thumb{background:transparent}',
    '#' + PANEL_ID + '::-webkit-scrollbar-track{background:transparent}',

    /* sticky：面板内部滚动时，进度 / 得分 / 关闭按钮始终可见 */
    '#' + PANEL_ID + ' .wbq-head{position:sticky;top:0;z-index:3;padding:8px 46px 8px 16px;',
    'background:linear-gradient(120deg,var(--c-primary,#8b1a1a),',
    'color-mix(in srgb,var(--c-primary,#8b1a1a) 70%,var(--c-gold,#c89b3c)));',
    'color:var(--c-paper,#f7f3ec);border-radius:15px 15px 0 0}',
    '#' + PANEL_ID + ' .wbq-title{display:flex;align-items:center;gap:8px;',
    'font-family:var(--font-title,serif);font-size:15px;font-weight:900;letter-spacing:1px}',
    '#' + PANEL_ID + ' .wbq-dot{width:8px;height:8px;border-radius:50%;background:#6ee7a8;box-shadow:0 0 8px #6ee7a8}',
    '#' + PANEL_ID + ' .wbq-meta{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap}',
    '#' + PANEL_ID + ' .wbq-pill{font-size:11px;padding:3px 10px;border-radius:999px;',
    'background:rgba(247,238,207,.18);border:1px solid rgba(247,238,207,.28);letter-spacing:.3px}',
    '#' + PANEL_ID + ' .wbq-x{position:absolute;top:12px;right:12px;width:28px;height:28px;',
    'border:none;border-radius:8px;cursor:pointer;font-size:16px;line-height:1;',
    'background:rgba(255,255,255,.18);color:var(--c-paper,#f7f3ec);transition:background .18s ease}',
    '#' + PANEL_ID + ' .wbq-x:hover{background:rgba(255,255,255,.34)}',

    '#' + PANEL_ID + ' .wbq-bar{height:4px;background:rgba(139,26,26,.12);overflow:hidden}',
    '#' + PANEL_ID + ' .wbq-bar > i{display:block;height:100%;width:0;',
    'background:linear-gradient(90deg,var(--c-primary,#8b1a1a),var(--c-gold,#c89b3c));',
    'transition:width .45s var(--ease,ease)}',

    '#' + PANEL_ID + ' .wbq-body{padding:10px 14px 20px}',
    '#' + PANEL_ID + ' .wbq-kicker{font-size:10.5px;color:#7a5c1e;font-weight:700;letter-spacing:1px;margin-bottom:5px}',
    '#' + PANEL_ID + ' .wbq-q{font-family:var(--font-title,serif);font-size:13.8px;line-height:1.55;',
    'font-weight:700;margin:0 0 8px;color:var(--c-ink,#2c2c2c)}',
    '#' + PANEL_ID + ' .wbq-opts{display:grid;gap:6px}',
    '#' + PANEL_ID + ' .wbq-opt{display:flex;align-items:center;gap:10px;width:100%;text-align:left;',
    'padding:6px 11px;border-radius:var(--radius-md,8px);cursor:pointer;',
    'font-family:inherit;font-size:13.5px;line-height:1.5;color:var(--c-ink,#2c2c2c);',
    'background:rgba(255,255,255,.72);border:1px solid var(--border,rgba(44,44,44,.12));',
    'transition:transform .2s var(--ease,ease),border-color .2s ease,background .2s ease,box-shadow .2s ease}',
    '#' + PANEL_ID + ' .wbq-opt:hover:not(:disabled){border-color:var(--c-gold,#c89b3c);',
    'transform:translateX(2px);box-shadow:var(--shadow-sm,0 2px 8px rgba(26,26,46,.08))}',
    '#' + PANEL_ID + ' .wbq-opt:disabled{cursor:default}',
    '#' + PANEL_ID + ' .wbq-opt .wbq-tag{flex:none;width:22px;height:22px;border-radius:50%;',
    'display:grid;place-items:center;font-size:11px;font-weight:700;',
    'background:color-mix(in srgb,var(--c-primary,#8b1a1a) 12%,transparent);',
    'color:var(--c-primary,#8b1a1a)}',
    '#' + PANEL_ID + ' .wbq-opt.is-right{border-color:#2e7d5b;background:rgba(46,125,91,.13);color:#1e5c41;',
    'box-shadow:inset 0 0 0 1px rgba(46,125,91,.25)}',
    '#' + PANEL_ID + ' .wbq-opt.is-wrong{border-color:#b23a2e;background:rgba(178,58,46,.13);color:#8b1a1a;',
    'box-shadow:inset 0 0 0 1px rgba(178,58,46,.25)}',
    '#' + PANEL_ID + ' .wbq-opt.is-right .wbq-tag{background:#2e7d5b;color:#fff}',
    '#' + PANEL_ID + ' .wbq-opt.is-wrong .wbq-tag{background:#b23a2e;color:#fff}',

    '#' + PANEL_ID + ' .wbq-fb{margin-top:7px;padding:6px 11px;border-radius:var(--radius-md,8px);',
    'font-size:13px;font-weight:700;letter-spacing:.3px;animation:wbqPop .34s var(--ease,ease) both}',
    '#' + PANEL_ID + ' .wbq-fb.ok{background:rgba(46,125,91,.13);border:1px solid rgba(46,125,91,.45);color:#1e5c41}',
    '#' + PANEL_ID + ' .wbq-fb.no{background:#fdf2f2;border:1px solid #f3caca;color:#c34a4a}',
    '@keyframes wbqPop{from{opacity:0;transform:translateY(-7px) scale(.96)}to{opacity:1;transform:none}}',

    '#' + PANEL_ID + ' .wbq-exp{max-height:0;opacity:0;overflow:hidden;margin-top:0;',
    'transition:max-height .46s var(--ease,ease),opacity .36s ease,margin .36s ease}',
    '#' + PANEL_ID + ' .wbq-exp.show{max-height:260px;opacity:1;margin-top:8px}',
    '#' + PANEL_ID + ' .wbq-exp-in{padding:8px 11px;border-radius:var(--radius-md,8px);',
    'background:rgba(255,255,255,.78);border:1px solid color-mix(in srgb,var(--c-gold,#c89b3c) 38%,transparent);',
    'border-left:3px solid var(--c-gold,#c89b3c);font-size:12.2px;line-height:1.65}',
    '#' + PANEL_ID + ' .wbq-exp-in b{display:block;font-family:var(--font-title,serif);',
    'color:#7a5c1e;font-size:12px;letter-spacing:1px;margin-bottom:4px}',

    '#' + PANEL_ID + ' .wbq-next{display:block;width:100%;margin-top:8px;padding:8px 12px;',
    'border:none;border-radius:11px;cursor:pointer;font-family:var(--font-title,serif);',
    'font-weight:700;font-size:13.5px;letter-spacing:1px;color:var(--c-paper,#f7f3ec);',
    'background:linear-gradient(135deg,var(--c-primary,#8b1a1a),#6d1414);',
    'box-shadow:0 4px 0 #8b0000,0 6px 16px rgba(139,26,26,.28);',
    'transition:filter .18s ease,transform .12s ease,box-shadow .12s ease}',
    '#' + PANEL_ID + ' .wbq-next:hover{filter:brightness(1.1);transform:translateY(-1px)}',
    '#' + PANEL_ID + ' .wbq-next:active{transform:translateY(3px);',
    'box-shadow:0 1px 0 #8b0000,0 2px 8px rgba(139,26,26,.28);filter:brightness(.96)}',
    '#' + PANEL_ID + ' .wbq-next.gold{background:linear-gradient(135deg,var(--c-gold,#c89b3c),#9a6d1c)}',

    '#' + PANEL_ID + ' .wbq-result{text-align:center;padding:12px 4px 4px;animation:wbqPop .4s var(--ease,ease) both}',
    '#' + PANEL_ID + ' .wbq-seal{width:76px;height:76px;margin:0 auto 12px;border-radius:50%;',
    'display:grid;place-items:center;font-family:var(--font-title,serif);font-size:30px;font-weight:900;',
    'color:var(--c-paper,#f7f3ec);background:radial-gradient(circle at 34% 26%,#d8ab55,var(--c-gold,#c89b3c) 62%,#9a6d1c);',
    'border:3px solid var(--c-primary,#8b1a1a);box-shadow:var(--shadow-gold,0 6px 20px rgba(200,155,60,.28))}',
    '#' + PANEL_ID + ' .wbq-score{font-family:var(--font-title,serif);font-size:38px;font-weight:900;',
    'color:var(--c-primary,#8b1a1a);line-height:1.1}',
    '#' + PANEL_ID + ' .wbq-score small{font-size:14px;color:var(--c-gray,#666)}',
    '#' + PANEL_ID + ' .wbq-rank{font-family:var(--font-title,serif);font-size:20px;font-weight:900;',
    'letter-spacing:3px;margin:10px 0 6px;color:#7a5c1e}',
    '#' + PANEL_ID + ' .wbq-remark{font-size:12.8px;line-height:1.8;color:var(--c-gray,#666);margin-bottom:4px}',

    /* 保留：纹样卡片上的「✦ AI 共创」入口（原组件能力，不丢失） */
    '.co-card-btn{position:absolute;right:10px;bottom:10px;z-index:5;padding:6px 11px;border:none;',
    'border-radius:20px;cursor:pointer;font-size:11.5px;font-weight:700;color:#fff;',
    'background:linear-gradient(135deg,#9d2933,#7e2129);box-shadow:0 4px 12px rgba(120,20,30,.4);',
    'font-family:var(--font-title,serif);opacity:0;transform:translateY(4px);transition:all .18s}',
    '.pattern-card{position:relative}',
    '.pattern-card:hover .co-card-btn{opacity:1;transform:none}',

    '@media(max-width:560px){#' + PANEL_ID + '{width:calc(100vw - 24px)}}'
  ].join('');

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = el('style'); s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* —— 圆形悬浮球（id 沿用，拖拽由 float_drag_inject.js 接管）—— */
  function buildFab() {
    var old = document.getElementById(FAB_ID);
    if (old) return old;
    var fab = el('button'); fab.id = FAB_ID;
    fab.type = 'button';
    fab.title = '纹样知识挑战 · 按住可拖动，双击复位';
    fab.setAttribute('aria-label', '纹样知识挑战');
    fab.appendChild(el('span', 'wbq-face', '❓'));
    fab.appendChild(el('span', 'wbq-cap', '挑战'));
    fab.addEventListener('click', function () { toggle(); });
    document.body.appendChild(fab);
    return fab;
  }

  /* —— 悬浮卡片骨架 —— */
  function buildPanel() {
    if (refs.panel && document.getElementById(PANEL_ID) === refs.panel) return;
    var p = el('div'); p.id = PANEL_ID;
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', '纹样知识挑战');

    var head = el('div', 'wbq-head');
    var title = el('div', 'wbq-title');
    title.appendChild(el('span', 'wbq-dot'));
    title.appendChild(el('span', null, '纹样知识挑战'));
    head.appendChild(title);
    var meta = el('div', 'wbq-meta');
    refs.progress = el('span', 'wbq-pill');
    refs.score = el('span', 'wbq-pill');
    meta.appendChild(refs.progress); meta.appendChild(refs.score);
    head.appendChild(meta);
    var x = el('button', 'wbq-x', '✕');
    x.type = 'button'; x.setAttribute('aria-label', '收起知识挑战');
    x.addEventListener('click', function (e) { e.stopPropagation(); toggle(false); });
    head.appendChild(x);
    p.appendChild(head);

    var bar = el('div', 'wbq-bar');
    refs.barFill = el('i');
    bar.appendChild(refs.barFill);
    p.appendChild(bar);

    refs.body = el('div', 'wbq-body');
    p.appendChild(refs.body);
    document.body.appendChild(p);
    refs.panel = p;
  }

  /* —— 面板贴附：按悬浮球实时位置计算，不盖球、不越界 —— */
  function positionPanel() {
    var fab = document.getElementById(FAB_ID), p = refs.panel;
    if (!fab || !p || !st.open) return;
    var f = fab.getBoundingClientRect();
    var pw = p.offsetWidth || 392;
    var vw = window.innerWidth, vh = window.innerHeight;
    var gap = 12, edge = 12, TOP_SAFE = 56;   /* 顶部让开主站导航栏 */

    var left = f.left + f.width / 2 < vw / 2 ? f.left : f.right - pw;
    left = Math.min(Math.max(edge, left), Math.max(edge, vw - pw - edge));

    /* 两侧可用高度，选更宽的一侧；面板高度永不超过该空间，
       因此既不会压住导航栏，也不会与悬浮球重叠；内容超出时面板内部滚动。 */
    var above = f.top - gap - TOP_SAFE;
    var below = vh - f.bottom - gap - edge;
    var placeAbove = above >= below;
    var avail = Math.max(140, placeAbove ? above : below);
    var natural = p.scrollHeight || 460;
    var ph = Math.min(natural, avail, vh - TOP_SAFE - edge);

    p.style.maxHeight = ph + 'px';
    var top = placeAbove ? f.top - ph - gap : f.bottom + gap;
    top = Math.min(Math.max(TOP_SAFE, top), Math.max(TOP_SAFE, vh - ph - edge));

    p.style.left = left + 'px';
    p.style.top = top + 'px';
    p.style.right = 'auto';
    p.style.bottom = 'auto';
  }

  function render() {
    if (!refs.body) return;
    refs.progress.textContent = st.done ? '已完成 · ' + TOTAL + ' / ' + TOTAL + ' 题'
                                        : '第 ' + (st.idx + 1) + ' / ' + TOTAL + ' 题';
    refs.score.textContent = '得分 ' + st.score;
    refs.barFill.style.width = (st.done ? 100 : (st.idx / TOTAL) * 100) + '%';
    refs.body.textContent = '';
    if (st.done) renderResult(); else renderQuestion();
    requestAnimationFrame(positionPanel);
  }

  function renderQuestion() {
    var item = QUIZ[st.idx];
    refs.body.appendChild(el('div', 'wbq-kicker', '第 ' + (st.idx + 1) + ' 题 · 单选'));
    refs.body.appendChild(el('h3', 'wbq-q', item.q));

    var box = el('div', 'wbq-opts');
    refs.opts = [];
    item.opts.forEach(function (txt, i) {
      var b = el('button', 'wbq-opt');
      b.type = 'button';
      b.dataset.wbqOpt = String(i);
      b.appendChild(el('span', 'wbq-tag', 'ABCD'.charAt(i)));
      b.appendChild(el('span', null, txt));
      b.addEventListener('click', function () { pick(i); });
      box.appendChild(b);
      refs.opts.push(b);
    });
    refs.body.appendChild(box);
  }

  /* —— 答题判定 + 反馈 + 解析浮现 + 下一题 —— */
  function pick(i) {
    if (st.done || st.picked !== -1 || !refs.opts) return;   /* 一题只答一次 */
    var item = QUIZ[st.idx];
    st.picked = i;
    var ok = i === item.ans;
    if (ok) { st.score += 10; st.right += 1; }

    refs.opts.forEach(function (b, k) {
      b.disabled = true;
      if (k === item.ans) b.classList.add('is-right');
      else if (k === i) b.classList.add('is-wrong');
    });
    refs.score.textContent = '得分 ' + st.score;

    var fb = el('div', 'wbq-fb ' + (ok ? 'ok' : 'no'),
      ok ? '✅ 回答正确  +10 分' : '❌ 回答错误  正确答案：' + 'ABCD'.charAt(item.ans));
    refs.body.appendChild(fb);

    /* 先插入无 .show 的节点，下一帧加类，保证 height 过渡真的跑起来 */
    var exp = el('div', 'wbq-exp');
    var inner = el('div', 'wbq-exp-in');
    inner.appendChild(el('b', null, '知识解析'));
    inner.appendChild(el('span', null, item.exp));
    exp.appendChild(inner);
    refs.body.appendChild(exp);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { exp.classList.add('show'); positionPanel(); });
    });
    /* 面板限高时会内部滚动：解析与「下一题」必须自动进入可视区 */
    requestAnimationFrame(function () {
      if (refs.panel) refs.panel.scrollTop = refs.panel.scrollHeight;
    });
    /* max-height 过渡结束后面板高度才稳定，补一次贴附 + 再次滚到底 */
    setTimeout(function () {
      positionPanel();
      if (refs.panel) refs.panel.scrollTop = refs.panel.scrollHeight;
    }, 520);

    var last = st.idx === TOTAL - 1;
    var next = el('button', 'wbq-next' + (last ? ' gold' : ''),
      last ? '🏆 查看最终成绩' : '下一题 →');
    next.type = 'button';
    next.addEventListener('click', nextQuestion);
    refs.body.appendChild(next);
    requestAnimationFrame(positionPanel);
  }

  function nextQuestion() {
    if (st.picked === -1) return;
    if (st.idx === TOTAL - 1) { st.done = true; render(); return; }
    st.idx += 1; st.picked = -1;
    render();
  }

  function renderResult() {
    var rank, remark, seal;
    if (st.score === TOTAL * 10) {
      rank = '一代宗师'; seal = '宗';
      remark = '五题全对，纹样之道已入化境 · 可为人师矣';
    } else if (st.score >= PASS) {
      rank = '初窥门径'; seal = '悟';
      remark = '已识纹样神韵，再进一步可期 · 继续遍览纹样宝库';
    } else {
      rank = '仍需努力'; seal = '勉';
      remark = '纹样千年，静心再读一程 · 不妨从宝相花与云纹重游';
    }
    var wrap = el('div', 'wbq-result');
    wrap.appendChild(el('div', 'wbq-seal', seal));
    var sc = el('div', 'wbq-score', String(st.score));
    sc.appendChild(el('small', null, ' / ' + TOTAL * 10 + ' 分'));
    wrap.appendChild(sc);
    wrap.appendChild(el('div', 'wbq-rank', rank));
    wrap.appendChild(el('p', 'wbq-remark', remark));
    wrap.appendChild(el('p', 'wbq-remark', '答对 ' + st.right + ' / ' + TOTAL + ' 题'));
    var again = el('button', 'wbq-next gold', '↻ 再试一次');
    again.type = 'button';
    again.addEventListener('click', reset);
    wrap.appendChild(again);
    refs.body.appendChild(wrap);
  }

  function reset() {
    st.idx = 0; st.score = 0; st.right = 0; st.picked = -1; st.done = false;
    render();
  }

  function toggle(force) {
    buildFab(); buildPanel();
    st.open = typeof force === 'boolean' ? force : !st.open;
    var fab = document.getElementById(FAB_ID);
    if (fab) fab.classList.toggle('is-open', st.open);
    if (refs.panel) refs.panel.classList.toggle('open', st.open);
    if (st.open) { render(); positionPanel(); }
  }

  /* —— 保留：纹样卡片上的「✦ AI 共创」入口 —— */
  function decorateCards() {
    var cards = document.querySelectorAll('.pattern-card');
    Array.prototype.forEach.call(cards, function (card) {
      if (card.querySelector('.co-card-btn')) return;
      var nameEl = card.querySelector('.pattern-card__name');
      var name = nameEl ? nameEl.textContent.trim() : '';
      if (!name) return;
      var btn = el('button', 'co-card-btn', '✦ AI 共创');
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        try { window.__AI_CO_PENDING__ = name; } catch (err) {}
        window.location.href = '/ai';
      });
      card.appendChild(btn);
    });
  }

  function tick() {
    try {
      injectStyle(); buildFab(); buildPanel(); decorateCards();
      if (document.getElementById(PANEL_ID) !== refs.panel) refs.panel = null;
    } catch (e) { /* 静默，绝不污染主站 */ }
  }

  /* 悬浮球被拖动时（float_drag_inject.js 写 style.left/top）实时跟随 */
  function watchFab() {
    var fab = document.getElementById(FAB_ID);
    if (!fab || fab.__wbqWatch) return;
    fab.__wbqWatch = 1;
    try {
      new MutationObserver(function () { if (st.open) positionPanel(); })
        .observe(fab, { attributes: true, attributeFilter: ['style'] });
    } catch (e) {}
  }

  document.addEventListener('keydown', function (e) {
    if (st.open && (e.key === 'Escape' || e.keyCode === 27)) toggle(false);
  }, true);
  window.addEventListener('resize', function () { if (st.open) positionPanel(); });

  /* 对外暴露：仅供调试 / 自动化验证，不参与业务 */
  window.WbQuiz = {
    questions: function () { return QUIZ.map(function (x) { return { q: x.q, opts: x.opts.slice(), ans: x.ans, exp: x.exp }; }); },
    state: function () { return { idx: st.idx, score: st.score, right: st.right, picked: st.picked, done: st.done, open: st.open }; },
    open: function () { toggle(true); },
    close: function () { toggle(false); },
    toggle: toggle,
    pick: pick,
    next: nextQuestion,
    reset: reset,
    position: positionPanel
  };

  function boot() {
    tick(); watchFab();
    setInterval(function () { tick(); watchFab(); }, 900);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
