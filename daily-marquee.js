/* ============================================================
 * daily-marquee.js —— 「每日一纹」左侧纵向控制轴 + 右侧错落画册（高级联动）
 * ------------------------------------------------------------
 * 独立于 Vue 渲染树：读取已渲染的 .daily .card 数据，隐藏旧 coverflow，
 * 以 .daily 兄弟节点挂载新画廊（不在 Vue 子树内，patch 不会误删，可回滚）。
 *   · 左：#b33c3c 暗红纵轴 + N 个控制圆点（点击 → 右侧滚到对应图 + 文字同步）
 *   · 右：清晰锐利图片（禁白蒙层），统一高 280px、宽度错落、object-fit:cover、
 *        Flex gap:20px、margin-top 错落、圆角12 + 柔和阴影、底部黑渐变护文字。
 *   · 当前卡居中（按各卡 center 计算 translateX，兼容不等宽），放大 + 暗金描边。
 *   · 每 4 秒自动轮播向左；dot 与居中图完美同步；悬停整块暂停、移出恢复。
 * ============================================================ */
(function () {
  'use strict';

  var ROOT_ID = 'dmqMarqueeRoot';
  var ORIG_SEL = '.daily';
  var STYLE_ID = 'dmqMarqueeStyle';
  var CSS_HREF = '/assets/daily-marquee.css?v=20261110type1';

  var INTERVAL_MS = 4000;
  var ANIM_MS = 850;

  var data = [];
  var N = 0;
  var index = 0;            // 实际轨道位置 0..2N-1
  var timer = null;
  var pendingSnap = false;
  var centerOffset = 0;     // 居中所需的轨道左偏基准
  var centers = [];         // 各卡 center（相对轨道）X 坐标

  var root, track, textsEl, cards = [], dots = [];
  var curTextEl = null;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var l = document.createElement('link');
    l.id = STYLE_ID; l.rel = 'stylesheet'; l.href = CSS_HREF;
    document.head.appendChild(l);
  }

  function readData() {
    var src = [].slice.call(document.querySelectorAll(ORIG_SEL + ' .card'));
    var out = [];
    src.forEach(function (c) {
      var img = c.querySelector('img');
      var t = function (sel) { var e = c.querySelector(sel); return e ? e.textContent.trim() : ''; };
      out.push({
        img: img ? (img.getAttribute('src') || '') : '',
        name: t('.card-name'),
        cat: t('.card-cat'),
        dyn: t('.card-dynasty'),
        mean: t('.card-meaning')
      });
    });
    return out;
  }

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  /* 不等宽 + 错落：按 index%5 循环（宽度/上偏移），营造画廊节奏
     OFFSEETS 取轻量值，避免与 1.3× 聚光灯抢视觉 */
  var WIDTHS  = [300, 232, 272, 250, 292];
  var OFFSETS = [0, 26, -8, 16, 8];   // margin-top 错落（px）

  function buildCard(d, i) {
    var w = WIDTHS[i % WIDTHS.length];
    var card = el('a', 'dlg-card');
    card.href = '/library';
    card.style.width = w + 'px';
    card.style.marginTop = OFFSETS[i % OFFSETS.length] + 'px';
    card.setAttribute('aria-label', d.name || '纹样');
    if (d.img) {
      var im = el('img');
      im.src = d.img; im.alt = d.name; im.loading = 'lazy';
      card.appendChild(im);
    }
    card.appendChild(el('div', 'dlg-card__grad'));
    var cap = el('div', 'dlg-card__cap');
    cap.appendChild(el('h4', null, d.name));
    if (d.dyn) cap.appendChild(el('span', null, d.dyn));
    card.appendChild(cap);
    return card;
  }

  function buildText(d, dataIdx) {
    var wrap = el('div', 'dlg-text');
    wrap.appendChild(el('div', 'dlg-text__num',
      ('0' + (dataIdx + 1)).slice(-2) + ' / ' + ('0' + N).slice(-2)));
    if (d.cat) wrap.appendChild(el('span', 'dlg-text__cat', d.cat));
    wrap.appendChild(el('h3', 'dlg-text__title', d.name));
    if (d.dyn) wrap.appendChild(el('p', 'dlg-text__dyn', d.dyn));
    if (d.mean) wrap.appendChild(el('p', 'dlg-text__desc', d.mean));
    var cta = el('a', 'dlg-text__cta', '查看纹样详情');
    cta.href = '/library';
    wrap.appendChild(cta);
    return wrap;
  }

  function measure() {
    if (!cards.length) return;
    var outer = root.querySelector('.dlg-outer');
    centerOffset = (outer ? outer.clientWidth : 0) / 2;
    centers = cards.map(function (c) {
      return c.offsetLeft + c.offsetWidth / 2;   // 各卡中心（相对轨道）
    });
  }

  function applyTransform(i, animate) {
    if (!animate) track.style.transition = 'none';
    var x = centerOffset - (centers[i] || 0);
    track.style.transform = 'translate3d(' + x + 'px,0,0)';
    if (!animate) { void track.offsetWidth; track.style.transition = ''; }
  }

  function setActiveCard(i) {
    for (var k = 0; k < cards.length; k++)
      cards[k].classList.toggle('is-active', k === i);
  }
  function setActiveDot(i) {
    var d = i % N;
    for (var k = 0; k < dots.length; k++)
      dots[k].classList.toggle('is-active', k === d);
  }

  function setText(dataIdx) {
    var d = data[dataIdx % N];
    if (!d) return;
    var newEl = buildText(d, dataIdx % N);
    newEl.classList.add('dlg-text--enter');
    textsEl.appendChild(newEl);
    void newEl.offsetWidth;
    newEl.classList.remove('dlg-text--enter');
    if (curTextEl) {
      var old = curTextEl;
      old.classList.add('dlg-text--leave');
      setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); }, 650);
    }
    curTextEl = newEl;
  }

  /* 跳到指定索引：图片居中 + 高亮卡 + 高亮圆点 + 文字切换 */
  function goTo(i, animate) {
    setActiveCard(i);
    setActiveDot(i);
    setText(i);
    applyTransform(i, animate);
  }

  function step_() {
    index++;
    if (index >= N) {
      goTo(index, true);                 // 动画到重复卡（视觉同 0）
      pendingSnap = true;
      setTimeout(snap, ANIM_MS + 40);     // 到位后无缝 snap 回 0
    } else {
      goTo(index, true);
    }
  }

  function snap() {
    if (!pendingSnap) return;
    pendingSnap = false;
    index = 0;
    setActiveCard(0);
    setActiveDot(0);
    applyTransform(0, false);
  }

  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(step_, INTERVAL_MS);
  }
  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function build() {
    var orig = document.querySelector(ORIG_SEL);
    if (!orig) return false;

    data = readData();
    if (!data.length) return false;
    N = data.length;

    orig.style.display = 'none';
    if (document.getElementById(ROOT_ID)) return true;

    root = el('section', 'dlg');
    root.id = ROOT_ID;

    /* 标题 */
    var head = el('div', 'dlg-head');
    var title = el('h2', 'dlg-head__title', '每日一纹');
    title.appendChild(el('small', null, '精选传统纹样 · 左轴右册联动'));
    var more = el('a', 'dlg-head__more', '浏览全部纹样 →');
    more.href = '/library';
    head.appendChild(title); head.appendChild(more);
    root.appendChild(head);

    /* 主体两栏 */
    var body = el('div', 'dlg-body');

    /* 左：纵轴 + 圆点 + 切换文字 */
    var left = el('div', 'dlg-left');
    var rail = el('div', 'dlg-rail');
    for (var i = 0; i < N; i++) {
      (function (di) {
        var dot = el('button', 'dlg-dot');
        dot.type = 'button';
        dot.setAttribute('aria-label', '切换到第 ' + (di + 1) + ' 个纹样');
        dot.addEventListener('click', function () {
          index = di;
          goTo(di, true);
          startTimer();           // 点击后重置 4 秒计时
        });
        dots.push(dot);
        rail.appendChild(dot);
      })(i);
    }
    left.appendChild(rail);
    textsEl = el('div', 'dlg-texts');
    left.appendChild(textsEl);
    body.appendChild(left);

    /* 右：错落画册（数据复制一份 → 2N，用于无缝 snap） */
    var right = el('div', 'dlg-right');
    var outer = el('div', 'dlg-outer');
    track = el('div', 'dlg-track');
    var seq = data.concat(data);
    seq.forEach(function (d, i) { track.appendChild(buildCard(d, i)); });
    outer.appendChild(track);
    right.appendChild(outer);
    body.appendChild(right);

    root.appendChild(body);
    if (orig.parentNode) orig.parentNode.insertBefore(root, orig);

    cards = [].slice.call(track.children);

    /* 初始态 */
    measure();
    index = 0;
    goTo(0, false);

    /* 悬停整块暂停；移出恢复 */
    root.addEventListener('mouseenter', stopTimer);
    root.addEventListener('mouseleave', startTimer);
    window.addEventListener('resize', function () {
      measure(); applyTransform(index, false);
    });

    startTimer();
    return true;
  }

  function tick() {
    try {
      injectStyle();
      try { if (window.__wbDailyCoverFreeze) window.__wbDailyCoverFreeze(true); } catch (e) {}
      if (!document.getElementById(ROOT_ID)) build();
      else {
        var o = document.querySelector(ORIG_SEL);
        if (o && o.style.display !== 'none') o.style.display = 'none';
      }
    } catch (e) {}
  }

  function boot() {
    tick();
    setInterval(tick, 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
