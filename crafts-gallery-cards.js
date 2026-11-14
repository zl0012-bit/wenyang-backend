/* ===== 非遗技艺馆（/crafts）总览页卡片配图重做 · 注入层 =====
   只做两件事：
   1) 给六张卡片的 .cm__thumb 换成各技艺专属的正方形实拍特写；
   2) 给根容器挂 #wbCraftGallery，让 crafts-gallery-cards.css 的正方形规则生效。
   不触碰 Vue 打包产物，不动工艺流程 / 代表纹样 / 传承人等其它区块。
*/
(function () {
  'use strict';

  var VER = 'craftcard1';
  var CSS_HREF = '/assets/crafts-gallery-cards.css?v=20261113craftcard1';

  /* 技艺 id → 卡片图（正方形 760×760 实拍特写）+ 兜底渐变 + 兜底大字 */
  var CARDS = {
    'wax-dyeing': {
      img: '/assets/images/craft-card/craft_1.jpg',
      alt: '苗族蜡染 · 蓝底白花布面特写',
      label: '蜡染',
      bg: 'linear-gradient(150deg,#1B2B44 0%,#2E4A6B 100%)',
      fg: '#F3E7CE'
    },
    'tie-dyeing': {
      img: '/assets/images/craft-card/craft_2.jpg',
      alt: '白族扎染 · 晕染边缘的蓝白布面特写',
      label: '扎染',
      bg: 'linear-gradient(150deg,#25395E 0%,#4A6C93 100%)',
      fg: '#F5ECDA'
    },
    'blue-print': {
      img: '/assets/images/craft-card/craft_3.jpg',
      alt: '蓝印花布 · 镂空刮浆印迹的白底蓝花布特写',
      label: '蓝印',
      bg: 'linear-gradient(150deg,#2B4A63 0%,#5A7E92 100%)',
      fg: '#F6EEDC'
    },
    'embroidery': {
      img: '/assets/images/craft-card/craft_4.jpg',
      alt: '四大名绣 · 苏绣猫的丝线绣面特写',
      label: '刺绣',
      bg: 'linear-gradient(150deg,#7A2A2F 0%,#A8424A 100%)',
      fg: '#FBEEDC'
    },
    'brocade': {
      img: '/assets/images/craft-card/craft_5.jpg',
      alt: '中国织锦 · 金线交织的云锦布面特写',
      label: '织锦',
      bg: 'linear-gradient(150deg,#6E1D22 0%,#9E3B2C 100%)',
      fg: '#F7E3B8'
    },
    'paper-cut': {
      img: '/assets/images/craft-card/craft_6.jpg',
      alt: '民间剪纸 · 红色镂空团花窗花特写',
      label: '剪纸',
      bg: 'linear-gradient(150deg,#A3281F 0%,#C8462F 100%)',
      fg: '#FFF4E2'
    }
  };

  /* 卡片顺序（与总览页展示顺序一致；用于 DOM 顺序兜底匹配） */
  var ORDER = ['wax-dyeing', 'tie-dyeing', 'blue-print', 'embroidery', 'brocade', 'paper-cut'];

  function injectCss() {
    if (document.querySelector('link[data-wb-craft-cards]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = CSS_HREF;
    l.setAttribute('data-wb-craft-cards', VER);
    document.head.appendChild(l);
  }

  /* 从卡片里的「进入专题」链接 /craft/<id> 反推技艺 id */
  function resolveId(card, index) {
    var a = card.querySelector('a[href*="/craft/"]') || card.closest('a[href*="/craft/"]');
    var href = a && a.getAttribute('href') || '';
    var m = href.match(/\/craft\/([a-z0-9-]+)/i);
    if (m && CARDS[m[1]]) return m[1];
    var name = (card.querySelector('.cm__name') || {}).textContent || '';
    name = name.trim();
    for (var k in CARDS) {
      if (name && name.indexOf(k) === 0) return k;
    }
    if (name.indexOf('蜡染') > -1 && name.indexOf('扎染') < 0) return 'wax-dyeing';
    if (name.indexOf('扎染') > -1) return 'tie-dyeing';
    if (name.indexOf('蓝印') > -1) return 'blue-print';
    if (name.indexOf('绣') > -1) return 'embroidery';
    if (name.indexOf('织锦') > -1) return 'brocade';
    if (name.indexOf('剪纸') > -1) return 'paper-cut';
    return ORDER[index] || null;
  }

  function withVer(src) {
    return src + (src.indexOf('?') > -1 ? '&' : '?') + 'v=20261113' + VER;
  }

  function applyCard(card, id) {
    var cfg = CARDS[id];
    if (!cfg) return false;
    var thumb = card.querySelector('.cm__thumb');
    if (!thumb) return false;

    var img = thumb.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      img.loading = 'lazy';
      thumb.appendChild(img);
    }
    var want = withVer(cfg.img);
    var cur = img.getAttribute('src') || '';
    if (cur !== want) {
      img.setAttribute('src', want);
      img.setAttribute('alt', cfg.alt);
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
    }
    /* 兜底：加载失败则用国风渐变 + 居中大字 */
    if (!img.__wbBound) {
      img.__wbBound = true;
      img.addEventListener('error', function () {
        thumb.style.background = cfg.bg;
        thumb.setAttribute('data-wb-fallback', cfg.label);
        img.style.display = 'none';
      });
      img.addEventListener('load', function () {
        thumb.style.background = '';
        thumb.removeAttribute('data-wb-fallback');
        img.style.display = '';
      });
    }
    return true;
  }

  function run() {
    var grid = document.querySelector('.cm__grid');
    if (!grid) return false;
    var cards = grid.querySelectorAll('.cm__card');
    if (!cards.length) return false;

    /* 标记根容器，激活正方形样式 */
    var root = grid.closest('.cm') || grid.parentElement;
    if (root && !root.id) root.id = 'wbCraftGallery';

    var done = 0;
    Array.prototype.forEach.call(cards, function (card, i) {
      var id = resolveId(card, i);
      if (id && applyCard(card, id)) done++;
    });
    return done > 0;
  }

  function boot() {
    injectCss();
    var tries = 0;
    (function tick() {
      if (run()) {
        observe();
        return;
      }
      if (++tries > 60) return;
      setTimeout(tick, 250);
    })();
  }

  /* SPA 路由切换回来时重新应用 */
  var mo = null;
  function observe() {
    if (mo) mo.disconnect();
    mo = new MutationObserver(function () {
      if (!document.querySelector('.cm__grid')) return;
      var first = document.querySelector('.cm__card .cm__thumb img');
      if (first && /craft_\\d\\.jpg/.test(first.getAttribute('src') || '')) return;
      run();
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  window.addEventListener('load', function () {
    if (!run()) return;
  });
})();
