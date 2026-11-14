/* ============================================================
 * float_drag_inject.js —— 悬浮组件「手指 / 鼠标可拖拽 + 位置记忆」
 * ------------------------------------------------------------
 * 接管两个悬浮件（均位于右下角，默认互相重叠遮挡）：
 *   ① AI 导览悬浮球  .ai-assistant__fab   （主站 App shell 渲染）
 *   ② 纹样联动按钮   #aiCoFab             （站内联动桥注入）
 *
 * 行为约定：
 *   · 按住即可拖动，松手即停；位移 < 6px 视为「点击」，不拦截原有功能；
 *   · 始终限制在视口内（含窗口缩放 / 旋屏后自动回收到可视区域）；
 *   · 拖拽中：放大 + 加深投影 + grabbing 光标，且不触发页面滚动、不误触发点击；
 *   · 位置写入 localStorage：刷新、切换到其它纹样详情页都保持不变；
 *   · 双击悬浮件 → 复位到默认泊位。
 *   · 默认泊位：AI 导览悬浮球留在右下角；纹样联动默认停靠屏幕左下角，
 *     避免与悬浮球、以及展开后的 AI 面板（占据右侧）二次重叠。
 * ============================================================ */
(function () {
  'use strict';

  var STORE_KEY = 'wb_float_pos_v1';
  var EDGE = 8;          /* 距屏幕边缘的最小安全距离 */
  var THRESHOLD = 6;     /* 判定为「拖拽」的位移阈值 */

  /* —— 位置持久化 —— */
  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveStore(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
  }
  var store = loadStore();

  /* —— 注入样式（仅一次）—— */
  function injectStyle() {
    if (document.getElementById('wbFloatStyle')) return;
    var css = [
      /* 拖拽基础：禁掉触摸手势与选中，避免拖的时候页面跟着滚 */
      '.wb-float{touch-action:none!important;-webkit-user-select:none!important;',
      'user-select:none!important;-webkit-touch-callout:none!important;cursor:grab;}',
      /* 层级：两个悬浮件统一抬到最高层，拖拽中再压过一切。
         启动键始终压在自己的面板之上（#aiCoBridge 为 2147483600），
         保证面板展开时按钮依然可见、可点、可拖。 */
      '.ai-assistant__fab{z-index:2147483000!important;}',
      '#aiCoFab{z-index:2147483630!important;}',
      '.wb-float.wb-dragging{z-index:2147483647!important;cursor:grabbing;}',
      /* 拖拽反馈：放大 + 加深投影 */
      '#aiCoFab.wb-dragging{transform:scale(1.07)!important;',
      'box-shadow:0 20px 44px rgba(120,20,30,.62),inset 0 0 0 1px rgba(245,233,201,.55)!important;}',
      '.ai-assistant__fab.wb-dragging{transform:scale(1.12)!important;',
      'box-shadow:0 22px 48px rgba(0,0,0,.58),0 0 0 2px rgba(207,162,60,.5)!important;}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'wbFloatStyle';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function isNarrow(w) { return (w || window.innerWidth) <= 560; }

  /* —— 两个悬浮件的默认泊位 —— */
  var TARGETS = [
    {
      key: 'aico',
      sel: '#aiCoFab',
      label: '纹样联动',
      /* 默认停靠左下角，彻底避开右下角的 AI 导览悬浮球与 AI 面板 */
      dock: function (w, h) {
        if (isNarrow()) return { x: 12, y: window.innerHeight - h - 18 };
        return { x: 20, y: window.innerHeight - h - 26 };
      }
    },
    {
      key: 'aifab',
      sel: '.ai-assistant__fab',
      label: 'AI 导览',
      /* 默认保持在右下角 */
      dock: function (w, h) {
        if (window.innerWidth <= 768) return { x: window.innerWidth - w - 16, y: window.innerHeight - h - 18 };
        return { x: window.innerWidth - w - 24, y: window.innerHeight - h - 28 };
      }
    }
  ];

  /* —— 工具 —— */
  function size(el) { return { w: el.offsetWidth || 56, h: el.offsetHeight || 56 }; }

  function clampPos(x, y, w, h) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var maxX = Math.max(EDGE, vw - w - EDGE);
    var maxY = Math.max(EDGE, vh - h - EDGE);
    return { x: Math.min(Math.max(EDGE, x), maxX), y: Math.min(Math.max(EDGE, y), maxY) };
  }

  function setPos(el, x, y) {
    var s = size(el);
    var p = clampPos(x, y, s.w, s.h);
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    return p;
  }

  /* 「纹样联动」展开面板跟随按钮所在半屏，避免按钮在左、面板在右的割裂感 */
  function syncBridgePanel(x) {
    var p = document.getElementById('aiCoBridge');
    if (!p) return;
    if (isNarrow()) { p.style.left = '12px'; p.style.right = '12px'; return; }
    var leftSide = (x + size(p).w / 2) < window.innerWidth / 2 || x < window.innerWidth / 2;
    if (leftSide) { p.style.left = '20px'; p.style.right = 'auto'; }
    else { p.style.right = '22px'; p.style.left = 'auto'; }
  }

  /* —— 拖拽核心 —— */
  function makeDraggable(el, cfg) {
    if (el.__wbDrag) return;
    el.__wbDrag = 1;
    el.classList.add('wb-float');
    el.dataset.wbFloat = cfg.key;
    if (!el.title) el.title = cfg.label + ' · 按住可拖动，双击复位';

    var drag = null;
    var moved = false;

    function applyDefault() {
      var s = size(el);
      var d = cfg.dock(s.w, s.h);
      var p = setPos(el, d.x, d.y);
      if (cfg.key === 'aico') syncBridgePanel(p.x);
      return p;
    }

    function applySaved() {
      var saved = store[cfg.key];
      if (!saved || typeof saved.x !== 'number') return applyDefault();
      var p = setPos(el, saved.x, saved.y);
      if (cfg.key === 'aico') syncBridgePanel(p.x);
      return p;
    }

    cfg.applyDefault = applyDefault;
    cfg.applySaved = applySaved;
    applySaved();

    function coordX(e) {
      if (e.touches && e.touches.length) return e.touches[0].clientX;
      if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0].clientX;
      return e.clientX;
    }
    function coordY(e) {
      if (e.touches && e.touches.length) return e.touches[0].clientY;
      if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0].clientY;
      return e.clientY;
    }

    function down(e) {
      if (e.button != null && e.button !== 0 && e.type.indexOf('mouse') === 0) return;
      if (drag) return;
      /* 起点取内联 left/top 而非 rect：hover 的 translateY(-2px) 会让 rect 产生 2px 系统误差 */
      var sx0 = parseFloat(el.style.left), sy0 = parseFloat(el.style.top);
      var r = el.getBoundingClientRect();
      drag = {
        sx: coordX(e), sy: coordY(e),
        x: isNaN(sx0) ? r.left : sx0,
        y: isNaN(sy0) ? r.top : sy0,
        id: e.pointerId, touch: e.type.indexOf('touch') === 0
      };
      moved = false;
      if (e.preventDefault) e.preventDefault();

      if (drag.touch) {
        window.addEventListener('touchmove', move, { passive: false });
        window.addEventListener('touchend', up);
        window.addEventListener('touchcancel', up);
      } else {
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }
      if (window.PointerEvent) {
        try { el.setPointerCapture(e.pointerId); } catch (err) {}
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      }
      window.addEventListener('blur', up);
    }

    function move(e) {
      if (!drag) return;
      var dx = coordX(e) - drag.sx;
      var dy = coordY(e) - drag.sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < THRESHOLD) return;
      if (!moved) {
        moved = true;
        el.classList.add('wb-dragging');
      }
      if (e.preventDefault) e.preventDefault();
      var p = setPos(el, drag.x + dx, drag.y + dy);
      drag.cur = p;
    }

    function up() {
      if (!drag) return;
      if (drag.touch) {
        window.removeEventListener('touchmove', move);
        window.removeEventListener('touchend', up);
        window.removeEventListener('touchcancel', up);
      } else {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      }
      if (window.PointerEvent) {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        try { el.releasePointerCapture(drag.id); } catch (err) {}
      }
      window.removeEventListener('blur', up);
      el.classList.remove('wb-dragging');
      drag = null;

      if (moved) {
        /* 真的拖动过：吞掉紧随其后的 click，避免误开 / 误关面板 */
        suppressEl = el;
        suppressUntil = Date.now() + 400;
        var p = { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 };
        store[cfg.key] = p;
        saveStore(store);
        if (cfg.key === 'aico') syncBridgePanel(p.x);
      }
    }

    /* —— 事件绑定 —— */
    if (window.PointerEvent) {
      el.addEventListener('pointerdown', down);
    }
    /* 非 Pointer 环境（老 Safari / 部分安卓内核）退化到 鼠标 + 触摸双通道 */
    el.addEventListener('mousedown', down);
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('contextmenu', function () { if (drag) return false; });

    /* 双击复位 */
    el.addEventListener('dblclick', function (e) {
      e.preventDefault();
      try { delete store[cfg.key]; saveStore(store); } catch (err) {}
      applyDefault();
    });
  }

  /* —— 拖拽结束后抑制一次 click（捕获阶段拦截，先于 Vue / 业务 handler）——
     只吞掉「本次拖拽的那个按钮」上紧随其后的那一次 click，并设 400ms 过期，
     防止松手落在按钮外时把用户之后的一次正常点击误吞。 */
  var suppressEl = null;
  var suppressUntil = 0;
  document.addEventListener('click', function (e) {
    if (!suppressEl || Date.now() > suppressUntil) { suppressEl = null; return; }
    var host = suppressEl;
    suppressEl = null;
    var t = e.target;
    if (t && t.closest && t.closest('.wb-float') === host) {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
    }
  }, true);

  /* —— 发现并绑定（悬浮件由不同时机创建：Vue 渲染 / 轮询注入）—— */
  function scan() {
    for (var i = 0; i < TARGETS.length; i++) {
      var cfg = TARGETS[i];
      var el = document.querySelector(cfg.sel);
      if (!el) continue;
      if (!el.__wbDrag) makeDraggable(el, cfg);
      else if (cfg.key === 'aico') syncBridgePanel(parseFloat(el.style.left) || 0);
    }
  }

  /* 窗口缩放 / 旋屏：把跑出视口的位置重新收回可视区域 */
  function reflow() {
    for (var i = 0; i < TARGETS.length; i++) {
      var cfg = TARGETS[i];
      var el = document.querySelector(cfg.sel);
      if (!el || !el.__wbDrag) continue;
      if (store[cfg.key]) {
        var el2 = el;
        var s = size(el2);
        setPos(el2, store[cfg.key].x, store[cfg.key].y);
        if (cfg.key === 'aico') syncBridgePanel(parseFloat(el2.style.left) || 0);
      } else if (cfg.applyDefault) {
        cfg.applyDefault();
      }
    }
  }

  function boot() {
    injectStyle();
    scan();
    /* 去重：MutationObserver 兜住动态插入，低频轮询兜住一切意外 */
    var pending = null;
    var mo = new MutationObserver(function () {
      if (pending) return;
      pending = setTimeout(function () { pending = null; scan(); }, 150);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(scan, 1200);

    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(reflow, 120);
    });
    window.addEventListener('orientationchange', function () { setTimeout(reflow, 350); });
  }

  /* 供调试 / 复位用 */
  window.__WB_FLOAT_RESET__ = function () {
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    store = {};
    var arr = document.querySelectorAll('.wb-float');
    for (var i = 0; i < arr.length; i++) {
      var el = arr[i];
      for (var j = 0; j < TARGETS.length; j++) {
        if (TARGETS[j].key === el.dataset.wbFloat && TARGETS[j].applyDefault) TARGETS[j].applyDefault();
      }
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
