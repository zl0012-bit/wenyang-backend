/* ==========================================================================
   鎏金首屏动态 · 控制脚本
   --------------------------------------------------------------------------
   仅负责三件事：
     1. 把 #giltHeroFx（金丝光轮层）移入首页 .hero 内，离开首页自动随之隐藏；
     2. 路由切换后重新挂载；
     3. 将首屏「画质」档接上：选「静态」时停止光轮动画（保留静帧）。
   不触碰 Vue 组件逻辑、页面内容与任何跳转。
   ========================================================================== */
(function () {
  'use strict';

  var fx = document.getElementById('giltHeroFx');
  if (!fx) return;

  var app = document.getElementById('app') || document.body;
  var reduce =
    !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduce) fx.setAttribute('data-still', '');

  /* ---------- 画质档 → 静帧 ---------- */
  function syncQuality(hero) {
    if (reduce) return;
    var btns = hero.querySelectorAll('.q-btn');
    var active = null;
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].classList.contains('active')) {
        active = btns[i];
        break;
      }
    }
    if (active && active.textContent.indexOf('静态') > -1) {
      fx.setAttribute('data-still', '');
    } else {
      fx.removeAttribute('data-still');
    }
  }

  /* ---------- 挂载 ---------- */
  var boundHero = null;
  var mo = null;

  function mount() {
    var hero = document.querySelector('.hero');
    if (!hero) return;

    if (fx.parentNode !== hero) {
      hero.insertBefore(fx, hero.firstChild);
    }

    if (boundHero !== hero) {
      if (mo) mo.disconnect();
      boundHero = hero;
      mo = new MutationObserver(function () {
        syncQuality(hero);
      });
      mo.observe(hero, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    }

    syncQuality(hero);
  }

  /* 用 rAF 合并高频 DOM 变更，避免无谓计算 */
  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(function () {
      pending = false;
      mount();
    });
  }

  mount();

  /* 首屏在 SPA 路由切换时会重建，监听 #app 重挂 */
  new MutationObserver(schedule).observe(app, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
})();
