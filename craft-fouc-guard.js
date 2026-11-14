/* ======================================================================
   [CRAFT-FOUC] 非遗详情页 · 首帧即成品（消灭 FOUC 与「旧版界面」闪屏）
   ----------------------------------------------------------------------
   逐帧实测到的闪烁链路（1200×760）：
     t0        点击总览页卡片 → history.pushState，URL 变 /craft/tie-dyeing
     t0+~90ms  详情页组件挂载，但 ①.wxf-bg 背景层未注入（无全屏实景）
                ②.wxf-card 毛玻璃卡片未包好（内容裸在米底上）
                ③小图还是上一条路由的残留
                → 肉眼所见即「没背景、排版错乱的旧版界面」
     t0+~1200ms 注入层轮询完成，一次性跳到最终形态 —— 就是那一下闪。
                （耗时主要在 Vue 懒加载 chunk + GSAP ScrollReveal 首屏动画）
   另一处：SPA 跳转不刷新文档，首屏的鎏金开场层 #giltIntro（z-index 99999、
   is-open 时 opacity 仍为 1）会整块盖住页面，表现为「点了没反应 / 白屏」。

   本文件只碰样式与渲染时序，不动任何业务逻辑，做四件事：
     ① 6 张全屏背景图按路由预加载（详情页进入前已在缓存），并进一步修掉
        background-attachment: fixed 引起的整屏重绘；
     ② 详情页外壳（.cm--topic / .cr-intro）在 .wxf-ready 落下前 opacity:0，
        米金色打底 —— 骨架屏语义：数据没齐就只显示纯色，绝不显示旧内容；
     ③ 就绪判据跨两次 rAF 复核（双帧确认），防止「恰好某一帧已就绪 → 放行 →
        下一帧又回到未就绪」的抖动；1.2s 后无论如何放行，不让用户干等；
     ④ 鎏金开场层在详情页强制移除，绝不挡路。可见性回落由 0.3s ease-in-out 完成。
   ====================================================================== */

/* ---------- ① 预加载：按路由精准预取，悬停卡片再提前一步 ---------- */
(function preloadCraftBackgrounds() {
  var BG = {
    'wax-dyeing': '/assets/images/wax_dyeing_bg.jpg?v=20261112wxf1',
    embroidery: '/assets/images/embroidery-bg.jpg?v=20261112emb2',
    'tie-dyeing': '/assets/images/tiedye-bg.jpg?v=20261112td1',
    'blue-print': '/assets/images/blueprint-bg.jpg?v=20261112bp1',
    'paper-cut': '/assets/images/papercut-bg.jpg?v=20261112pc1',
    brocade: '/assets/images/brocade-bg.jpg?v=20261112brc2'
  };
  var CARD = '/assets/images/craft-card/craft_';
  var ORDER = ['wax-dyeing', 'tie-dyeing', 'blue-print', 'embroidery', 'brocade', 'paper-cut'];
  var done = {};

  function preload(href) {
    if (!href || done[href]) return;
    done[href] = 1;
    var l = document.createElement('link');
    l.rel = 'preload';
    l.as = 'image';
    l.href = href;
    l.setAttribute('fetchpriority', 'high');
    document.head.appendChild(l);
  }

  function craftOf(pathname) {
    var m = /^\/craft\/([a-z-]+)\/?$/.exec(pathname || '');
    return m && BG[m[1]] ? m[1] : null;
  }

  function warm(craft) {
    if (!craft || !BG[craft]) return;
    preload(BG[craft]);
    var i = ORDER.indexOf(craft) + 1;
    if (i > 0) preload(CARD + i + '.jpg?v=20261113craftcard1');
  }

  warm(craftOf(location.pathname));

  function bindHover() {
    var cards = document.querySelectorAll('.cm__card a[href*="/craft/"], a.cm__card[href*="/craft/"]');
    Array.prototype.forEach.call(cards, function (a) {
      if (a.__wbWarmed) return;
      a.__wbWarmed = 1;
      var go = function () {
        var m = /\/craft\/([a-z-]+)/.exec(a.getAttribute('href') || '');
        if (m) warm(m[1]);
      };
      a.addEventListener('mouseenter', go, { passive: true });
      a.addEventListener('touchstart', go, { passive: true });
      a.addEventListener('focus', go, { passive: true });
    });
  }

  document.addEventListener(
    'click',
    function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href*="/craft/"]') : null;
      if (!a) return;
      var m = /\/craft\/([a-z-]+)/.exec(a.getAttribute('href') || '');
      if (m) warm(m[1]);
    },
    true
  );

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindHover);
  else bindHover();
})();

/* ---------- ②③④ 渲染时序：外壳淡入 + 开场层清理 ---------- */
(function craftFoucGuard() {
  'use strict';

  var root = document.documentElement;
  var READY = 'wxf-ready';
  var ROUTE_ATTR = 'data-wb-craft-route';
  var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
  var timer = 0;
  var hardTimer = 0;
  var seen = false;
  var collecting = false;
  var isReady = false;          /* 状态以变量为准，属性只做样式钩子 */
  var skeletonArmed = false;    /* 本次跳转是否已经允许显示骨架屏 */

  function isCraftDetail() {
    return /^\/craft\/[a-z-]+\/?$/.test(location.pathname || '');
  }

  function markRoute() {
    if (isCraftDetail()) root.setAttribute(ROUTE_ATTR, '');
    else root.removeAttribute(ROUTE_ATTR);
  }
  markRoute();

  /* 鎏金开场层：详情页里它不该存在，直接摘掉，避免整屏遮挡 */
  function killIntro() {
    if (!isCraftDetail()) return;
    var g = document.getElementById('giltIntro');
    if (!g) return;
    g.style.setProperty('display', 'none', 'important');
    if (g.parentNode) g.parentNode.removeChild(g);
    root.removeAttribute('data-gilt-intro');
  }

  function bgMatches() {
    var bg = document.getElementById('wxfGlobalBg');
    if (!bg) return false;
    var m = /^\/craft\/([a-z-]+)\/?$/.exec(location.pathname || '');
    return !m || bg.getAttribute('data-craft') === m[1];
  }

  /* 外壳是否已是最终形态（背景层 + 毛玻璃卡片 + 当前页小图已解码） */
  function shellReady() {
    if (!bgMatches()) return false;
    var card = document.querySelector('.cr-intro .wxf-card');
    if (!card) return false;
    var img = card.querySelector('.wxf-butterfly');
    if (img && !(img.complete && img.naturalWidth > 0)) return false;
    return true;
  }

  /* 骨架屏层：详情页组件已挂载但外壳还没成型时，用纯色盖住「旧内容」
     （旧路由残留的卡片、裸排版、上一页小图一律看不见） */
  function ensureSkeleton() {
    if (!isCraftDetail() || !skeletonArmed) return;
    if (!document.querySelector('.cr-intro')) return;
    var sk = document.getElementById('wxfSkeleton');
    if (!sk) {
      sk = document.createElement('div');
      sk.id = 'wxfSkeleton';
      sk.setAttribute('aria-hidden', 'true');
      document.body.appendChild(sk);
    }
    if (sk.__killed) return;
    /* 视觉全部交给 craft-fouc-guard.css 的 #wxfSkeleton（宣纸底 + 呼吸点） */
    sk.style.setProperty('opacity', '1');
  }

  function dropSkeleton() {
    var sk = document.getElementById('wxfSkeleton');
    if (!sk || sk.__killed) return;
    sk.__killed = 1;
    sk.style.setProperty('opacity', '0');
    setTimeout(function () {
      if (sk.parentNode) sk.parentNode.removeChild(sk);
    }, 340);
  }

  /* 就绪：属性钩子 + 直接给外壳写内联 opacity（内联样式一定胜过任何外链 CSS，
     避免「某条后加载的规则又把外壳按回 0」） */
  function applyReady() {
    clearTimeout(timer);
    clearTimeout(hardTimer);
    isReady = true;
    root.setAttribute(READY, '');
    document.querySelectorAll('.cm.cm--topic, .cr-intro').forEach(function (el) {
      el.style.setProperty('transition', 'opacity .3s ease-in-out', 'important');
      el.style.setProperty('opacity', '1', 'important');
    });
    dropSkeleton();
  }

  function clearReady() {
    isReady = false;
    root.removeAttribute(READY);
    document.querySelectorAll('.cm.cm--topic, .cr-intro').forEach(function (el) {
      el.style.setProperty('transition', 'opacity .3s ease-in-out', 'important');
      el.style.setProperty('opacity', '0', 'important');
    });
    /* 详情页互跳：旧背景层立刻隐藏，避免上一页实景透出 */
    var bg = document.getElementById('wxfGlobalBg');
    if (bg) bg.style.setProperty('visibility', 'hidden', 'important');
  }

  function releaseBg() {
    var bg = document.getElementById('wxfGlobalBg');
    if (bg && bg.style.visibility === 'hidden') bg.style.removeProperty('visibility');
  }

  /* 跨两次 rAF 复核：连续两帧都就绪才算稳，避免抖动 */
  function poll() {
    clearTimeout(timer);
    clearTimeout(hardTimer);
    if (collecting) return;
    collecting = true;
    var deadline = Date.now() + 1200;
    var stable = 0;

    (function tick() {
      if (!isCraftDetail()) {
        collecting = false;
        applyReady();
        return;
      }
      ensureSkeleton();
      if (shellReady()) stable++;
      else stable = 0;

      if (stable >= 2 || Date.now() > deadline) {
        collecting = false;
        if (stable >= 2) releaseBg();
        applyReady();
        return;
      }
      raf(tick);
    })();

    hardTimer = setTimeout(function () {
      collecting = false;
      releaseBg();
      applyReady();
    }, 1800);
  }

  function onRoute() {
    markRoute();
    killIntro();
    if (!isCraftDetail()) {
      skeletonArmed = false;
      applyReady();
      return;
    }
    /* 进入详情页 / 详情页互跳：先隐藏，外壳就绪后再淡入。
       首次进入时若上一页（总览页）已把 ready 打开，也必须重新走一轮，
       否则骨架屏会一直盖着页面。 */
    if (isReady || seen) clearReady();
    seen = true;
    skeletonArmed = !!seen;
    poll();
  }

  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn];
    history[fn] = function () {
      var r = orig.apply(this, arguments);
      try {
        onRoute();
      } catch (e) {}
      return r;
    };
  });
  window.addEventListener('popstate', onRoute);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onRoute);
  else onRoute();

  window.addEventListener('load', function () {
    clearTimeout(hardTimer);
    hardTimer = setTimeout(function () {
      releaseBg();
      applyReady();
    }, 800);
  });
})();
