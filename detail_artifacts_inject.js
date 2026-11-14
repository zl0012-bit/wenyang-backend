/* ============================================================================
 * [DETAIL-ARTIFACTS] 详情页「演变脉络 / 应用场景」通用图谱   v8
 * ----------------------------------------------------------------------------
 * v8 相对 v7 的核心变更（彻底消灭「正在考据入库中」空白盒子）：
 *   1) 取消 INCOMPLETE「入库中」分支：任何纹样都必须渲染出完整的
 *      3 图演变脉络 + 6 图应用场景，不再隐藏模块、不再出现空盒子。
 *   2) 新增「按纹样类别自动匹配兜底数据」：
 *        · 优先读取专属数据（龙纹家族 → 真实龙纹文物图）；
 *        · 无专属数据时，按 category（读自详情页 .pd__crumb）归入三大类，
 *          加载该类别的通用图文模板：
 *            植物纹  —— 素色植物瓷器 → 明清缠枝织锦 → 现代花卉插画
 *            动物纹  —— 原始彩陶鱼纹 → 清代刺绣瑞兽 → 现代数字图腾
 *            几何/自然 —— 商周青铜云雷纹 → 汉代漆器流云纹 → 现代几何矢量图
 *        · 类别判定：先看 category 关键字（植物/动物/人物），
 *          再回退到纹样名关键字，最后兜底为「几何/自然」。
 *   3) 兜底配图统一使用「纯 CSS 渐变色块」的等价实现——内联 SVG
 *      （宣纸黄 / 青铜绿 / 暗红三系 + 极淡回纹网格 + 淡字纹 + 暗角），
 *      既满足"宁缺毋滥、绝不放错图"，又保证 100% 国风质感与零串台。
 *   4) 应用场景 6 个标签固定为：青铜器 / 陶瓷 / 丝织 / 漆器 / 建筑彩绘 / 玉雕。
 *   5) 排版完全沿用 v6/v7：上排 3 等分演变、下排 6 格场景，移动端堆叠不变。
 *
 * 零源码改动：只在 /pattern/:id 运行时改写 .culture 内节点。
 * Vue 重渲染会写回原始文案/图片，故保留 MutationObserver 幂等保活
 * （写入期间断开观察 + 150ms 防抖，杜绝自触发死循环）。
 * ========================================================================== */
(function () {
  'use strict';

  var STYLE_ID = 'artcap-style';
  var IMG = '/assets/images/';
  var ART = '/assets/artifacts/';

  /* ── 内联 SVG 渐变占位图（等价纯 CSS 色块，带国风质感）───────────────
       参数：w/h 画布尺寸、c1/c2 渐变色、glyph 中央淡字、gc 字/网格色。
       preserveAspectRatio=slice 让 object-fit:cover 时始终满铺不变形。 */
  function svgURI(w, h, c1, c2, glyph, gc) {
    var p = Math.round(w / 14);                 /* 回纹网格间距 */
    var svg =
      "<svg xmlns='http://www.w3.org/2000/svg' width='" + w + "' height='" + h +
      "' viewBox='0 0 " + w + " " + h + "' preserveAspectRatio='xMidYMid slice'>" +
        "<defs>" +
          "<linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
            "<stop offset='0' stop-color='" + c1 + "'/>" +
            "<stop offset='1' stop-color='" + c2 + "'/>" +
          "</linearGradient>" +
          "<pattern id='t' width='" + p + "' height='" + p + "' patternUnits='userSpaceOnUse'>" +
            "<path d='M0 0 H" + p + " M0 0 V" + p + "' fill='none' stroke='" + gc +
            "' stroke-width='1' opacity='0.07'/>" +
          "</pattern>" +
          "<radialGradient id='v' cx='0.5' cy='0.42' r='0.80'>" +
            "<stop offset='0.55' stop-color='#000' stop-opacity='0'/>" +
            "<stop offset='1' stop-color='#000' stop-opacity='0.10'/>" +
          "</radialGradient>" +
        "</defs>" +
        "<rect width='100%' height='100%' fill='url(#g)'/>" +
        "<rect width='100%' height='100%' fill='url(#t)'/>" +
        "<text x='50%' y='54%' font-family='\"Noto Serif SC\",\"Songti SC\",SimSun,serif' " +
          "font-size='" + Math.round(h * 0.40) + "' fill='" + gc + "' fill-opacity='0.15' " +
          "text-anchor='middle' dominant-baseline='middle'>" + glyph + "</text>" +
        "<rect width='100%' height='100%' fill='url(#v)'/>" +
      "</svg>";
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  var ERAS_W = 800, ERAS_H = 600, SCENE_N = 800;

  /* ── 分类兜底：三大类别的演变脉络模板 ─────────────────────────────── */
  /* 颜色限定：宣纸黄（植物）/ 暗红（动物）/ 青铜绿（几何自然） */
  var CAT_ERAS = {
    plant: [
      { phase: '萌芽',     text: '素色植物瓷器', glyph: '陶', c: ['#f4e9cb', '#e3d0a1'], gc: '#6b4a12' },
      { phase: '流变',     text: '明清缠枝织锦', glyph: '锦', c: ['#e7d4a5', '#cbb078'], gc: '#5e3f10' },
      { phase: '数字新生', text: '现代花卉插画', glyph: '卉', c: ['#dcc08c', '#b8975c'], gc: '#4e3409' }
    ],
    animal: [
      { phase: '萌芽',     text: '原始彩陶鱼纹', glyph: '陶', c: ['#b85a40', '#8c3b2e'], gc: '#f7ecd6' },
      { phase: '流变',     text: '清代刺绣瑞兽', glyph: '绣', c: ['#a44833', '#7a2f24'], gc: '#f7ecd6' },
      { phase: '数字新生', text: '现代数字图腾', glyph: '图', c: ['#8f3a2a', '#5c231b'], gc: '#f7ecd6' }
    ],
    geometric: [
      { phase: '萌芽',     text: '商周青铜云雷纹', glyph: '铜', c: ['#8fae97', '#5d7f6a'], gc: '#eef4e8' },
      { phase: '流变',     text: '汉代漆器流云纹', glyph: '漆', c: ['#6f9080', '#49695a'], gc: '#eef4e8' },
      { phase: '数字新生', text: '现代几何矢量图', glyph: '维', c: ['#557465', '#365043'], gc: '#eef4e8' }
    ]
  };

  /* ── 应用场景 6 格（固定标签 + 国风渐变占位）──────────────────────── */
  var SCENE_DEFS = [
    { label: '青铜器',   glyph: '青', c: ['#7d9a86', '#4a6a5a'], gc: '#eef4e8' },
    { label: '陶瓷',     glyph: '陶', c: ['#efe4c6', '#d6c096'], gc: '#6b4a12' },
    { label: '丝织',     glyph: '丝', c: ['#ab4d38', '#7a2f24'], gc: '#f7ecd6' },
    { label: '漆器',     glyph: '漆', c: ['#8a3324', '#521f19'], gc: '#f7ecd6' },
    { label: '建筑彩绘', glyph: '彩', c: ['#5f8a8a', '#3c5d64'], gc: '#eaf3f0' },
    { label: '玉雕',     glyph: '玉', c: ['#83a58e', '#4f7360'], gc: '#eef4ec' }
  ];

  /* 构建 + 缓存（同一分组只算一次，避免 MutationObserver 高频重复拼串） */
  var _eraCache = {}, _scenesCache = null;
  function buildEras(group) {
    if (_eraCache[group]) return _eraCache[group];
    var arr = CAT_ERAS[group].map(function (d) {
      return {
        phase: d.phase,
        text: d.text,
        src: svgURI(ERAS_W, ERAS_H, d.c[0], d.c[1], d.glyph, d.gc),
        alt: d.text + ' · 纹样类别示意'
      };
    });
    _eraCache[group] = arr;
    return arr;
  }
  function buildScenes() {
    if (_scenesCache) return _scenesCache;
    _scenesCache = SCENE_DEFS.map(function (d) {
      return {
        label: d.label,
        src: svgURI(SCENE_N, SCENE_N, d.c[0], d.c[1], d.glyph, d.gc),
        alt: d.label + ' · 国风纹样示意'
      };
    });
    return _scenesCache;
  }

  /* ── 龙纹专属图谱（强关联字典，真实龙纹文物图，绝不串台）─────────── */
  var DRAGON_ERAS = [
    { phase: '萌芽',     text: '青铜夔龙',     src: ART + 'bronze_ding_2.jpg',         alt: '商周青铜鼎 · 夔龙蟠龙纹局部' },
    { phase: '流变',     text: '皇家御用',     src: ART + 'porc_dragon.jpg',           alt: '明清青花五爪龙纹罐局部' },
    { phase: '数字新生', text: '现代数字时代', src: IMG + 'dragon_modern_digital.png', alt: '现代设计 · 金色龙纹数字图' }
  ];
  var DRAGON_SCENES = [
    { label: '青铜礼器', src: ART + 'bronze_ding_1.jpg',    alt: '带龙纹的青铜鼎' },
    { label: '历代龙袍', src: ART + 'costume.jpg',          alt: '五爪金龙刺绣龙袍' },
    { label: '青花瓷器', src: ART + 'porc_dragon_1.jpg',    alt: '龙纹青花大盘' },
    { label: '皇家建筑', src: ART + 'nine_dragon_wall.png', alt: '九龙壁局部' },
    { label: '金玉配饰', src: ART + 'jade_dragon_1.jpg',    alt: '玉雕龙纹佩' },
    { label: '漆器木雕', src: ART + 'dragon_lacquer_box.png', alt: '龙纹红漆盒' }
  ];

  /* ── 纹样归类 ─────────────────────────────────────────────────────── */
  var DRAGON_RE = /龙纹|蟒龙|云龙|夔|团龙|玉龙|龙凤|戏珠|五爪|行龙|坐龙|升龙|降龙|蟠龙|应龙|龙袍|螭龙/;
  var EXCLUDE_RE = /莲花|宝相|飞天/;              /* 含「龙」但实为地名/莲花，排除 */
  var PLANT_RE = /莲|荷|牡丹|菊|梅|兰|竹|松|桃|石榴|葡萄|忍冬|卷草|宝相|缠枝|团花|花卉|花|草|叶|藤|海棠|芙蓉|桂|灵芝|茶花|玉兰|水仙|芍药|月季|葵|萱|瓜|果|蓼|菱花/;
  var ANIMAL_RE = /鱼|鸟|凤|鹤|鹿|马|牛|羊|虎|狮|象|兔|蝠|蝶|蝉|龟|蛇|麒麟|獬豸|瑞兽|鸳鸯|鹰|雁|鸡|犬|猴|蛙|蚕|蟹|虾|兽|鹌鹑|鹊|燕|孔雀|雉/;

  /* 类别 → 三大类宏观分组：先看 category，再回退名称关键字，最后几何/自然 */
  function classify(cat, name) {
    var c = cat || '', n = name || '';
    if (/植物|花卉|瓜果/.test(c)) return 'plant';
    if (/动物|人物|瑞兽|飞禽/.test(c)) return 'animal';
    if (PLANT_RE.test(n)) return 'plant';
    if (ANIMAL_RE.test(n)) return 'animal';
    return 'geometric';
  }

  function resolvePattern(name, cat) {
    /* ① 专属优先：龙纹家族 */
    if (DRAGON_RE.test(name) && !EXCLUDE_RE.test(name)) {
      return { mode: 'dragon', eras: DRAGON_ERAS, scenes: DRAGON_SCENES };
    }
    /* ② 无专属 → 按类别降级兜底（永不为空） */
    var group = classify(cat, name);
    return { mode: group, eras: buildEras(group), scenes: buildScenes() };
  }

  var CSS = ''
    /* ① 穿帮清理：v5 自定义图注 / 悬停层 /「考据中」提示一律不显示。
          figcaption 是原生通用标签（AI 共创工坊也在用），只清理 .culture 内的，
         绝不全局删除，避免误伤其它模块。 */
    + '.art-cap,.art-caption,.img-caption,.culture__cap,[data-art-cap],'
    + '.art-hover,.art-pending-note{display:none!important}'
    + 'html body:has(.culture) .culture figcaption{display:none!important}'

    /* ② 固定网格：上排 3 等分、下排 6 等分 */
    + 'html body:has(.culture) .culture__eras{display:grid!important;'
    + 'grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:16px!important}'
    + 'html body:has(.culture) .culture__scenes{display:grid!important;'
    + 'grid-template-columns:repeat(6,minmax(0,1fr))!important;gap:14px!important}'

    /* ③ 图片容器：固定宽高比 + 8px 圆角 + 柔和阴影 + 溢出裁切 */
    + 'html body:has(.culture) .era__media,html body:has(.culture) .scene__media{'
    + 'position:relative!important;overflow:hidden!important;'
    + 'border-radius:8px!important;border:1px solid rgba(168,128,62,.34)!important;'
    + 'box-shadow:0 4px 14px rgba(90,60,20,.16),inset 0 1px 0 rgba(255,255,255,.5)!important}'
    + 'html body:has(.culture) .era__media{aspect-ratio:4/3!important}'
    + 'html body:has(.culture) .scene__media{aspect-ratio:1/1!important}'
    /* 统一移除可能残留的金色发光框，保证三/六张完全一致 */
    + 'html body:has(.culture) .era__media.is-digital{'
    + 'box-shadow:0 4px 14px rgba(90,60,20,.16),inset 0 1px 0 rgba(255,255,255,.5)!important}'

    /* ④ 图片铺满、不变形（覆盖原生 width:74% / object-fit:contain 的小图效果） */
    + 'html body:has(.culture) .era__media img,html body:has(.culture) .scene__media img{'
    + 'position:absolute!important;inset:0!important;'
    + 'width:100%!important;height:100%!important;'
    + 'object-fit:cover!important;object-position:center center!important;'
    + 'display:block!important;'
    + 'transition:transform .55s cubic-bezier(.22,1,.36,1)!important}'

    /* ⑤ 悬停微放大 1.03 */
    + 'html body:has(.culture) .era__media:hover img,'
    + 'html body:has(.culture) .scene__media:hover img,'
    + 'html body:has(.culture) .era:hover .era__media img,'
    + 'html body:has(.culture) .scene:hover .scene__media img{transform:scale(1.03)!important}'

    /* ⑥ 阶段胶囊国风化 + 下方短文案居中不留大块空白 */
    + 'html body:has(.culture) .era__phase{'
    + 'background:rgba(122,85,18,.80)!important;'
    + 'border:1px solid rgba(214,176,96,.55)!important;'
    + 'backdrop-filter:blur(4px);letter-spacing:.08em}'
    + 'html body:has(.culture) .era__text{'
    + 'min-height:0!important;text-align:center!important;'
    + 'padding:12px 8px!important;letter-spacing:.08em}'

    /* ⑥b 器物标签：原生 is-blue 为浅蓝白字，在金色宣纸底上对比度不足，
         统一改成与上排阶段胶囊同款暗金底 + 浅色字，干净且易读 */
    + 'html body:has(.culture) .culture__scenes .pattern-tag{'
    + 'color:#f7edd6!important;background:rgba(122,85,18,.84)!important;'
    + 'border:1px solid rgba(214,176,96,.62)!important;'
    + 'backdrop-filter:blur(3px);box-shadow:0 2px 8px rgba(90,60,20,.18)}'
    + 'html body:has(.culture) .culture__scenes .pattern-tag__txt{'
    + 'color:#f7edd6!important;font-weight:600;letter-spacing:.08em}'

    /* ⑦ Vue 原生 scene 多于 6 张时，隐藏多余卡片（不删 DOM，避免 vdom 抖动） */
    + 'html body:has(.culture) .scene[data-art-extra]{display:none!important}'

    /* ⑧ 防御：清除任何残留「入库中」提示（v8 起不再生成，仅作兜底） */
    + 'html body:has(.culture) .art-pending-wrap,'
    + 'html body:has(.culture) .culture.is-art-pending .culture__block:has(.culture__eras),'
    + 'html body:has(.culture) .culture.is-art-pending .culture__block:has(.culture__scenes){display:block!important}'
    + 'html body:has(.culture) .art-pending-wrap{display:none!important}'

    /* ⑨ 窄屏：6 等分 → 3 列 2 行 → 2 列 */
    + '@media(max-width:900px){'
    + 'html body:has(.culture) .culture__scenes{grid-template-columns:repeat(3,minmax(0,1fr))!important}'
    + '}'
    + '@media(max-width:560px){'
    + 'html body:has(.culture) .culture__eras{gap:8px!important}'
    + 'html body:has(.culture) .culture__scenes{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:10px!important}'
    + 'html body:has(.culture) .era__text{font-size:11px!important;padding:8px 4px!important}'
    + '}';

  function installStyle() {
    var st = document.getElementById(STYLE_ID);
    if (!st) {
      st = document.createElement('style');
      st.id = STYLE_ID;
      document.head.appendChild(st);
    }
    if (st.textContent !== CSS) st.textContent = CSS;   /* 覆盖旧样式 */
  }

  /* 幂等写文本：避免 MutationObserver 自触发 */
  function setText(el, txt) {
    if (el && el.textContent !== txt) el.textContent = txt;
  }

  /* 媒体区确保有 <img>（兼容 Vue 只渲染首字 glyph 的情况） */
  function ensureImg(media) {
    if (!media) return null;
    var img = media.querySelector('img');
    if (img) return img;
    var glyph = media.querySelector('.era__glyph, .scene__glyph');
    if (glyph) glyph.remove();
    img = document.createElement('img');
    img.alt = '';
    media.insertBefore(img, media.firstChild);
    return img;
  }

  function setImg(img, src, alt) {
    if (!img) return;
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    if (img.alt !== alt) img.alt = alt;
    img.removeAttribute('loading');
  }

  function getPatternName() {
    var el = document.querySelector('.pm__name');
    if (el && el.textContent) return el.textContent.trim();
    var h1 = document.querySelector('h1');
    if (h1 && h1.textContent) return h1.textContent.trim();
    return '';
  }

  /* 读详情页类别：面包屑「纹样宝库 / 几何纹样」取末段；无则空串 */
  function getPatternCategory() {
    var crumb = document.querySelector('.pd__crumb');
    if (crumb && crumb.textContent) {
      var parts = crumb.textContent.split(/[\/／>›»]/);
      var last = (parts[parts.length - 1] || '').trim();
      if (last && last !== '纹样宝库') return last;
    }
    var cat = document.querySelector('.pm__cat, .pm__category');
    if (cat && cat.textContent) return cat.textContent.trim();
    return '';
  }

  /* ── 穿帮清理：删掉旧版所有英文图注节点与 v5 痕迹 ─────────────────── */
  var STALE_SEL = '.art-cap,.art-caption,.img-caption,.culture__cap,[data-art-cap],'
                + '.art-hover,.art-pending-note';
  var EN_RE = /(dynasty|dynasties|century|the met|metropolitan|museum|\bBC\b|\bAD\b)/i;

  function stripStale() {
    /* v5 自定义图注类：全站清理（仅本项目注入脚本使用） */
    var nodes = document.querySelectorAll(STALE_SEL);
    for (var i = 0; i < nodes.length; i++) nodes[i].remove();

    var culture = document.querySelector('.culture');
    if (!culture) return;

    /* v8：移除任何残留的「入库中」空盒子（上一版遗留） */
    var pend = document.querySelectorAll('.art-pending-wrap, [data-art-pending="1"]');
    for (var q = 0; q < pend.length; q++) pend[q].remove();
    culture.classList.remove('is-art-pending');

    /* 原生 figcaption：限定在文化图谱内 */
    var caps = culture.querySelectorAll('figcaption');
    for (var f = 0; f < caps.length; f++) caps[f].remove();

    /* 兜底：任何「纯英文短文本」叶子节点都视为旧图注残留 */
    var leaves = culture.querySelectorAll('small,span,p,div,em,cite');
    for (var j = 0; j < leaves.length; j++) {
      var e = leaves[j];
      if (e.children.length || !e.parentNode) continue;
      var t = (e.textContent || '').trim();
      if (t && t.length < 90 && /[A-Za-z]/.test(t) && EN_RE.test(t)) e.remove();
    }

    /* v5 作用域类与标记类全部清掉 */
    var cls = ['is-pending', 'is-bx', 'is-bx-eras', 'is-bx-scenes',
               'is-bx-eras-wrap', 'is-bx-scenes-wrap', 'is-bx-divider'];
    var all = document.querySelectorAll('.culture, .culture section, .culture .scroll-reveal, .culture .section-divider');
    for (var k = 0; k < all.length; k++) {
      for (var c = 0; c < cls.length; c++) {
        if (all[k].classList.contains(cls[c])) all[k].classList.remove(cls[c]);
      }
    }
    var digs = culture.querySelectorAll('.era__media.is-digital');
    for (var d = 0; d < digs.length; d++) digs[d].classList.remove('is-digital');
  }

  /* ── 规范 scene 数量为 6：不足克隆、超出隐藏（幂等，不反复改 DOM）── */
  function normalizeScenes(culture) {
    var wrap = culture.querySelector('.culture__scenes');
    if (!wrap) return [];
    var all = [].slice.call(wrap.querySelectorAll(':scope > .scene'));
    var natives = all.filter(function (e) { return !e.hasAttribute('data-art-clone'); });
    var clones = all.filter(function (e) { return e.hasAttribute('data-art-clone'); });

    for (var i = 0; i < natives.length; i++) {
      if (i >= 6) {
        if (!natives[i].hasAttribute('data-art-extra')) natives[i].setAttribute('data-art-extra', '1');
      } else if (natives[i].hasAttribute('data-art-extra')) {
        natives[i].removeAttribute('data-art-extra');
      }
    }
    var visible = natives.slice(0, 6);
    var need = 6 - visible.length;

    while (clones.length > need) clones.pop().remove();
    while (clones.length < need) {
      var seed = natives[natives.length - 1] || visible[visible.length - 1];
      if (!seed) break;
      var c = seed.cloneNode(true);
      c.setAttribute('data-art-clone', '1');
      c.removeAttribute('data-art-extra');
      wrap.appendChild(c);
      clones.push(c);
    }
    return visible.concat(clones);
  }

  /* ── 演变脉络：按传入的 eras 配置渲染 3 张 ────────────────────────── */
  function renderEras(culture, eras) {
    var cards = culture.querySelectorAll('.culture__eras > .era');
    for (var i = 0; i < cards.length && i < eras.length; i++) {
      var cfg = eras[i], card = cards[i];
      var media = card.querySelector('.era__media');
      var img = ensureImg(media);
      setImg(img, cfg.src, cfg.alt);
      setText(card.querySelector('.era__phase'), cfg.phase);
      setText(card.querySelector('.era__text'), cfg.text);
    }
  }

  /* ── 应用场景：按传入的 scenes 配置渲染 6 张 ──────────────────────── */
  function renderScenes(culture, cards, scenes) {
    for (var i = 0; i < cards.length && i < scenes.length; i++) {
      var cfg = scenes[i], card = cards[i];
      var media = card.querySelector('.scene__media');
      var img = ensureImg(media);
      setImg(img, cfg.src, cfg.alt);
      setText(card.querySelector('.pattern-tag__txt'), cfg.label);
      /* 克隆卡片可能带 v5 悬停层，清掉 */
      var hov = media && media.querySelector('.art-hover');
      if (hov) hov.remove();
    }
  }

  function apply() {
    var culture = document.querySelector('.culture');
    if (!culture) return;                 /* 不在纹样详情页 */

    var name = getPatternName();
    var cat = getPatternCategory();
    var resolved = resolvePattern(name, cat);

    stripStale();

    /* 永远渲染完整的 3 + 6，绝不再出现「入库中」空盒子 */
    var cards = normalizeScenes(culture);
    renderEras(culture, resolved.eras);
    renderScenes(culture, cards, resolved.scenes);
  }

  /* 防抖 + 观察期间断开重连（杜绝自触发死循环）。
     characterData / src 变更也要观察：Vue 重渲染会把 era__text、场景标签写回
     原始文案、把 img.src 写回 imageUrl，仅监听 childList 会漏掉这类回写。
     自身写入均在 disconnect 期间完成，且 setText / setImg 幂等，不会自触发。 */
  var mo = new MutationObserver(function () { schedule(); });
  function startObserve() {
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['src']
    });
  }
  function applySafe() {
    mo.disconnect();
    try { installStyle(); apply(); } finally { startObserve(); }
  }
  var t = null;
  function schedule() {
    if (t) clearTimeout(t);
    t = setTimeout(applySafe, 150);
  }

  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function () { var r = orig.apply(this, arguments); setTimeout(applySafe, 80); return r; };
  });
  window.addEventListener('popstate', function () { setTimeout(applySafe, 80); });

  installStyle();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(applySafe, 300); setTimeout(applySafe, 900); });
  } else {
    setTimeout(applySafe, 300); setTimeout(applySafe, 900);
  }
  startObserve();
})();
