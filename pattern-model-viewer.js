/* ============================================================================
 * [PATTERN-MODEL-VIEWER] 纹样详情页 · 平面图 / 3D鉴赏
 *   mv6：一对多模型 —— 手动左右切换 + 图文数据强联动 + 全屏鉴赏
 *
 *   四、全屏鉴赏
 *       · 3D 容器右上角国风小按钮 → HTML5 Fullscreen API 让 3D 展台占满屏幕
 *       · 全屏目标 = .pmv-stage（承载全部 model-viewer 层与切换控件），
 *         并挂 id="model-viewer" 对应 document.getElementById('model-viewer')；
 *         只全屏单个 model-viewer 会在交叉淡入换层时穿帮，故取整个展台
 *       · 全屏背景恒定温暖宣纸黄（CSS :fullscreen / ::backdrop + 内联兜底）
 *       · 再次点击按钮或按 ESC → 平滑退出；fullscreenchange 同步按钮状态
 *
 *   一、数据结构（一对多映射）
 *       PATTERN_MODEL_MAP: { 纹样名称: [ { src, name, era, craft, status, region }, ... ] }
 *       · 键 = 纹样名称（与 admin/patterns-data.json 的 name 完全一致）
 *       · 值 = 器物数组，每项自带完整年代 / 工艺 / 地位信息
 *       · 字段留空（'' 或 null）表示「该器物暂无此项独立考据」，
 *         此时右侧对应行回退到纹样本身的原始数据，绝不编造、绝不显示占位符。
 *
 *   二、交互
 *       · 模型数 > 1 → 出现左右国风箭头；= 1 → 箭头隐藏（无意义控件不出现）
 *       · 点击箭头 / 键盘 ← → → 修改 currentIndex，交叉淡入换模型
 *       · 「正在展示：器物名 01/03」高亮条 + 右侧三行字段同源更新
 *
 *   三、兜底
 *       · 该纹样无模型 / 模型文件全部缺失 → 整个 3D 展柜与 Tab 一并隐藏，只留平面图
 *       · 切换用双层 model-viewer 交叉淡入 + 固定视口 → 零闪烁、零布局跳动
 *       · 模型加载失败自动顺延下一条；全部失败则降级隐藏
 *
 *   零源码改动：只在 /pattern/:id 运行时向 .pm__media-wrap 追加节点。
 * ========================================================================== */
(function () {
  'use strict';

  var VER = '20261112mv8';
  var CSS_HREF = '/assets/pattern-model-viewer.css?v=' + VER;
  var IMG_VER = '?v=' + VER;
  var TAB_CLS = 'pmv-tabs';
  var STAGE_CLS = 'pmv-stage';
  var MVBOX_CLS = 'pmv-mvbox';

  var ICON_2D = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<rect x="3" y="4" width="18" height="16" rx="2"/>'
    + '<circle cx="8.5" cy="9" r="1.4"/>'
    + '<path d="M4 17.5l5-5 3.5 3.5 3-3 4.5 4.5"/></svg>';
  var ICON_3D = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M12 2.5 3 7.3v9.4L12 21.5l9-4.8V7.3z"/>'
    + '<path d="M3 7.3l9 4.9 9-4.9M12 12.2v9.3"/></svg>';
  var ICON_PREV = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M15.4 4.6 8 12l7.4 7.4"/>'
    + '<path d="M19 12H8.6" stroke-opacity=".45"/></svg>';
  var ICON_NEXT = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M8.6 4.6 16 12l-7.4 7.4"/>'
    + '<path d="M5 12h10.4" stroke-opacity=".45"/></svg>';
  /* 全屏鉴赏：四角向外展开 / 四角向内收起 */
  var ICON_FS = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/>'
    + '<path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>';
  var ICON_FS_EXIT = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M9 4v5H4"/><path d="M15 4v5h5"/>'
    + '<path d="M9 20v-5H4"/><path d="M15 20v-5h5"/></svg>';
  var FS_ID = 'model-viewer';        /* 3D 容器 id，对应 getElementById('model-viewer') */
  var PAPER_BG = '#f1e4c6';         /* 温暖宣纸黄：全屏态内联兜底色 */
  var FS_BTN_HTML = '<button class="pmv-fs" type="button" aria-label="全屏鉴赏" '
    + 'aria-pressed="false" title="全屏鉴赏（按 ESC 退出）">'
    + '<span class="pmv-fs__ico pmv-fs__ico--enter">' + ICON_FS + '</span>'
    + '<span class="pmv-fs__ico pmv-fs__ico--exit">' + ICON_FS_EXIT + '</span>'
    + '<span class="pmv-fs__txt">全屏鉴赏</span>'
    + '</button>';

  /* ── 一、一对多映射表（唯一数据源，替换真实模型/数据只改这里）─────────
     结构：{ 纹样名称: [ { src, name, era, craft, status }, ... ] }
       · 键 = 纹样名称，须与 admin/patterns-data.json 的 name 完全一致
       · era    = 该器物的断代（如「清代」）；留空 '' = 暂无独立考据，
                  UI 自动回退到纹样自身的「起源年代」，不编造、不显示占位符
       · craft  = 承载技艺 / 器物
       · status = 文化地位；留空则保留纹样原文
     以下 src 均已入库于 frontend/models/，器物定名依模型本体与贴图核过，
     未做朝代推断。 */
  var PATTERN_MODEL_MAP = {
    /* 植物纹样 */
    '宝相花': [
      { src: '/models/vase.glb',                   name: '青花缠枝宝相纹瓷瓶', era: '', craft: '青花瓷烧造', status: '' },
      { src: '/models/traditional_pattern_01.glb', name: '宝相卷草砖雕影壁',   era: '', craft: '砖雕',       status: '' }
    ],
    '缠枝莲': [
      { src: '/models/traditional_tea_set.glb',    name: '青花缠枝莲纹茶具',       era: '', craft: '青花瓷烧造', status: '' },
      { src: '/models/jar_with_lion-head_handles.glb', name: '青花缠枝莲纹狮首耳罐', era: '', craft: '青花瓷烧造', status: '' },
      { src: '/models/vase.glb',                   name: '青花缠枝纹瓷瓶',         era: '', craft: '青花瓷烧造', status: '' }
    ],
    '青花缠枝花卉纹': [
      { src: '/models/vase.glb',                   name: '青花缠枝纹瓷瓶',       era: '', craft: '青花瓷烧造', status: '' },
      { src: '/models/traditional_tea_set.glb',    name: '青花缠枝纹茶具',       era: '', craft: '青花瓷烧造', status: '' },
      { src: '/models/jar_with_lion-head_handles.glb', name: '青花缠枝纹狮首耳罐', era: '', craft: '青花瓷烧造', status: '' }
    ],
    '石榴纹': [
      { src: '/models/geometric_pomegranate.glb',  name: '石榴回纹雕刻构件',   era: '', craft: '雕刻',       status: '' }
    ],
    /* 动物纹样 */
    '龙纹': [
      { src: '/models/dragon_circle.glb',          name: '双龙纹透雕圆盘',     era: '', craft: '雕刻',       status: '' },
      { src: '/models/stone_dragon_pillar.glb',    name: '云龙纹石柱',         era: '', craft: '石雕',       status: '' },
      { src: '/models/bronze_mirror.glb',          name: '八瓣葵花形龙纹铜镜', era: '', craft: '青铜铸造',   status: '' }
    ],
    /* 几何纹样 */
    '回纹': [
      { src: '/models/traditional_pattern_03.glb', name: '砖雕回纹构件',       era: '', craft: '砖雕',       status: '' },
      { src: '/models/geometric_pomegranate.glb',  name: '石榴回纹雕刻构件',   era: '', craft: '雕刻',       status: '' }
    ],
    '云纹': [
      { src: '/models/stone_dragon_pillar.glb',    name: '云龙纹石柱',         era: '', craft: '石雕',       status: '' }
    ],
    /* 建筑与器物 */
    '砖雕缠枝纹': [
      { src: '/models/traditional_pattern_01.glb', name: '缠枝砖雕影壁',       era: '', craft: '砖雕',       status: '' },
      { src: '/models/traditional_pattern_03.glb', name: '回纹花卉砖雕构件',   era: '', craft: '砖雕',       status: '' }
    ],
    /* 铜镜专题（铜镜的星云纹等） */
    '星云纹': [
      { src: '/models/bronze_mirror.glb',          name: '八瓣葵花形铜镜',     era: '', craft: '青铜铸造',   status: '' }
    ],
    /* 陶瓷刻划纹 */
    '弦纹': [
      { src: '/models/ancient_pottery_vase.glb',   name: '刻划纹陶瓶',         era: '', craft: '陶器烧制',   status: '' }
    ],
    /* 服饰 */
    '团龙纹（敦煌）': [
      { src: '/models/dragon_robe.glb',           name: '红地团龙锦袍',       era: '', craft: '织绣',       status: '' }
    ]
  };

  /* 分类兜底：名称未命中映射表时，按分类取一组同类器物。
     宁可少给，也不给错 —— 未列出的分类直接隐藏整个 3D 展柜。 */
  var CATEGORY_FALLBACK = {
    '瓷器专题': [
      { src: '/models/vase.glb',                   name: '青花缠枝纹瓷瓶',   craft: '青花瓷烧造' },
      { src: '/models/traditional_tea_set.glb',    name: '青花缠枝纹茶具',   craft: '青花瓷烧造' },
      { src: '/models/jar_with_lion-head_handles.glb', name: '青花缠枝纹罐', craft: '青花瓷烧造' }
    ],
    '器物纹样': [
      { src: '/models/vase.glb',                   name: '青花缠枝纹瓷瓶',   craft: '青花瓷烧造' },
      { src: '/models/jar_with_lion-head_handles.glb', name: '青花缠枝纹罐', craft: '青花瓷烧造' }
    ],
    '铜器专题': [
      { src: '/models/bronze_mirror.glb',          name: '八瓣葵花形铜镜',   craft: '青铜铸造' }
    ],
    '铜镜专题': [
      { src: '/models/bronze_mirror.glb',          name: '八瓣葵花形铜镜',   craft: '青铜铸造' }
    ],
    '官服纹样': [
      { src: '/models/dragon_robe.glb',            name: '红地团龙锦袍',     craft: '织绣' },
      { src: '/models/princess_mulan_hanfu.glb',   name: '木兰礼服',         craft: '织绣' }
    ],
    '刺绣纹样': [
      { src: '/models/princess_mulan_hanfu.glb',   name: '木兰礼服',         craft: '织绣' },
      { src: '/models/dragon_robe.glb',            name: '红地团龙锦袍',     craft: '织绣' }
    ]
  };

  var mode = '2d';
  var tabs = null, stage = null, mvbox = null;
  var appliedId = null;
  var resolving = false;
  var list = [];                 /* 当前纹样可用的模型数组（已过滤缺失文件） */
  var currentIndex = 0;
  var layers = [];               /* 两个 model-viewer 层 */
  var front = 0;
  var seq = 0;                   /* 切换令牌，快速连点时丢弃过期回调 */
  var boundVals = [];            /* 已绑定的右侧字段（用于还原） */
  var loadTimer = null;
  var LAYERS_P = null;

  function q(s, r) { return (r || document).querySelector(s); }
  function qa(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  function isDetail() { return location.pathname.indexOf('/pattern/') === 0; }
  function currentId() {
    return isDetail()
      ? location.pathname.replace(/^\/pattern\//, '').replace(/\/.*$/, '')
      : null;
  }

  /* ── 资源探测（HEAD）────────────────────────────────────────────── */
  function headOk(url, kind) {
    return fetch(url, { method: 'HEAD' }).then(function (r) {
      if (!r.ok) return null;
      var ct = (r.headers.get('content-type') || '').toLowerCase();
      if (kind === 'model' && ct.indexOf('gltf') < 0 && ct.indexOf('octet-stream') < 0) return null;
      return url;
    }).catch(function () { return null; });
  }

  /* ── 数据缓存 ───────────────────────────────────────────────────── */
  var DATA = null, DATA_PROMISE = null;
  function loadData() {
    if (DATA) return Promise.resolve(DATA);
    if (DATA_PROMISE) return DATA_PROMISE;
    DATA_PROMISE = fetch('/admin/patterns-data.json')
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (d) { DATA = d; return d; });
    return DATA_PROMISE;
  }

  /* ── 二、解析：纹样 → 模型数组 ──────────────────────────────────── */
  function pickList(p) {
    if (!p) return [];
    if (PATTERN_MODEL_MAP[p.name]) return PATTERN_MODEL_MAP[p.name].slice();

    /* 名称模糊命中（如「宝相花纹」→「宝相花」） */
    var keys = Object.keys(PATTERN_MODEL_MAP);
    for (var i = 0; i < keys.length; i++) {
      if (p.name && p.name.indexOf(keys[i]) >= 0) return PATTERN_MODEL_MAP[keys[i]].slice();
    }

    var fb = CATEGORY_FALLBACK[p.category];
    if (!fb) return [];
    return fb.map(function (o) {
      return { src: o.src, name: o.name, era: o.era || '', craft: o.craft || '', status: o.status || '' };
    });
  }

  /* 逐条校验文件是否真的存在；全部缺失 → 空数组（不展示，不穿帮） */
  function validate(arr) {
    return Promise.all(arr.map(function (it) {
      return headOk(it.src, 'model').then(function (ok) { return ok ? it : null; });
    })).then(function (rs) { return rs.filter(Boolean); });
  }

  /* ── 样式注入 ───────────────────────────────────────────────────── */
  function injectStyle() {
    var old = q('link[href*="pattern-model-viewer.css"]');
    if (old) old.parentNode.removeChild(old);
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = CSS_HREF;
    document.head.appendChild(l);
  }

  function webglOK() {
    try {
      var c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl') ||
                c.getContext('experimental-webgl'));
    } catch (e) { return false; }
  }

  /* ── 三、图文强联动 ─────────────────────────────────────────────── */
  /* label 关键词 → 模型字段。顺序即优先级。 */
  var FIELD_MAP = [
    { re: /(起源|年代|朝代|时期)/, key: 'era' },
    { re: /(技艺|工艺|器物)/,      key: 'craft' },
    { re: /(地位|价值|意义)/,      key: 'status' },
    { re: /(区域|地域|流行)/,      key: 'region' }
  ];

  function bindRows(item) {
    if (!item) return;
    var rows = qa('.pm__info .pm__row');
    for (var i = 0; i < rows.length; i++) {
      var label = q('.pm__label', rows[i]);
      var val = q('.pm__value', rows[i]);
      if (!label || !val) continue;
      var txt = label.textContent || '';
      for (var j = 0; j < FIELD_MAP.length; j++) {
        if (!FIELD_MAP[j].re.test(txt)) continue;
        var key = FIELD_MAP[j].key;
        var v = item[key];

        /* 该行首次被接管时，记下 Vue 渲染的原始值 */
        if (val.dataset.pmvOrig === undefined) val.dataset.pmvOrig = val.textContent;

        if (v === undefined || v === null || v === '') {
          /* 该器物无此项考据 → 回退原始值，绝不留上一件器物的数据 */
          if (val.textContent !== val.dataset.pmvOrig) val.textContent = val.dataset.pmvOrig;
          val.removeAttribute('data-pmv-bound');
        } else {
          if (val.textContent !== v) val.textContent = v;
          val.setAttribute('data-pmv-bound', key);
        }
        if (boundVals.indexOf(val) < 0) boundVals.push(val);
        break;
      }
    }
  }

  function restoreRows() {
    for (var i = 0; i < boundVals.length; i++) {
      var el = boundVals[i];
      if (el.isConnected && el.dataset.pmvOrig !== undefined) el.textContent = el.dataset.pmvOrig;
      el.removeAttribute('data-pmv-bound');
    }
    boundVals = [];
  }

  /* ── HTML 片段 ──────────────────────────────────────────────────── */
  var TABS_HTML = '<div class="' + TAB_CLS + '" role="tablist" aria-label="纹样展示方式">'
    + '<button class="pmv-tabs__btn is-active" type="button" role="tab" aria-selected="true" data-pmv-mode="2d">'
    + ICON_2D + '平面图</button>'
    + '<button class="pmv-tabs__btn" type="button" role="tab" aria-selected="false" data-pmv-mode="3d">'
    + ICON_3D + '3D鉴赏</button>'
    + '</div>';

  var STAGE_HTML = '<div class="' + STAGE_CLS + '" id="' + FS_ID + '">'
    + '<div class="pmv-stage__glass" aria-hidden="true"></div>'
    + FS_BTN_HTML
    + '<div class="pmv-stage__loading"><span class="pmv-stage__ring"></span>'
    + '<span>文物模型载入中…</span></div>'
    + '<div class="pmv-stage__title"></div>'
    + '<div class="' + MVBOX_CLS + '">'
    +   '<button class="pmv-nav pmv-nav--prev" type="button" aria-label="上一件器物" title="上一件（←）">' + ICON_PREV + '</button>'
    +   '<button class="pmv-nav pmv-nav--next" type="button" aria-label="下一件器物" title="下一件（→）">' + ICON_NEXT + '</button>'
    + '</div>'
    + '<div class="pmv-now">'
    +   '<span class="pmv-now__seal" aria-hidden="true">展</span>'
    +   '<span class="pmv-now__k">正在展示</span>'
    +   '<span class="pmv-now__v"></span>'
    +   '<span class="pmv-now__idx"></span>'
    + '</div>'
    + '<div class="pmv-stage__hint"><i></i>按住鼠标拖拽旋转，滚动滚轮可放大/缩小<i></i></div>'
    + '</div>';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* 文字层：标题 / 高亮条 —— 与模型、右侧字段同一次调用内更新，杜绝错配 */
  function updateTexts(item) {
    if (!stage || !item) return;
    var title = q('.pmv-stage__title', stage);
    if (title) title.textContent = item.name + ' · 3D 数字孪生';
    var v = q('.pmv-now__v', stage);
    if (v) v.textContent = item.name;
    var idx = q('.pmv-now__idx', stage);
    if (idx) idx.textContent = pad2(currentIndex + 1) + ' / ' + pad2(list.length);
    var now = q('.pmv-now', stage);
    if (now) {
      now.classList.remove('is-pulse');
      void now.offsetWidth;          /* 重排以重启动画，不产生位移 */
      now.classList.add('is-pulse');
    }
  }

  /* ── 双层交叉淡入（核心：不闪烁、不跳动）────────────────────────── */
  function createLayers() {
    if (layers.length || !mvbox) return;
    for (var i = 0; i < 2; i++) {
      var mv = document.createElement('model-viewer');
      mv.className = 'pmv-mv';
      mv.setAttribute('alt', '文物 3D 数字孪生');
      mv.setAttribute('camera-controls', '');
      mv.setAttribute('auto-rotate', '');
      mv.setAttribute('auto-rotate-delay', '600');
      mv.setAttribute('rotation-per-second', '14deg');
      mv.setAttribute('shadow-intensity', '1');
      mv.setAttribute('environment-image', 'neutral');
      /* 开启鼠标滚轮缩放：移除 disable-zoom，并设置缩放极限与灵敏度 */
      mv.setAttribute('min-field-of-view', '15deg');  /* 最大放大倍数（防穿模） */
      mv.setAttribute('max-field-of-view', '45deg');  /* 最大缩小倍数 */
      /* 本版本(3.4.0)缩放手感属性为 zoom-sensitivity（默认 1，越大越灵敏）； */
      /* 3.4.0 并不支持 zoom-speed，写入会被静默忽略，故用等效的 zoom-sensitivity。 */
      mv.setAttribute('zoom-sensitivity', '1.5');
      mv.style.zIndex = i === 0 ? '1' : '0';
      mvbox.insertBefore(mv, mvbox.firstChild);
      layers.push(mv);
    }
    layers[0].classList.add('is-front');
  }

  /* 等待 model-viewer 自定义元素就绪后再建层，避免在未升级节点上设 src */
  function ensureLayers() {
    if (layers.length) return Promise.resolve(true);
    if (LAYERS_P) return LAYERS_P;
    LAYERS_P = new Promise(function (resolve) {
      var create = function () {
        if (!layers.length) createLayers();
        resolve(!!layers.length);
      };
      try {
        if (window.customElements && customElements.get('model-viewer')) return create();
        if (window.__mvBootstrap) window.__mvBootstrap.local();
        if (window.customElements && customElements.whenDefined) {
          customElements.whenDefined('model-viewer').then(create);
          setTimeout(function () { if (!layers.length) create(); }, 8000);
          return;
        }
      } catch (e) { /* ignore */ }
      create();
    });
    return LAYERS_P;
  }

  function showLoading(on) {
    if (!stage) return;
    if (on) stage.classList.remove('is-loaded');
    else stage.classList.add('is-loaded');
  }

  /* 空闲预取下一个模型，二次切换近零等待（命中 HTTP 缓存） */
  function prefetchNext() {
    if (list.length < 2) return;
    var n = list[(currentIndex + 1) % list.length];
    if (!n || n.__prefetched) return;
    n.__prefetched = true;
    setTimeout(function () { fetch(n.src, { cache: 'force-cache' }).catch(function () {}); }, 900);
  }

  function crossfade(item) {
    if (!item || !layers.length) return;
    var my = ++seq;
    var target = 1 - front;
    var el = layers[target];
    var old = layers[front];
    if (stage) stage.classList.add('is-switching');

    el.style.zIndex = '2';
    old.style.zIndex = '1';
    el.classList.remove('is-front');

    var done = function () {
      if (my !== seq) return;
      el.classList.add('is-front');
      front = target;
      showLoading(false);
      if (stage) stage.classList.remove('is-switching');
      prefetchNext();
      setTimeout(function () {
        if (my !== seq) return;
        if (old !== layers[front]) {
          old.classList.remove('is-front');
          old.style.zIndex = '0';
          /* 旧层卸料延后到淡出结束，避免与过渡抢帧 */
          setTimeout(function () {
            if (my === seq && old !== layers[front]) old.removeAttribute('src');
          }, 260);
        }
      }, 300);
    };

    var fail = function () {
      if (my !== seq) return;
      if (stage) stage.classList.remove('is-switching');
      el.removeEventListener('load', done);
      /* 该模型不可用：从候选里剔除并顺延，杜绝空白/穿帮 */
      list.splice(currentIndex, 1);
      if (!list.length) { hideAll(); return; }
      if (currentIndex >= list.length) currentIndex = 0;
      rebuildNav();
      updateTexts(list[currentIndex]);
      bindRows(list[currentIndex]);
      setIndex(currentIndex, true);
    };

    el.addEventListener('load', done, { once: true });
    el.addEventListener('error', fail, { once: true });

    if (el.getAttribute('src') !== item.src) el.setAttribute('src', item.src);
    else done();

    clearTimeout(loadTimer);
    loadTimer = setTimeout(function () {
      if (my !== seq) return;
      showLoading(false);
      if (stage) stage.classList.remove('is-switching');
    }, 12000);
  }

  function setIndex(i, force) {
    if (!list.length) return;
    i = ((i % list.length) + list.length) % list.length;
    if (!force && i === currentIndex) return;
    currentIndex = i;
    var item = list[i];
    /* 顺序固定：文字 → 右侧字段 → 模型。三者同一 tick 内完成，杜绝图文错配 */
    updateTexts(item);
    bindRows(item);
    crossfade(item);
  }

  function rebuildNav() {
    if (!stage) return;
    stage.classList.toggle('is-multi', list.length > 1);
  }

  /* ── Tab 状态 ───────────────────────────────────────────────────── */
  function syncTabs() {
    if (!tabs) return;
    var bs = tabs.querySelectorAll('.pmv-tabs__btn');
    for (var i = 0; i < bs.length; i++) {
      var on = bs[i].getAttribute('data-pmv-mode') === mode;
      bs[i].classList.toggle('is-active', on);
      bs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  function setMode(m) {
    if (m !== '2d' && m !== '3d') return;
    if (mode === m) return;
    mode = m;
    var pm = q('.pm');
    if (pm) pm.classList.toggle('is-mv-3d', mode === '3d');
    syncTabs();
    if (mode === '3d') {
      if (!list.length || !stage) return;
      ensureLayers().then(function () {
        if (mode !== '3d' || !stage) return;
        if (!layers[front] || !layers[front].getAttribute('src')) {
          showLoading(true);
          setIndex(currentIndex, true);
        } else {
          bindRows(list[currentIndex]);
        }
      });
    } else {
      restoreRows();
    }
  }

  /* ── 四、全屏鉴赏（HTML5 Fullscreen API）──────────────────────────
     全屏目标 = .pmv-stage：它承载两个 model-viewer 层与全部切换控件，
     全屏整个展台才能在沉浸式看展时继续换藏品、看「正在展示」高亮条；
     若只全屏单个 model-viewer，交叉淡入切到另一层时会立刻穿帮。
     该容器挂 id="model-viewer"，与 getElementById('model-viewer') 对应。 */
  function fsCurrent() {
    return document.fullscreenElement || document.webkitFullscreenElement ||
           document.mozFullScreenElement || document.msFullscreenElement || null;
  }
  function fsTarget() {
    return document.getElementById(FS_ID) || stage;
  }
  function fsRequest(el) {
    var fn = el.requestFullscreen || el.webkitRequestFullscreen ||
             el.mozRequestFullScreen || el.msRequestFullscreen;
    if (!fn) return;
    var r = fn.call(el);
    if (r && r.catch) r.catch(function () {});   /* 非用户手势 / 不支持时静默 */
  }
  function fsExit() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen ||
             document.webkitCancelFullScreen || document.mozCancelFullScreen ||
             document.msExitFullscreen;
    if (!fn) return;
    var r = fn.call(document);
    if (r && r.catch) r.catch(function () {});
  }
  function toggleFullscreen() {
    if (fsCurrent()) { fsExit(); return; }      /* 再次点击 → 平滑退出 */
    var el = fsTarget();
    if (!el) return;
    /* 内联兜底：压住浏览器给 :fullscreen 的默认黑背景，恒定温暖宣纸黄 */
    el.style.backgroundColor = PAPER_BG;
    fsRequest(el);
  }
  function syncFsUI() {
    if (!stage) return;
    var cur = fsCurrent();
    var on = !!cur && (cur === stage || cur.id === FS_ID);
    stage.classList.toggle('is-fullscreen', on);
    var btn = q('.pmv-fs', stage);
    if (btn) {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', on ? '退出全屏' : '全屏鉴赏');
      btn.title = on ? '退出全屏（或按 ESC）' : '全屏鉴赏（按 ESC 退出）';
      var t = q('.pmv-fs__txt', btn);
      if (t) t.textContent = on ? '退出全屏' : '全屏鉴赏';
    }
    if (!on) stage.style.backgroundColor = '';
  }
  /* ESC 由浏览器原生退出全屏；这里做幂等兜底（250ms 后若仍在全屏才补一刀），
     不与原生处理抢时序，避免重复调用抛错。 */
  function onFsKey(e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    if (!fsCurrent()) return;
    setTimeout(function () { if (fsCurrent()) fsExit(); }, 250);
  }

  /* ── 全局委托：Tab / 箭头 / 键盘 / 全屏 ──────────────────────────── */
  function onDocClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var fs = t.closest('.pmv-fs');
    if (fs && stage && stage.contains(fs)) { toggleFullscreen(); return; }
    var btn = t.closest('[data-pmv-mode]');
    if (btn && tabs && tabs.contains(btn)) { setMode(btn.getAttribute('data-pmv-mode')); return; }
    var nav = t.closest('.pmv-nav');
    if (nav && stage && stage.contains(nav)) {
      var dir = nav.classList.contains('pmv-nav--prev') ? -1 : 1;
      setIndex(currentIndex + dir);
    }
  }

  function onKey(e) {
    if (mode !== '3d' || list.length < 2) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var a = document.activeElement;
    if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
    e.preventDefault();
    setIndex(currentIndex + (e.key === 'ArrowLeft' ? -1 : 1));
  }

  /* ── 清理 / 重建 ───────────────────────────────────────────────── */
  function cleanupNodes() {
    /* 路由切走时若正处于本展台的全屏态，先平顺退出，避免残留 top layer */
    var cur = fsCurrent();
    if (stage && cur && (cur === stage || cur.id === FS_ID)) fsExit();
    clearTimeout(loadTimer);
    layers = []; front = 0; seq++; LAYERS_P = null;
    var ns = qa('.' + TAB_CLS + ', .' + STAGE_CLS);
    for (var i = 0; i < ns.length; i++) ns[i].remove();
    var pms = qa('.pm.is-mv-3d');
    for (var j = 0; j < pms.length; j++) pms[j].classList.remove('is-mv-3d');
    tabs = null; stage = null; mvbox = null;
    restoreRows();
  }

  function reset() {
    cleanupNodes();
    appliedId = null; resolving = false; list = []; currentIndex = 0; mode = '2d';
  }

  /* 兜底：无模型 → 连同 Tab 一起隐藏，只留平面图（不留任何 3D 痕迹） */
  function hideAll() {
    cleanupNodes();
    list = []; currentIndex = 0;
    appliedId = currentId();
  }

  /* 构建完整 3D 视图 */
  function buildUI(pm, wrap) {
    cleanupNodes();
    wrap.insertAdjacentHTML('beforeend', TABS_HTML);
    wrap.insertAdjacentHTML('beforeend', STAGE_HTML);
    tabs = wrap.querySelector(':scope > .' + TAB_CLS);
    stage = wrap.querySelector(':scope > .' + STAGE_CLS);
    mvbox = q('.' + MVBOX_CLS, stage);

    rebuildNav();
    updateTexts(list[0]);
    pm.classList.toggle('is-mv-3d', mode === '3d');
    syncTabs();

    if (mode === '3d') {
      ensureLayers().then(function () {
        if (mode !== '3d' || !stage) return;
        showLoading(true);
        setIndex(0, true);
      });
    }
  }

  /* 无 WebGL：同尺寸静态预览（数据仍联动，模型换用纹样平面图占位） */
  function buildFallback(pm, wrap) {
    var img = q('.pm__media-wrap img', wrap.parentNode) || q('.pm__media-wrap img');
    var src = (img && img.getAttribute('src')) || '/assets/artifacts/baoxiang.jpg';
    wrap.insertAdjacentHTML('beforeend', TABS_HTML);
    wrap.insertAdjacentHTML('beforeend',
      '<div class="' + STAGE_CLS + ' is-fallback is-loaded" id="' + FS_ID + '">'
      + '<div class="pmv-stage__glass" aria-hidden="true"></div>'
      + FS_BTN_HTML
      + '<div class="pmv-stage__title"></div>'
      + '<img class="pmv-stage__poster" src="' + src + '" alt="3D 模型静态预览">'
      + '<div class="pmv-now"><span class="pmv-now__seal" aria-hidden="true">展</span>'
      + '<span class="pmv-now__k">正在展示</span><span class="pmv-now__v"></span>'
      + '<span class="pmv-now__idx"></span></div>'
      + '<div class="pmv-stage__hint"><i></i>当前环境不支持 WebGL · 已切换为静态预览<i></i></div>'
      + '</div>');
    tabs = wrap.querySelector(':scope > .' + TAB_CLS);
    stage = wrap.querySelector(':scope > .' + STAGE_CLS);
    pm.classList.toggle('is-mv-3d', mode === '3d');
    syncTabs();
    updateTexts(list[0]);
    /* 静态预览不提供切换：清掉序号，避免「01/02 却点不动」的误导 */
    var idx = q('.pmv-now__idx', stage);
    if (idx) idx.textContent = '';
  }

  /* 解析 → 校验 → 渲染 or 隐藏 */
  function resolveAndRender(id, pm, wrap) {
    if (resolving) return;
    resolving = true;
    loadData().then(function (data) {
      var p = null;
      for (var i = 0; i < data.length; i++) if (data[i].id === id) { p = data[i]; break; }
      var picked = pickList(p);
      if (!picked.length) { resolving = false; hideAll(); return; }
      validate(picked).then(function (ok) {
        resolving = false;
        appliedId = id;
        if (!ok.length) { hideAll(); return; }
        list = ok;
        currentIndex = 0;
        if (!webglOK()) { buildFallback(pm, wrap); return; }
        buildUI(pm, wrap);
      });
    }).catch(function () { resolving = false; hideAll(); });
  }

  /* ── 主循环：幂等保活 + 路由切换重建 ─────────────────────────────── */
  function tick() {
    var id = currentId();
    if (!id) { if (appliedId !== null) reset(); return; }
    var pm = q('.pm');
    var wrap = pm ? q('.pm__media-wrap', pm) : null;
    if (!pm || !wrap) return;
    if (id !== appliedId) {
      if (resolving) return;               /* 解析中，别把状态清掉重来 */
      reset();
      resolveAndRender(id, pm, wrap);
      return;
    }
    if (tabs) syncTabs();
    /* 守护：Vue 重渲染可能覆盖右侧字段，这里按当前模型补写 */
    if (mode === '3d' && list.length) bindRows(list[currentIndex]);
  }

  injectStyle();
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
  document.addEventListener('keydown', onFsKey);
  document.addEventListener('fullscreenchange', syncFsUI);
  document.addEventListener('webkitfullscreenchange', syncFsUI);
  document.addEventListener('mozfullscreenchange', syncFsUI);
  document.addEventListener('MSFullscreenChange', syncFsUI);
  tick();
  setInterval(tick, 300);
  window.addEventListener('popstate', tick);

  /* 调试 / 验收接口 */
  window.__pmvMap = {
    version: VER,
    map: PATTERN_MODEL_MAP,
    state: function () {
      return {
        id: appliedId, mode: mode, count: list.length, index: currentIndex,
        item: list[currentIndex] || null,
        /* 全屏时元素进入 top layer，offsetParent 为 null，故并上全屏态判定 */
        visible: !!stage && (!!stage.offsetParent || !!fsCurrent()),
        fullscreen: !!fsCurrent(),
        fsTargetId: stage ? stage.id : (document.getElementById(FS_ID) || {}).id || null
      };
    },
    next: function () { setIndex(currentIndex + 1); },
    prev: function () { setIndex(currentIndex - 1); },
    go: function (i) { setIndex(i, true); },
    toggleFs: toggleFullscreen
  };
})();
