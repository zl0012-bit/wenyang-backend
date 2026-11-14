/* ============================================================
 * craft-wax-fusion.js —— 非遗详情页「全屏人物实景 + 宣纸遮罩 + 毛玻璃展签」
 * ------------------------------------------------------------
 * 四个路由共用同一套 .wxf-* 类名与 DOM 结构：
 *   · /craft/wax-dyeing   苗族蜡染（已复刻 · 全屏实景，与四大名绣统一）
 *   · /craft/embroidery   四大名绣
 *   · /craft/tie-dyeing   白族扎染
 *   · /craft/blue-print   蓝印花布
 *   · /craft/paper-cut    民间剪纸
 *   · /craft/brocade      中国织锦
 *   后五者共用 .wxf-scene 沉浸式实景规则，仅素材 / 定位 / 遮罩参数不同。
 *
 * 独立于 Vue 渲染树：
 *   · 背景层 .wxf-bg 直接挂到 body（100vw/100vh/fixed/z-index:0），
 *     脱离 .cm/.cr-intro 的 max-width 与 overflow 限制，铺满整屏；
 *     data-craft 区分技艺，CSS 按该属性覆盖背景图与质感，互不污染。
 *   · 给 .cm 加 .wxf-hero-cm、给 .cr-intro 加 .wxf-hero。
 *   · 把 .section-title + .cr-intro__body 包进毛玻璃卡片 .wxf-card。
 *   · 右侧 .wxf-butterfly 按技艺换成对应实拍图。
 *   · 轮询 + 幂等；切到不支持的路由时完整还原 DOM，避免污染其它页面。
 * ============================================================ */
(function () {
  'use strict';

  var STYLE_ID = 'wxfFusionStyle';
  var BG_ID = 'wxfGlobalBg';
  var CSS_HREF = '/assets/craft-wax-fusion.css?v=20261113wxf3';

  /* 六个路由共用同一套 .wxf-* 类名与 DOM 结构：
     · wax-dyeing  苗族蜡染：已复刻全屏实景，加 .wxf-scene（与四大名绣统一）
     · embroidery  四大名绣
     · tie-dyeing  白族扎染
     · blue-print  蓝印花布
     · paper-cut   民间剪纸
     · brocade     中国织锦
     后五者共用「.wxf-scene 沉浸式实景」规则：宣纸遮罩 / 展签 blur / 视频卡与
     交互按钮统一毛玻璃。中国织锦图光影对比强（中亮四周暗）：木机老匠人在左、
     发光丝线居中、右侧木制织机偏暗。单独用「左重右轻」渐变遮罩保住右侧织机
     纹理，左侧展签用 rgba(250,245,235,.7)+blur(16px) 压住暗部且透出匠人剪影。 */
  var SCENE_CRAFTS = { 'wax-dyeing': 1, embroidery: 1, 'tie-dyeing': 1, 'blue-print': 1, 'paper-cut': 1, 'brocade': 1 };

  /* 卡片小图统一取自「非遗技艺馆」总览页各技艺主图（craft-card/craft_1~6.jpg，760×760），
     与总览页展签同一张图，避免两处配图不一致。 */
  var CARD_VER = 'v=20261113craftcard1';
  var CRAFTS = {
    'wax-dyeing': {
      art: '/assets/images/craft-card/craft_1.jpg?' + CARD_VER,
      alt: '蓝底白花 · 苗族蜡染布面'
    },
    embroidery: {
      art: '/assets/images/craft-card/craft_4.jpg?' + CARD_VER,
      alt: '苏绣猫 · 丝线绣面特写'
    },
    'tie-dyeing': {
      art: '/assets/images/craft-card/craft_2.jpg?' + CARD_VER,
      alt: '蓝白晕染 · 大理白族扎染布面'
    },
    'blue-print': {
      art: '/assets/images/craft-card/craft_3.jpg?' + CARD_VER,
      alt: '白底蓝花 · 蓝印花布布面'
    },
    'paper-cut': {
      art: '/assets/images/craft-card/craft_6.jpg?' + CARD_VER,
      alt: '红色团花 · 民间剪纸窗花'
    },
    'brocade': {
      art: '/assets/images/craft-card/craft_5.jpg?' + CARD_VER,
      alt: '金线团龙 · 中国织锦布面'
    }
  };

  function currentCraft() {
    var m = /^\/craft\/([a-z-]+)\/?$/.exec(location.pathname || '');
    return m && CRAFTS[m[1]] ? m[1] : null;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var l = document.createElement('link');
    l.id = STYLE_ID; l.rel = 'stylesheet'; l.href = CSS_HREF;
    document.head.appendChild(l);
  }

  // ① 全屏背景层：挂到 body，幂等；data-craft 决定用哪套 CSS 参数
  function ensureBg(craft) {
    var bg = document.getElementById(BG_ID);
    if (!bg) {
      bg = document.createElement('div');
      bg.id = BG_ID;
      bg.className = 'wxf-bg';
      document.body.insertBefore(bg, document.body.firstChild);
    }
    if (bg.getAttribute('data-craft') !== craft) bg.setAttribute('data-craft', craft);
    /* 实景沉浸式页共用的样式钩子；切回苗族蜡染时移除，保证原版视觉不受影响 */
    if (SCENE_CRAFTS[craft]) bg.classList.add('wxf-scene');
    else bg.classList.remove('wxf-scene');
  }

  // 切到别的路由：移除背景层，并把被包进 .wxf-card 的内容还原回 .cr-intro
  function restore() {
    var bg = document.getElementById(BG_ID);
    if (bg && bg.parentNode) bg.parentNode.removeChild(bg);

    document.querySelectorAll('.wxf-hero-cm').forEach(function (e) {
      e.classList.remove('wxf-hero-cm');
    });
    document.querySelectorAll('.cr-intro.wxf-hero').forEach(function (intro) {
      var card = intro.querySelector('.wxf-card');
      if (card) {
        while (card.firstChild) intro.appendChild(card.firstChild);
        card.parentNode.removeChild(card);
      }
      intro.classList.remove('wxf-hero');
    });
  }

  function build(intro, craft) {
    ensureBg(craft);
    intro.classList.add('wxf-hero');

    // 父容器解除 max-width（背景已剥离，让卡片布局不受限）
    var cm = intro.closest('.cm');
    if (cm) cm.classList.add('wxf-hero-cm');

    // 玻璃卡片：包住标题 + 左右分栏（幂等）
    var card = intro.querySelector('.wxf-card');
    if (!card) {
      card = document.createElement('div');
      card.className = 'wxf-card';
      var title = intro.querySelector('.section-title');
      var body = intro.querySelector('.cr-intro__body');
      if (title) card.appendChild(title);
      if (body) card.appendChild(body);
      intro.appendChild(card);
    }

    // 右图：按技艺换对应实拍素材（幂等）
    var cfg = CRAFTS[craft];
    var media = card.querySelector('.cr-intro__media');
    if (media) {
      var bf = media.querySelector('.wxf-butterfly');
      if (!bf) {
        bf = document.createElement('img');
        bf.className = 'wxf-butterfly';
        media.appendChild(bf);
      }
      if (bf.getAttribute('src') !== cfg.art) bf.setAttribute('src', cfg.art);
      if (bf.getAttribute('alt') !== cfg.alt) bf.setAttribute('alt', cfg.alt);
    }
  }

  function tick() {
    try {
      injectStyle();
      var craft = currentCraft();
      if (craft) {
        var intro = document.querySelector('.cr-intro');
        if (intro) build(intro, craft);
      } else {
        restore();
      }
    } catch (e) { /* 静默容错 */ }
  }

  function boot() { tick(); setInterval(tick, 1200); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
