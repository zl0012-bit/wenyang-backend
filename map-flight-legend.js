/* ============================================================
 * [MAP-FLIGHT-LEGEND] 纹样地图 · 流光飞线业务语义注入
 *
 *   1) ~~右下角常驻铭牌~~ —— [flight8] 已按需求移除：
 *      白色说明卡片（「纹样传播/交融路径」+ 下方注释）不再渲染。
 *      原因：底部横向图例栏已有同名标识，两者重复且遮挡地图。
 *      ensureLegend 保留为空壳，仅用于清理旧版本可能残留的 DOM 节点。
 *   2) Vue 原生图例出现时，追加一条飞线简项（幂等保活）
 *   3) 悬停飞线 → Tooltip「文化交融与传播轨迹」（保留不动）
 *   4) 颜色：从 .sand-line-flow 的 computed stroke 实时读取，写入
 *      --wb-flight-color，图例样本 / 追加项 / 光晕全部引用同一变量
 *
 * 关键约束：#wb-sand-fx 整体 pointer-events:none（沙盘为保证点击穿透
 *   刻意设置），因此不能用 mouseenter。本模块改用 document mousemove +
 *   路径几何距离检测，完全不改动飞线的 pointer-events，零点击干扰。
 *
 * ★ [flight5] 散点 / 飞线提示彻底分离（修复串台 Bug）：
 *   · 散点 .map-marker → Vue 原生 .china-map__tip（省份名 + 纹样数据）
 *   · 飞线 .sand-line-flow → #wbFlightTip（文化交融与传播轨迹）
 *   · 已删除「把 .map-marker 当作飞线端点」的旧命中兜底 —— 那正是
 *     悬停省份圆点却弹出飞线释义的根因。
 *   · onMove 增加散点优先守卫：鼠标落在圆点上，飞线提示与飞线高亮
 *     一律不出现；即使飞线几何路径恰好穿过圆点也不会串台。
 *   · 飞线文案写入每条 .sand-line-flow 的 data-wb-tip，showTip 只从
 *     命中的飞线元素读取，圆点永远拿不到这句文案。
 *
 * 仅 /map 生效；离开页面自动清理；不碰 Vue 源码与 map_sandtable.js。
 * ============================================================ */
(function () {
  'use strict';

  var CSS_HREF = '/assets/map-flight-legend.css?v=20261112flight8';
  var VER = 'flight8';
  var LEGEND_ID = 'wbFlightLegend';
  var TIP_ID = 'wbFlightTip';
  var INLINE_CLS = 'wb-fl-legend-inline';
  var LABEL = '纹样传播/交融路径';
  var TIP_TEXT = '文化交融与传播轨迹';   /* 仅写入飞线元素，散点禁用 */
  var NOTE = '注：流光飞线示意非遗纹样在历史长河中的地域传播与民族交融路径。';
  var FALLBACK_COLOR = 'rgb(255, 223, 122)';
  var HIT_THRESHOLD = 12;   /* SVG 用户单位，约合 18 屏幕 px，容忍细线 */
  var SAMPLES = 36;
  var HOVER_CLS = 'wb-flight-hover';      /* 飞线高亮，仅命中那一条 */
  var SCOPE_LINE = 'line', SCOPE_MARKER = 'marker';

  var lastColor = '';
  var bound = false;
  var rafPending = false;
  var lastMouse = null;
  var mo = null, moTarget = null;

  function q(s, r) { return (r || document).querySelector(s); }
  function isMap() {
    return location.pathname.indexOf('/map') === 0 && !!q('.china-map__stage');
  }

  function injectStyle() {
    if (q('link[href*="map-flight-legend.css"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = CSS_HREF;
    document.head.appendChild(l);
  }

  /* ---------- 颜色：与飞线严格同源 ---------- */
  function syncColor(stage) {
    var f = q('.sand-line-flow');
    var c = f ? getComputedStyle(f).stroke : '';
    if (!c || c === 'none' || c === 'transparent') c = FALLBACK_COLOR;
    if (c !== lastColor) {
      lastColor = c;
      if (stage) stage.style.setProperty('--wb-flight-color', c);
      document.documentElement.style.setProperty('--wb-flight-color', c);
    }
    return c;
  }

  /* ---------- [flight8] 右下角常驻铭牌：已移除 ----------
   * 需求：删除右下角白色说明卡片（「纹样传播/交融路径」+ 注释文字）。
   *   · 底部横向图例栏保留（那里已有同名标识）→ 见 injectInline()
   *   · 飞线 Tooltip 保留 → 见 ensureTip() / showTip()
   * 此处不再创建任何 DOM；仅幂等清除历史版本遗留节点，
   * 避免浏览器缓存旧脚本时卡片仍残留在页面上。
   * ------------------------------------------------------------ */
  function ensureLegend(stage) {
    var el = document.getElementById(LEGEND_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    return null;
  }

  /* ---------- Tooltip 容器 ---------- */
  function ensureTip(stage) {
    var el = document.getElementById(TIP_ID);
    if (el && el.parentElement === stage) return el;
    if (el) el.parentNode.removeChild(el);
    el = document.createElement('div');
    el.id = TIP_ID;
    el.className = 'wb-fl-tip';
    el.setAttribute('role', 'tooltip');
    el.setAttribute('data-wb-scope', SCOPE_LINE);
    /* 文案不在此硬编码：showTip 只从命中的 .sand-line-flow 的
       data-wb-tip 读取，保证这句释义只可能来自飞线，绝不到散点上。 */
    el.textContent = '';
    stage.appendChild(el);
    return el;
  }

  /* ---------- Vue 图例内追加飞线简项（重渲染后幂等补回） ---------- */
  function injectInline() {
    var lg = q('.china-map__legend');
    if (!lg || q('.' + INLINE_CLS, lg)) return;
    var sp = document.createElement('span');
    sp.className = 'china-map__legend-item ' + INLINE_CLS;
    sp.setAttribute('data-v-e893edc4', '');
    var i = document.createElement('i');
    i.setAttribute('data-v-e893edc4', '');
    sp.appendChild(i);
    sp.appendChild(document.createTextNode(LABEL));
    lg.appendChild(sp);
  }

  /* ---------- 数据配置显式分离（幂等） ----------
     飞线：data-wb-scope="line" + data-wb-tip=「文化交融与传播轨迹」
     散点：data-wb-scope="marker"；其提示由 Vue 原生 .china-map__tip 提供，
           内容是该省份的具体数据（省份名 + 纹样丰富度），绝不写飞线释义。
     Vue 原生提示也打上 marker 标记，便于验收脚本精确区分两种 Tooltip。 */
  function bindScope(stage) {
    var flows = stage.querySelectorAll('.sand-line-flow');
    for (var i = 0; i < flows.length; i++) {
      flows[i].setAttribute('data-wb-scope', SCOPE_LINE);
      if (flows[i].getAttribute('data-wb-tip') !== TIP_TEXT)
        flows[i].setAttribute('data-wb-tip', TIP_TEXT);
    }
    var mks = stage.querySelectorAll('.map-marker');
    for (var j = 0; j < mks.length; j++) {
      if (!mks[j].hasAttribute('data-wb-scope'))
        mks[j].setAttribute('data-wb-scope', SCOPE_MARKER);
    }
    var vt = q('.china-map__tip');
    if (vt) vt.setAttribute('data-wb-scope', SCOPE_MARKER);
  }

  /* ---------- 点到线段距离 ---------- */
  function distToSeg(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1, L = dx * dx + dy * dy;
    var t = L ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
  }

  /* 屏幕坐标 → 飞线本地坐标（getScreenCTM 含父级 roam 变换） */
  function toLocal(flow, svg, x, y) {
    try {
      var m = flow.getScreenCTM();
      if (m) {
        var pt = svg.createSVGPoint();
        pt.x = x; pt.y = y;
        return pt.matrixTransform(m.inverse());
      }
    } catch (e) { /* 落到 fallback */ }
    /* fallback：viewBox 线性映射 + roamG 的 translate/scale 逆运算 */
    try {
      var r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
      if (!r.width || !r.height) return null;
      var px = (x - r.left) * (vb.width / r.width) + vb.x;
      var py = (y - r.top) * (vb.height / r.height) + vb.y;
      var g = flow.parentNode, tr = (g && g.getAttribute('transform')) || '';
      var mm = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)\s*scale\(\s*([-\d.]+)\s*\)/.exec(tr);
      if (mm) { px = (px - parseFloat(mm[1])) / parseFloat(mm[3]); py = (py - parseFloat(mm[2])) / parseFloat(mm[3]); }
      return { x: px, y: py };
    } catch (e) { return null; }
  }

  /* flow 本地坐标 → 屏幕坐标（与 toLocal 用同一个 getScreenCTM，互为逆变换） */
  function toScreen(flow, svg, p) {
    try {
      var m = flow.getScreenCTM();
      if (m) {
        var pt = svg.createSVGPoint();
        pt.x = p.x; pt.y = p.y;
        var s = pt.matrixTransform(m);
        return { x: s.x, y: s.y };
      }
    } catch (e) { /* 落到鼠标坐标兜底 */ }
    return null;
  }

  /* 命中一条飞线时，返回它在屏幕上的最近投影点；未命中返回 null */
  function nearestOnFlow(flow, svg, x, y) {
    var p = toLocal(flow, svg, x, y);
    if (!p) return null;
    var len;
    try { len = flow.getTotalLength(); } catch (e) { return null; }
    if (!len || !isFinite(len)) return null;
    var best = null, prev = null;
    for (var j = 0; j <= SAMPLES; j++) {
      var pt;
      try { pt = flow.getPointAtLength(len * j / SAMPLES); } catch (e) { break; }
      if (prev) {
        var d = distToSeg(p.x, p.y, prev.x, prev.y, pt.x, pt.y);
        if (!best || d < best.d) {
          var dx = pt.x - prev.x, dy = pt.y - prev.y, L = dx * dx + dy * dy;
          var t = L ? ((p.x - prev.x) * dx + (p.y - prev.y) * dy) / L : 0;
          t = Math.max(0, Math.min(1, t));
          best = { d: d, pt: { x: prev.x + t * dx, y: prev.y + t * dy } };
        }
      }
      prev = pt;
    }
    if (!best || best.d > HIT_THRESHOLD) return null;
    return toScreen(flow, svg, best.pt) || { x: x, y: y };
  }

  /* 只检测飞线本体：返回 {x, y, flow}（屏幕锚点 + 命中的飞线元素）。
     ★ 散点 .map-marker 绝不参与命中 —— 它的提示是 Vue 的 .china-map__tip
       （省份名 + 纹样数据），与「文化交融与传播轨迹」彻底隔离。
     对外 .hit(x,y) 仍返回布尔，兼容既有验收脚本。 */
  function hitTest(svg, x, y) {
    var flows = svg.querySelectorAll('.sand-line-flow'), best = null;
    for (var k = 0; k < flows.length; k++) {
      var n = nearestOnFlow(flows[k], svg, x, y);
      if (!n) continue;
      var d = Math.abs(n.x - x) + Math.abs(n.y - y);
      if (!best || d < best.d) best = { x: n.x, y: n.y, d: d, flow: flows[k] };
    }
    return best ? { x: best.x, y: best.y, flow: best.flow } : null;
  }

  /* 圆点几何命中（包围盒保守判定，容错 3D 展平动画的坐标系偏差）：
     沙盘移入会展平，getBoundingClientRect / elementFromPoint 可能短暂错位；
     用圆点包围盒判定 —— 宁可圆点附近不显示飞线提示，也绝不把
     「文化交融与传播轨迹」弹到省份圆点上。 */
  function markerAt(svg, x, y) {
    var mks = svg.querySelectorAll('.map-marker');
    for (var i = 0; i < mks.length; i++) {
      var r = mks[i].getBoundingClientRect();
      if (r.width && r.height &&
          x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return mks[i];
    }
    return null;
  }

  /* Vue 原生散点提示可见 = 鼠标确实在某个 .map-marker 上（最权威的信号） */
  function vueTipVisible() {
    var t = q('.china-map__tip');
    if (!t) return false;
    var s = getComputedStyle(t);
    return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.05;
  }

  /* 锚点 = 鼠标 55% + 飞线最近点 45%：既跟手，又被拉回线上，不飘到空白处；
     再按 stage 四边做 clamp，避免提示框越界或被裁掉。 */
  function showTip(stage, mx, my, near) {
    var tip = ensureTip(stage), r = stage.getBoundingClientRect();
    /* 文案唯一来源：命中的那条飞线的 data-wb-tip。散点永远走不到这里。 */
    tip.textContent = (near && near.flow && near.flow.getAttribute('data-wb-tip')) || TIP_TEXT;
    var ax = near ? mx * 0.55 + near.x * 0.45 : mx;
    var ay = near ? my * 0.55 + near.y * 0.45 : my;
    var tw = tip.offsetWidth || 150, th = tip.offsetHeight || 32;
    var half = tw / 2 + 8;
    var left = Math.max(half, Math.min(r.width - half, ax - r.left));
    /* transform 含 -100%（向上翻），顶部至少留 th + 8 才不会溢出 stage */
    var top = Math.max(th + 8, Math.min(r.height - 8, ay - r.top));
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.classList.add('is-on');
  }
  function hideTip() {
    var t = document.getElementById(TIP_ID);
    /* 连文案一起清空：圆点 hover / 移出飞线后，DOM 里也不残留飞线释义 */
    if (t) { t.classList.remove('is-on'); t.textContent = ''; }
  }

  /* 飞线高亮：只高亮命中的那一条（连同它的底线与箭头）。
     鼠标落在散点上或移出飞线 → 全部清除；圆点由 CSS :hover 独立放大发光。 */
  function setFlowHover(flow) {
    var fx = document.getElementById('wb-sand-fx') || (flow && flow.parentNode);
    if (!fx) return;
    var olds = fx.querySelectorAll('.' + HOVER_CLS);
    for (var i = 0; i < olds.length; i++) olds[i].classList.remove(HOVER_CLS);
    if (!flow) return;
    flow.classList.add(HOVER_CLS);
    var p = flow.previousElementSibling, n = flow.nextElementSibling;
    if (p && p.classList && p.classList.contains('sand-line-base')) p.classList.add(HOVER_CLS);
    if (n && n.classList && n.classList.contains('sand-arrow')) n.classList.add(HOVER_CLS);
  }

  function onMove(e) {
    if (!isMap()) { hideTip(); setFlowHover(null); return; }
    lastMouse = { x: e.clientX, y: e.clientY };
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      if (!lastMouse || !isMap()) { hideTip(); setFlowHover(null); return; }
      var stage = q('.china-map__stage'), svg = stage && q('.china-map__svg', stage);
      if (!svg) { hideTip(); setFlowHover(null); return; }

      /* ① 散点优先：包围盒 / elementFromPoint / Vue 提示可见，三重判定任一
         成立 → 飞线提示与飞线高亮一律不出现。圆点提示是 Vue 原生
         .china-map__tip（省份名 + 纹样数据），绝不出现飞线释义。 */
      var under = document.elementFromPoint(lastMouse.x, lastMouse.y);
      var marker = markerAt(svg, lastMouse.x, lastMouse.y) ||
                   (under && under.closest ? under.closest('.map-marker') : null);
      if (marker || vueTipVisible()) {
        /* 散点自己的提示数据：取 Vue 原生 .china-map__tip 的省份文本写入
           data-wb-tip，带禁用词守卫，绝不会把飞线释义写到圆点上。 */
        var vt = q('.china-map__tip');
        if (vt) {
          vt.setAttribute('data-wb-scope', SCOPE_MARKER);
          var txt = vt.textContent.trim().replace(/\s+/g, ' ');
          if (marker && txt && !/文化交融|传播轨迹/.test(txt))
            marker.setAttribute('data-wb-tip', txt);
        }
        hideTip(); setFlowHover(null); return;
      }

      /* ② 命中飞线 → 只显示飞线提示，并只高亮这一条飞线 */
      var hit = hitTest(svg, lastMouse.x, lastMouse.y);
      if (hit && hit.flow) {
        setFlowHover(hit.flow);
        showTip(stage, lastMouse.x, lastMouse.y, hit);
      } else {
        hideTip(); setFlowHover(null);
      }
    });
  }

  /* Vue 图例是 v-if 动态渲染的：监听节点出现，切图层后立刻补上飞线项，
     不再依赖 1.2s 轮询；tick 仍负责兜底（Vue patch 冲掉后补回）。 */
  function observeStage(stage) {
    if (!window.MutationObserver) return;
    if (mo && moTarget === stage) return;
    if (mo) mo.disconnect();
    moTarget = stage;
    mo = new MutationObserver(function (muts) {
      if (!isMap()) return;
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes || [];
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType === 1 && n.classList && n.classList.contains('china-map__legend')) {
            setTimeout(function () {         /* 避开 Vue 正在 patch 的同一帧 */
              injectInline();
            }, 0);
            return;
          }
        }
      }
    });
    mo.observe(stage, { childList: true, subtree: true });
  }

  function cleanup() {
    setFlowHover(null);
    var a = document.getElementById(LEGEND_ID); if (a) a.parentNode.removeChild(a);
    var b = document.getElementById(TIP_ID); if (b) b.parentNode.removeChild(b);
    var c = q('.' + INLINE_CLS); if (c && c.parentNode) c.parentNode.removeChild(c);
    if (mo) { mo.disconnect(); mo = null; moTarget = null; }
  }

  function tick() {
    if (!isMap()) { cleanup(); hideTip(); return; }
    injectStyle();
    var stage = q('.china-map__stage');
    syncColor(stage);
    ensureLegend(stage);      /* [flight8] 现在只负责清除遗留铭牌，返回 null */
    ensureTip(stage);
    injectInline();
    bindScope(stage);
    observeStage(stage);
    if (!bound) {
      document.addEventListener('mousemove', onMove, { passive: true });
      document.addEventListener('scroll', function () { hideTip(); setFlowHover(null); }, { passive: true });
      bound = true;
    }
  }

  function boot() {
    injectStyle();
    tick();
    setInterval(tick, 1200);
  }

  /* 调试 / 验收接口 */
  window.__wbFlightLegend = {
    version: VER,
    color: function () { return lastColor; },
    hit: function (x, y) { var s = q('.china-map__svg'); return s ? !!hitTest(s, x, y) : false; },
    anchor: function (x, y) {
      var s = q('.china-map__svg'); if (!s) return null;
      var h = hitTest(s, x, y); return h ? { x: h.x, y: h.y } : null;
    },
    /* 鼠标位置归属：marker（散点）/ line（飞线）/ null，与 onMove 同一判定 */
    scope: function (x, y) {
      var s = q('.china-map__svg'); if (!s) return null;
      var el = document.elementFromPoint(x, y);
      if (markerAt(s, x, y) || vueTipVisible() ||
          (el && el.closest && el.closest('.map-marker'))) return SCOPE_MARKER;
      return hitTest(s, x, y) ? SCOPE_LINE : null;
    },
    /* Vue 原生散点提示文本：省份名 + 纹样数据（绝不含飞线释义） */
    markerTip: function () {
      var t = q('.china-map__tip');
      return t ? t.textContent.trim().replace(/\s+/g, ' ') : '';
    },
    label: LABEL, tip: TIP_TEXT, note: NOTE
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
