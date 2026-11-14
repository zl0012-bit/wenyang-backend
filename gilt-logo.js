/* ===== 导航栏站标替换：把「方框 + 纹字」换成鎏金回纹宝徽 =====
   不触碰 Vue 组件与业务逻辑：仅替换 .brand-mark 的内部内容，
   MutationObserver 兜底，SPA 重渲染后依然生效。 */
(function () {
  var MARK =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="纹以载道">' +
    '<defs>' +
    '<linearGradient id="giltLgBg" x1="0.1" y1="0" x2="0.9" y2="1">' +
    '<stop offset="0" stop-color="#8A621C"/><stop offset="0.5" stop-color="#5E410F"/><stop offset="1" stop-color="#33220A"/>' +
    '</linearGradient>' +
    '<linearGradient id="giltLgGold" x1="0" y1="1" x2="0.6" y2="0">' +
    '<stop offset="0" stop-color="#C08F2C"/><stop offset="0.5" stop-color="#F0D68F"/><stop offset="1" stop-color="#FFF6DC"/>' +
    '</linearGradient>' +
    '<g id="giltLgCorner">' +
    '<path d="M 236 74 H 92 Q 86 74 86 80 V 236 H 172 V 140 H 132" fill="none" stroke="url(#giltLgGold)" stroke-width="15" stroke-linecap="square" opacity="0.95"/>' +
    '<path d="M 200 110 H 130 V 182 H 164" fill="none" stroke="url(#giltLgGold)" stroke-width="10" stroke-linecap="square" opacity="0.72"/>' +
    '</g>' +
    '</defs>' +
    '<rect width="512" height="512" rx="112" fill="url(#giltLgBg)"/>' +
    '<rect x="24" y="24" width="464" height="464" rx="94" fill="none" stroke="#E4C477" stroke-width="3" opacity="0.42"/>' +
    '<use href="#giltLgCorner"/>' +
    '<use href="#giltLgCorner" transform="rotate(90 256 256)"/>' +
    '<use href="#giltLgCorner" transform="rotate(180 256 256)"/>' +
    '<use href="#giltLgCorner" transform="rotate(270 256 256)"/>' +
    '<rect x="194" y="194" width="124" height="124" rx="16" fill="none" stroke="url(#giltLgGold)" stroke-width="13"/>' +
    '<rect x="194" y="194" width="124" height="124" rx="16" fill="none" stroke="url(#giltLgGold)" stroke-width="13" opacity="0.92" transform="rotate(45 256 256)"/>' +
    '<circle cx="256" cy="256" r="30" fill="#A6221F"/>' +
    '<circle cx="256" cy="256" r="30" fill="none" stroke="#F0D68F" stroke-width="3"/>' +
    '<circle cx="256" cy="256" r="8" fill="#F5DE9E"/>' +
    '</svg>';

  function putBadge(el, cls) {
    var wrap = document.createElement('div');
    wrap.className = cls;
    wrap.innerHTML = MARK;
    el.parentNode.insertBefore(wrap, el);
  }

  function paint() {
    var marks = document.querySelectorAll('.brand-mark');
    for (var i = 0; i < marks.length; i++) {
      var el = marks[i];
      if (el.dataset.giltLogo === '1') continue;
      el.dataset.giltLogo = '1';
      el.innerHTML = MARK;
    }
    var fabs = document.querySelectorAll('.ai-assistant__fab-face');
    for (var j = 0; j < fabs.length; j++) {
      var fb = fabs[j];
      if (fb.dataset.giltLogo === '1') continue;
      fb.dataset.giltLogo = '1';
      fb.innerHTML = MARK;
    }
    /* 首页：主标题正上方 */
    var titles = document.querySelectorAll('.hero__title');
    for (var k = 0; k < titles.length; k++) {
      var t = titles[k];
      if (t.dataset.giltLogo === '1') continue;
      t.dataset.giltLogo = '1';
      putBadge(t, 'gilt-emblem-hero');
    }
    /* 关于页：页头内部最前（页头为居中排版） */
    var heroes = document.querySelectorAll('.about-page__hero');
    for (var m = 0; m < heroes.length; m++) {
      var h = heroes[m];
      if (h.dataset.giltLogo === '1') continue;
      h.dataset.giltLogo = '1';
      var aw = document.createElement('div');
      aw.className = 'gilt-emblem-about';
      aw.innerHTML = MARK;
      h.insertBefore(aw, h.firstChild);
    }
  }

  function start() {
    paint();
    if (window.MutationObserver) {
      new MutationObserver(paint).observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
