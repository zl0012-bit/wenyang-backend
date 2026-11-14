/* ==========================================================================
   鎏金开场 · 控制脚本
   --------------------------------------------------------------------------
   仅负责：生成金屑、按时间轴推进、播放结束从 DOM 移除覆盖层。
   不触碰应用逻辑、内容与路由。
   ========================================================================== */
(function () {
  'use strict';

  var el = document.getElementById('giltIntro');
  if (!el) return;

  var root = document.documentElement;
  var reduce =
    !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 调试开关：?giltIntro=hold 时停住不自动播放，仅点击后收起（便于截图/走查） */
  var hold = /[?&]giltIntro=hold(&|$)/.test(window.location.search);

  /* 播放期间锁定滚动，避免在遮罩后误滚动页面 */
  root.setAttribute('data-gilt-intro', '');

  /* ---------- 金屑 ---------- */
  var dust = el.querySelector('.gilt-intro__dust');
  if (dust && !reduce) {
    for (var i = 0; i < 30; i++) {
      var s = document.createElement('i');
      var size = (2 + Math.random() * 2.2).toFixed(1);
      s.style.left = (Math.random() * 100).toFixed(2) + '%';
      s.style.width = size + 'px';
      s.style.height = size + 'px';
      s.style.setProperty('--dx', (Math.round(Math.random() * 90 - 45)) + 'px');
      s.style.animationDuration = (3.4 + Math.random() * 3.2).toFixed(2) + 's';
      s.style.animationDelay = (Math.random() * 2.4).toFixed(2) + 's';
      dust.appendChild(s);
    }
  }

  var finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    el.classList.add('is-done');
    root.removeAttribute('data-gilt-intro');
    window.setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 140);
  }

  function open() {
    if (finished) return;
    el.classList.add('is-open');
    window.setTimeout(finish, reduce ? 120 : 1080);
  }

  /* ---------- 时间轴 ---------- */
  el.setAttribute('data-phase', hold ? 'hold' : 'playing');
  if (!hold) {
    window.setTimeout(open, reduce ? 220 : 1950);
  }

  /* 点击 / 触摸可跳过 */
  el.addEventListener('click', open);
  el.addEventListener(
    'touchstart',
    function (e) {
      if (e.cancelable) e.preventDefault();
      open();
    },
    { passive: false }
  );
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') open();
  });

  /* 兜底：任何情况下不阻塞用户（hold 模式下不触发，便于人工走查） */
  if (!hold) {
    window.setTimeout(finish, reduce ? 900 : 4600);
  }
})();
