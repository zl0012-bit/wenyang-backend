/* ============================================================================
 * [CRAFT-VIDEO-LINK] 非遗技艺馆 · 传承人纪实 · 外链引导卡片（运行期接管）
 *
 *   版权合规：全程不使用 iframe 内嵌播放，卡片是一个真正的 <a target="_blank">，
 *   点击即在【新标签页】打开 B 站视频完整页。旧组件 craft_video_modal.js
 *   （含 CraftVideoModal.open 内嵌播放器）已删除。
 *
 *   两种接入方式：
 *   A) 苗族蜡染 /craft/wax-dyeing —— Vue bundle 仍会渲染旧
 *        <button class="cr-inherit__video-stage" onClick="CraftVideoModal.open(...)">
 *      本模块在其挂载后，把该 <button> 在「原位」替换为国风外链卡片。
 *   B) 白族扎染 / 蓝印花布 / 四大名绣 / 中国织锦 / 民间剪纸 —— 数据里 video 字段为空，
 *      Vue 不渲染视频区。本模块在 <section class="cr-inherit"> 的传承人栅格之后，
 *      按 CARD_CONFIG[当前路由 slug] 补一个与蜡染完全同构的
 *      .cr-inherit__video-wrap（PatternBorder 金角 + 外链卡片）。
 *
 *   所有卡片共用同一套 .cvm-card 样式与同一份 buildCard()，保证质感绝对一致；
 *   新增技艺只需在 CARD_CONFIG 里加一项（autoInject: true 表示需运行时补节点）。
 *   SPA 复用详情页组件时由 cleanStale() 依 data-cvm-injected 清掉串页残留。
 *   仍挂一个无害的 window.CraftVideoModal 桩，避免任何残留调用抛错。
 * ========================================================================== */
(function () {
  'use strict';

  /* ── 卡片配置：新增技艺只需在这里加一项 ─────────────────────────────── */
  var CARD_CONFIG = {
    'wax-dyeing': {
      href: 'https://www.bilibili.com/video/BV1Bp4y1i7H3',
      cover: '/assets/images/wax_dyeing_cover.jpg',
      title: '观看传承人纪实',
      sub: '前往 Bilibili 官方观看',
      hint: '视频来源：bilibili',
      alt: '苗族蜡染 · 传承人纪实'
    },
    'tie-dyeing': {
      href: 'https://b23.tv/d7djlqN',
      cover: '/assets/images/tie_dyeing_cover.jpg',
      title: '观看白族扎染纪实',
      sub: '前往 Bilibili 官方观看',
      hint: '视频来源：bilibili · 传承人纪实',
      alt: '白族扎染 · 传承人纪实',
      autoInject: true                     /* 数据无 video，由本模块补视频区 */
    },
    'blue-print': {
      href: 'https://b23.tv/xXuhSHq',
      cover: '/assets/images/blue_print_cover.jpg',
      title: '观看蓝印花布纪实',
      sub: '前往 Bilibili 官方观看',
      hint: '视频来源：bilibili · 传承人纪实',
      alt: '蓝印花布 · 传承人纪实',
      autoInject: true
    },
    'embroidery': {
      href: 'https://b23.tv/AWsPvJc',
      cover: '/assets/images/embroidery_cover.jpg',
      title: '观看四大名绣纪实',
      sub: '前往 Bilibili 官方观看',
      hint: '视频来源：bilibili · 传承人纪实',
      alt: '四大名绣 · 传承人纪实',
      autoInject: true
    },
    'brocade': {
      href: 'https://b23.tv/6ruCcbw',
      cover: '/assets/images/brocade_cover.jpg',
      title: '观看中国织锦纪实',
      sub: '前往 Bilibili 官方观看',
      hint: '视频来源：bilibili · 传承人纪实',
      alt: '中国织锦 · 传承人纪实',
      autoInject: true
    },
    'paper-cut': {
      href: 'https://b23.tv/rlLrBOd',
      cover: '/assets/images/papercut_cover.jpg',
      title: '观看民间剪纸纪实',
      sub: '前往 Bilibili 官方观看',
      hint: '视频来源：bilibili · 传承人纪实',
      alt: '民间剪纸 · 传承人纪实',
      autoInject: true
    }
  };

  var DEFAULT_CFG = CARD_CONFIG['wax-dyeing'];

  /* 无害桩：防止 Vue bundle 残留的 open()/close() 调用抛错（已不再弹窗） */
  window.CraftVideoModal = {
    open: function () {},
    close: function () {},
    isOpen: function () { return false; },
    state: function () { return { open: false, iframes: 0, overlays: 0 }; }
  };

  function mk(tag, cls) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
  }

  /* ── 播放图标（金色圆环 + 实心三角），两张卡片共用 ───────────────────── */
  function buildPlayIcon() {
    var wrap = mk('span', 'cvm-card__play');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML =
      '<svg viewBox="0 0 24 24" focusable="false">'
      + '<circle cx="12" cy="12" r="10.4" fill="none" stroke="currentColor" stroke-width="1.15" stroke-opacity=".72"/>'
      + '<path d="M9.7 7.6v8.8l7.6-4.4z" fill="currentColor"/>'
      + '</svg>';
    return wrap;
  }

  /* ── 构建外链卡片 <a> ──────────────────────────────────────────────── */
  function buildCard(cfg) {
    cfg = cfg || DEFAULT_CFG;

    var a = mk('a', 'cr-inherit__video-stage cvm-card');
    a.setAttribute('href', cfg.href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    a.setAttribute('aria-label', cfg.title + ' · 前往哔哩哔哩官方观看（新标签页打开）');
    a.style.backgroundImage = 'url("' + cfg.cover + '")';
    /* Vue bundle 的 `.cr-inherit__video-stage{background:var(--c-indigo)}` 简写会把
       background-size/position/repeat 重置为 auto/0% 0%/repeat，导致封面按 1:1
       平铺而不是铺满。内联声明优先级最高，这里显式钉死三个子属性。 */
    a.style.backgroundSize = 'cover';
    a.style.backgroundPosition = 'center center';
    a.style.backgroundRepeat = 'no-repeat';

    a.appendChild(mk('span', 'cvm-card__scrim'));

    var inner = mk('span', 'cvm-card__inner');
    inner.appendChild(buildPlayIcon());

    var title = mk('span', 'cvm-card__title');
    title.textContent = cfg.title;
    inner.appendChild(title);

    var sub = mk('span', 'cvm-card__sub');
    sub.textContent = cfg.sub + ' ↗';
    inner.appendChild(sub);
    a.appendChild(inner);

    var hint = mk('span', 'cvm-card__hint');
    hint.appendChild(mk('i', 'cvm-card__dot'));
    hint.appendChild(document.createTextNode(cfg.hint));
    a.appendChild(hint);

    a.dataset.cvm = 'link';
    return a;
  }

  /* ── PatternBorder 外壳（金角 + 暗金细边），复刻 Vue 组件的 DOM ──────── */
  function buildBorderShell() {
    var box = mk('div', 'pattern-border all cr-inherit__video');
    /* Vue scoped 样式靠属性选择器命中，运行期注入必须补上这两个 scope id，
       否则 .pattern-border / .corner 的金角定位规则全部失效 */
    box.setAttribute('data-v-a6dbb40c', '');       // PatternBorder 组件
    box.setAttribute('data-v-42c16760', '');       // 详情页
    box.style.borderColor = 'rgb(200, 155, 60)';
    box.style.borderWidth = '2px';
    box.style.setProperty('--corner', '22px');

    var path = 'M2 22V8a6 6 0 0 1 6-6h14M2 14h6a4 4 0 0 1 4 4v6M8 8h4';
    ['tl', 'tr', 'bl', 'br'].forEach(function (k) {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'corner corner--' + k);
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('data-v-a6dbb40c', '');
      svg.style.color = 'rgb(200, 155, 60)';
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', path);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.6');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
      box.appendChild(svg);
    });

    return box;
  }

  /* ── A) 苗族蜡染：把旧 <button> 原位替换为外链 <a> ───────────────────── */
  function upgrade(btn) {
    if (!btn || btn.dataset.cvm === 'link') return;
    if (btn.tagName !== 'BUTTON') return;          // 已经是 <a> 则跳过
    var card = buildCard(DEFAULT_CFG);
    if (btn.parentNode) btn.parentNode.replaceChild(card, btn);
  }

  function upgradeAll() {
    var btns = document.querySelectorAll('button.cr-inherit__video-stage');
    for (var i = 0; i < btns.length; i++) upgrade(btns[i]);
  }

  /* ── B) 扎染 / 蓝印花布 / 四大名绣 / 中国织锦 / 民间剪纸：补同构视频区 ──
     Vue 数据里这些技艺的 video 字段为空，不会渲染视频区，故由本模块补节点。 */
  function currentSlug() {
    var m = /^\/craft\/([a-z-]+)\/?$/.exec(location.pathname);
    return m ? m[1] : null;
  }

  /* SPA 路由切换时 Vue 会复用同一个详情页组件，注入的节点不在它的 vdom 里，
     不会被 diff 删掉。所以每次 apply 先清掉「跟当前路由对不上」的残留节点，
     否则从扎染切到别的技艺，旧卡片会一直挂着。 */
  function cleanStale() {
    var slug = currentSlug();
    var list = document.querySelectorAll('.cr-inherit__video-wrap[data-cvm-injected]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-cvm-injected') !== slug) {
        list[i].parentNode.removeChild(list[i]);
      }
    }
  }

  function injectInheritVideo() {
    var slug = currentSlug();
    if (!slug) return;
    var cfg = CARD_CONFIG[slug];
    if (!cfg || !cfg.autoInject) return;            // 只有配置里显式声明的才注入

    var section = document.querySelector('section.cr-inherit');
    if (!section) return;
    if (section.querySelector('.cr-inherit__video-wrap')) return;   // 已注入

    var grid = section.querySelector('.cr-inherit__grid');
    var wrap = mk('div', 'cr-inherit__video-wrap');
    wrap.setAttribute('data-cvm-injected', slug);
    var box = buildBorderShell();
    box.appendChild(buildCard(cfg));
    wrap.appendChild(box);

    if (grid && grid.nextSibling) {
      section.insertBefore(wrap, grid.nextSibling);
    } else {
      section.appendChild(wrap);
    }
  }

  function apply() {
    upgradeAll();
    cleanStale();
    injectInheritVideo();
  }

  /* 监听 Vue 挂载 / 重渲染 / SPA 切换 */
  if (document.body) {
    var obs = new MutationObserver(function () { apply(); });
    obs.observe(document.body, { childList: true, subtree: true });
  }
  apply();

  /* 兜底轮询：本脚本可能先于 Vue 挂载执行 */
  var tries = 0;
  var timer = setInterval(function () {
    apply();
    if (++tries > 50) clearInterval(timer);
  }, 200);

  /* SPA 路由切换后重新扫描 */
  window.addEventListener('popstate', function () { setTimeout(apply, 300); });
  setInterval(apply, 1500);
})();
