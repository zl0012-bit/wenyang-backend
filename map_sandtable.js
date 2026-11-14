/* ============================================================================
 * [MAP-SANDTABLE] 纹样地图 · 国风 3D 数据沙盘（运行时注入，零依赖，全部可逆）
 * ----------------------------------------------------------------------------
 * 为什么不用 ECharts：本站地图是内联 SVG（viewBox 0 0 1000 820），不是 ECharts
 *   实例，全项目也没有 echarts。为兑现「轻量、不引入 Three.js / echarts-gl、
 *   不卡顿」，飞线用 SVG <path> + CSS 拖尾 + SMIL 箭头，涟漪用 <circle> + CSS
 *   缩放动画，3D 与交互全部用 CSS transform / 原生事件，零新增依赖。
 *
 * 只做四件事（外加自检兜底）：
 *   ① 给 <html> 加 wb-sand-on（配合 map-sandtable.css 打开 3D 舞台/深底/亮金）
 *   ② 往 roam 层 <g transform> 注入飞线 + 雷达涟漪（pointer-events:none）
 *   ③ 展平交互：鼠标移入地图即平滑展平（含底座），移出恢复 40° 倾斜
 *      （最终抛光：3D 视觉与精准点击兼得）
 *   ④ 自检：结构异常 / 注入报错 / 3D 破坏点击 → 立即回滚 2D 并输出指定文案
 *
 * 幂等：所有写入先判存在；MutationObserver 观察期断开重连，杜绝自触发死循环。
 * 作用域：仅 /map 且存在 .china-map__stage 时启用；离开自动清除，零串台。
 * 回滚：window.__wbSandtableRollback() 或移除 index.html 中本文件/CSS 的引用。
 * ========================================================================== */
(function () {
  'use strict';

  var ON = 'wb-sand-on';           /* <html> 总开关 */
  var FLAT = 'is-flat';            /* 舞台展平态 */
  var FX_ID = 'wb-sand-fx';        /* 注入的特效 <g> */
  var SVGNS = 'http://www.w3.org/2000/svg';
  var VER = '20261107sand6';

  /* ---- 与 ChinaMap 组件 f() 完全一致的经纬度投影（F=1000, W=820） ---- */
  function proj(lng, lat) {
    return [
      +(((lng - 72) / 64) * 1000).toFixed(1),
      +(((54 - lat) / 39) * 820).toFixed(1)
    ];
  }
  var P = {
    beijing:   proj(116.4, 39.9),   /* 北京 */
    shaanxi:   proj(108.9, 34.3),   /* 陕西 · 西安 */
    gansu:     proj(103.8, 36.1),   /* 甘肃 · 敦煌（汇聚终点） */
    jiangsu:   proj(118.8, 32.0),   /* 江苏 · 东南沿海 */
    zhejiang:  proj(120.2, 30.3),   /* 浙江 · 东南沿海 */
    guangdong: proj(113.3, 23.1),   /* 广东 · 东南沿海 */
    shandong:  proj(117.0, 36.7)    /* 山东 · 沿海 */
  };

  /* 飞线：北京 / 西安 起点 + 东南沿海多条，统一指向甘肃（敦煌） */
  var FLOWS = [
    ['beijing', 'gansu'],
    ['shaanxi', 'gansu'],
    ['jiangsu', 'gansu'],
    ['zhejiang', 'gansu'],
    ['guangdong', 'gansu'],
    ['shandong', 'gansu']
  ];
  /* 涟漪中心：甘肃为主，北京 / 西安 为次 */
  var HUBS = [['gansu', 1], ['beijing', .62], ['shaanxi', .62]];

  var AC = null;                   /* 事件 AbortController */
  var verified = false, verifyTimer = null, scheduleTimer = null;
  var mo = null;

  function log() {}

  /* ---------------------- 终极兜底：一键回滚 2D ---------------------- */
  function rollback(reason) {
    try {
      document.documentElement.classList.remove(ON);
      var st = document.querySelector('.china-map__stage');
      if (st) { st.classList.remove(FLAT); st.__wbSandBound = false; }
      var fx = document.getElementById(FX_ID);
      if (fx && fx.parentNode) fx.parentNode.removeChild(fx);
      if (AC) { try { AC.abort(); } catch (e) {} AC = null; }
      if (mo) { try { mo.disconnect(); } catch (e) {} }
      window.__wbSandRolledBack = true;
    } catch (e) {}
    /* 用户指定的保命文案，原样输出 */
    try {
      console.error('3D 升级失败，已回滚 2D');
      if (reason) console.warn('[国风沙盘] 回滚原因：' + reason);
    } catch (e) {}
  }
  window.__wbSandtableRollback = rollback;   /* 控制台可手动保命 */
  window.__wbSandtableVersion = VER;

  /* ---------------------- 二次贝塞尔弧线 ---------------------- */
  function arc(a, b, bend) {
    var x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1];
    var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    var dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len, ny = dx / len;       /* 法线方向 */
    var k = bend * len;
    var cx = (mx + nx * k).toFixed(1), cy = (my + ny * k).toFixed(1);
    return 'M' + x1 + ' ' + y1 + ' Q' + cx + ' ' + cy + ' ' + x2 + ' ' + y2;
  }

  function mk(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]);
    return e;
  }

  /* ---------------------- 构造飞线 + 涟漪 <g> ---------------------- */
  function buildFx() {
    var g = mk('g', { id: FX_ID, 'class': 'wb-sand-fx' });

    FLOWS.forEach(function (pair, i) {
      var a = P[pair[0]], b = P[pair[1]];
      var d = arc(a, b, (i % 2 ? -1 : 1) * (0.13 + 0.042 * i));

      /* 底线（暗金细线，标出航线） */
      g.appendChild(mk('path', { 'class': 'sand-line-base', d: d, pathLength: '100' }));
      /* 流光拖尾（等效 effect.trailLength≈0.6） */
      var flow = mk('path', { 'class': 'sand-line-flow', d: d, pathLength: '100' });
      flow.style.animationDelay = (i * 0.34) + 's';
      g.appendChild(flow);
      /* 金色箭头沿路径飞行（等效 effect.symbol='arrow'） */
      var ar = mk('polygon', { 'class': 'sand-arrow', points: '0,-5 12,0 0,5' });
      var am = mk('animateMotion', {
        dur: (2.4 + i * 0.18) + 's', repeatCount: 'indefinite', rotate: 'auto', path: d
      });
      ar.appendChild(am);
      g.appendChild(ar);
    });

    HUBS.forEach(function (h) {
      var p = P[h[0]], s = h[1];
      /* 落地盘：与涟漪/汇聚点严格同心，贴地暗色基座，消除 3D 倾斜下的「飘」感 */
      g.appendChild(mk('circle', {
        'class': 'sand-ground', cx: p[0], cy: p[1], r: (30 * s).toFixed(1)
      }));
      /* 主汇聚点（甘肃/敦煌）额外一圈常驻雷达环 */
      if (s === 1) {
        g.appendChild(mk('circle', {
          'class': 'sand-radar', cx: p[0], cy: p[1], r: (30 * s).toFixed(1)
        }));
      }
      var rg = mk('g', {
        'class': 'sand-ripple',
        transform: 'translate(' + p[0] + ' ' + p[1] + ')'
      });
      for (var k = 0; k < 3; k++) {
        rg.appendChild(mk('circle', { r: (30 * s).toFixed(1) }));
      }
      g.appendChild(rg);
      g.appendChild(mk('circle', {
        'class': 'sand-hub', cx: p[0], cy: p[1], r: (4.2 * s).toFixed(1)
      }));
    });
    return g;
  }

  /* ---------------------- 命中自检：3D 不能破坏点击 ----------------------
   * 取若干 marker 圆心的屏幕坐标，用 elementFromPoint 检查是否仍命中
   * .map-marker。开场层/首屏特效遮挡、视口外的点一律跳过；只有「测到有效点
   * 且一个都命不中」才判为失败 → 触发回滚，正对应用户的保命条款。 */
  function hitCheck(svg) {
    try {
      if (document.getElementById('giltIntro')) return true;   /* 开场层未退场，跳过 */
      var ms = svg.querySelectorAll('.map-marker');
      var tested = 0, hit = 0;
      for (var i = 0; i < ms.length; i++) {
        var dot = ms[i].querySelector('.map-marker__dot');
        if (!dot) continue;
        var r = dot.getBoundingClientRect();
        var x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (x < 2 || y < 2 || x > window.innerWidth - 2 || y > window.innerHeight - 2) continue;
        var el = document.elementFromPoint(x, y);
        if (!el) continue;
        if (el.closest && (el.closest('#giltHeroFx') || el.closest('.gilt-intro'))) continue;
        tested++;
        if (el.closest && el.closest('.map-marker')) hit++;
      }
      if (tested === 0) return true;    /* 没测到有效点，不误判 */
      return hit > 0;                   /* 至少一个命中即通过 */
    } catch (e) { return true; }
  }

  /* ---------------------- 主逻辑（幂等） ---------------------- */
  function apply() {
    if (window.__wbSandRolledBack) return;

    var html = document.documentElement;
    var onMap = /\/map\/?$/.test(location.pathname);
    var stage = document.querySelector('.china-map__stage');

    /* 离开地图页：清总开关与特效节点，保证零串台 */
    if (!onMap || !stage) {
      html.classList.remove(ON);
      var fx0 = document.getElementById(FX_ID);
      if (fx0 && fx0.parentNode) fx0.parentNode.removeChild(fx0);
      return;
    }

    try {
      var svg = stage.querySelector('svg.china-map__svg');
      if (!svg) return;                                   /* Vue 尚未渲染完成 */
      var roamG = svg.querySelector('g[transform]');     /* roam 平移缩放层 */
      var markers = svg.querySelectorAll('.map-marker');
      if (!roamG || markers.length < 5) return;          /* 结构未就绪，等下次 */

      var firstEnable = !html.classList.contains(ON);
      var baseHit = firstEnable ? hitCheck(svg) : null;  /* 2D 态基线 */

      /* ① 打开 3D 舞台总开关 */
      html.classList.add(ON);

      /* ② 注入特效层（幂等，Vue 重建后被冲掉会自动补回） */
      var fx = document.getElementById(FX_ID);
      if (!fx) { fx = buildFx(); roamG.appendChild(fx); }
      else if (fx.parentNode !== roamG) { roamG.appendChild(fx); }

      /* ③ 展平交互（最终抛光）
       * 鼠标移入地图 → 整个倾斜底座平滑展平 rotateX(0deg)，保证点击零坐标偏移；
       * 鼠标移出 → 恢复 40° 沙盘视觉。底座 ::after 与地图共用同一 transform，
       * 由 CSS 的 .is-flat 规则同步展平，不会出现厚度边错位。
       * 键盘聚焦 / 触摸 / 按下同样展平，覆盖无障碍与移动端。
       */
      if (!stage.__wbSandBound) {
        stage.__wbSandBound = true;
        AC = new AbortController();
        var opt = { signal: AC.signal };
        stage.addEventListener('mouseenter', function () { stage.classList.add(FLAT); }, opt);
        stage.addEventListener('mouseleave', function () { stage.classList.remove(FLAT); }, opt);
        stage.addEventListener('focusin', function () { stage.classList.add(FLAT); }, opt);
        stage.addEventListener('touchstart', function () { stage.classList.add(FLAT); }, { passive: true, signal: AC.signal });
        stage.addEventListener('pointerdown', function () { stage.classList.add(FLAT); }, opt);
      }

      /* ④ 倾斜态命中自检：仅在首次启用、且基线有效时做一次 */
      if (firstEnable && !verified && !verifyTimer && baseHit !== false) {
        verifyTimer = setTimeout(function () {
          verifyTimer = null;
          if (window.__wbSandRolledBack) return;
          var svg2 = document.querySelector('.china-map__stage svg.china-map__svg');
          if (!svg2) return;
          if (!hitCheck(svg2)) {
            rollback('倾斜态命中检测失败：3D transform 导致 marker 无法精准点击');
          } else {
            verified = true;
            log('3D 沙盘已启用 · 飞线 ' + FLOWS.length + ' 条 · 涟漪 ' + HUBS.length + ' 处 · 点击自检通过');
          }
        }, 780);
      }
    } catch (e) {
      rollback('注入异常：' + (e && e.message ? e.message : e));
    }
  }

  /* 防抖 + 观察期断开重连（杜绝自触发死循环），沿用站内成熟注入模式 */
  function applySafe() {
    if (mo) { try { mo.disconnect(); } catch (e) {} }
    try { apply(); } finally { if (mo && !window.__wbSandRolledBack) startObserve(); }
  }
  function schedule() {
    if (scheduleTimer) clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(applySafe, 140);
  }
  function startObserve() {
    if (!mo) mo = new MutationObserver(function () { schedule(); });
    try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  }

  /* SPA 路由：Vue Router 的 pushState/replaceState 不触发 popstate，需 hook */
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function () { var r = orig.apply(this, arguments); setTimeout(applySafe, 90); return r; };
  });
  window.addEventListener('popstate', function () { setTimeout(applySafe, 90); });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(applySafe, 320); setTimeout(applySafe, 950);
    });
  } else {
    setTimeout(applySafe, 320); setTimeout(applySafe, 950);
  }
  startObserve();
})();
