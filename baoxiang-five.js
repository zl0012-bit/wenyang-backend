/* ============================================================================
 * [BAOXIANG-FIVE] 宝相花结构拆解 · 经络引线 + 旋转绽放动画 · 运行时注入层 (bx12)
 *
 *   bx12 新增「中心自转 + 四周绽放」联动：
 *     · 为中心全景图打上独立类 .center-panorama（JS 保证存在）
 *     · 拆解：中心图顺时针自转 360°，1.2s 与花瓣散开同步
 *     · 重组：中心图反向平滑转回 0°，1.2s 与花瓣收回同步
 *     · 旋转只作用于内部 .bx-circle 载体，不覆盖 figure 的居中 translate
 *
 *   Vue 侧状态机只有 composed | exploded，唯一动作是给 .baoxiang-layers
 *   加/删 .is-exploded。因此本层只做"补齐 DOM + 编排动画时序"，不复制状态：
 *     · 补齐第 5 个局部图（外层花瓣）与第 5 个标签
 *     · 新建 .bx-leads 经络层：5 条引线 + 5 个穴位针点
 *     · 拆解：加 .is-exploded 即触发 @keyframes bxPetalOut（旋转 180° 飞出）
 *     · 重组：先挂 .is-collapsing 播放 bxPetalIn（逆向收回），
 *             动画结束后移除 → 再移除 .is-exploded 回到干净的合拢态
 *     · MutationObserver 镜像 class 到 data-bx-phase
 *   兜底：组件卸载 / 路由切走时定时器与 observer 全部自清，
 *         不会留下半截 class（"收回后错位"的一类根因）。
 * ========================================================================== */
(function () {
  'use strict';

  var VER = '20261112bx12a';
  var CSS_HREF = '/assets/baoxiang-five.css?v=' + VER;
  var SCOPE = '.baoxiang-layers';

  /* 动画时长：花瓣散开 / 中心自转统一步调 1.2s（见 CSS --bx-dur）。
     IN_MS 为「重组」逆向收回的时长，与中心反转速一致，保证一气呵成。 */
  var OUT_MS = 1200;
  var IN_MS = 1200;

  /* 第 5 个局部：600% / 63% 44% —— 红白色莲花瓣（红瓣占 52%，白边 + 金线） */
  var LAYER_HTML = '<figure class="bx-layer bx--fifth" data-key="border">'
    + '<div class="bx-circle"><div class="bx-bg bx-bg--fifth"></div></div>'
    + '</figure>';

  var TAG_HTML = '<div class="bx-tag bx-tag--fifth">'
    + '<b>外层花瓣</b><span>顶莲勾金</span><i class="bx-lead"></i></div>';

  /* 经络层：每条引线的起点是圆内特征花色的真实质心（穴位），终点是标签中心 */
  var KEYS = ['top', 'right', 'fifth', 'bottom', 'left'];
  var LEADS_HTML = '<div class="bx-leads">'
    + KEYS.map(function (k) {
        return '<i class="bx-lead bx-lead--' + k + '"></i>'
          + '<i class="bx-pin bx-pin--' + k + '"></i>';
      }).join('')
    + '</div>';

  var HINT = ' 点「拆解纹样」旋转绽放开；点「重组纹样」逆向收回中心。';

  var observed = null;
  var observer = null;
  var lastExploded = false;
  var timers = [];

  function q(s, r) { return (r || document).querySelector(s); }

  function clearTimers() {
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
    timers = [];
  }

  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

  function injectStyle() {
    if (q('link[href*="baoxiang-five.css"]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = CSS_HREF;
    document.head.appendChild(l);
  }

  /* 重新触发一次 CSS 动画（同一元素重复触发必须强制重排，否则不重播） */
  function replay(root) {
    var petals = root.querySelectorAll(
      '.bx--top,.bx--left,.bx--right,.bx--bottom,.bx--fifth'
    );
    for (var i = 0; i < petals.length; i++) {
      void petals[i].offsetWidth;
    }
  }

  function syncPhase(root) {
    var exploded = root.classList.contains('is-exploded');

    /* 接管期：Vue 刚把 .is-exploded 摘掉，但收回动画还在播 —— 立刻补回去，
       否则花瓣的散开终值消失、bxPetalIn 会被打断，直接"啪"地跳回中心 */
    if (!exploded && root.dataset.bxHolder === '1') {
      root.classList.add('is-exploded');
      root.setAttribute('data-bx-phase', 'exploded');
      return;
    }

    root.setAttribute('data-bx-phase', exploded ? 'exploded' : 'composed');
    /* 首次进入 / 状态无变化：只镜像，不播动画（避免加载即闪一下） */
    if (exploded === lastExploded) return;
    lastExploded = exploded;

    clearTimers();

    if (exploded) {
      /* 拆解：.is-exploded 已由 Vue 加上，bxPetalOut 由该 class 上的 animation 触发 */
      root.classList.remove('is-collapsing');
      replay(root);
      return;
    }

    /* 外部静默移除 .is-exploded：直接落位，不补动画（点击路径已被拦截接管） */
    root.classList.remove('is-collapsing');
  }

  /* ── 重组拦截 ─────────────────────────────────────────────────────────
   * Vue 点「重组纹样」时会立刻把 .is-exploded 摘掉；如果等 MutationObserver
   * 事后补救，花瓣已经瞬间跳回中心。所以在按钮的捕获阶段先接管：
   *   1. 挂 .is-collapsing → 花瓣仍由 .is-exploded 保持散开终值，
   *      同时 bxPetalIn 从散开位置起播（逆向 180° 收回）
   *   2. 淡出结束 → 移除 .is-collapsing 与 .is-exploded，回到干净合拢态
   * 若动画期间用户又点「拆解」，onExploded 会清掉 is-collapsing 直接重播飞出。
   * ─────────────────────────────────────────────────────────────────── */
  function interceptCollapse(root) {
    if (root.dataset.bxCollapseHook === '1') return;
    root.dataset.bxCollapseHook = '1';

    document.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!btn) return;
      var label = (btn.textContent || '').trim();
      /* 只在"当前已拆解 + 点的是重组"时接管 */
      if (!/重组/.test(label)) return;
      if (!root.classList.contains('is-exploded')) return;
      if (!root.isConnected) return;

      clearTimers();
      /* Vue 会在同一次点击里摘掉 .is-exploded，花瓣散开终值随之消失。
         用 holder 标记接管期：MutationObserver 在本轮内把 .is-exploded 补回去，
         保证 bxPetalIn 有"从散开坐标起播"的基准，动画结束再统一撤掉。 */
      root.dataset.bxHolder = '1';
      root.classList.add('is-collapsing');
      replay(root);

      later(function () {
        if (observed !== root) return;
        delete root.dataset.bxHolder;
        root.classList.remove('is-collapsing');
        root.classList.remove('is-exploded');
        root.setAttribute('data-bx-phase', 'composed');
        lastExploded = false;
      }, IN_MS + 40);
    }, true);
  }

  function watch(root) {
    if (observed === root && observer) return;
    if (observer) { observer.disconnect(); observer = null; }
    clearTimers();
    observed = root;
    lastExploded = root.classList.contains('is-exploded');
    root.setAttribute('data-bx-phase', lastExploded ? 'exploded' : 'composed');
    if (typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver(function () { syncPhase(root); });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
  }

  function ensure(root) {
    var tags = q('.bx-tags', root);
    if (!tags) return;

    /* 中心全景图：打独立类 .center-panorama（旋转绑定的锚点） */
    var center = q('.bx--center', root);
    if (center && !center.classList.contains('center-panorama')) {
      center.classList.add('center-panorama');
    }

    if (!q('.bx--fifth', root)) {
      tags.insertAdjacentHTML('beforebegin', LAYER_HTML);
    }
    if (!q('.bx-tag--fifth', tags)) {
      tags.insertAdjacentHTML('beforeend', TAG_HTML);
    }
    /* 经络层插在 .bx-tags 之前：z-index 8，压住圆片、藏在标签之下 */
    if (!q('.bx-leads', root)) {
      tags.insertAdjacentHTML('beforebegin', LEADS_HTML);
    }

    watch(root);
    interceptCollapse(root);

    var hint = q('.sa__hint');
    if (hint && hint.textContent.indexOf('旋转') < 0) hint.textContent = HINT;
  }

  function tick() {
    var root = q(SCOPE);
    if (!root) {
      if (observer) { observer.disconnect(); observer = null; }
      clearTimers();
      observed = null;
      lastExploded = false;
      return;
    }
    ensure(root);
  }

  injectStyle();
  tick();
  setInterval(tick, 300);
  window.addEventListener('popstate', tick);
})();
