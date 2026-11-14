/* ============================================================
 * profile_enhance.js —— 个人中心「我的创作」详情增强（纯前端，不依赖后端）
 * ------------------------------------------------------------
 * 站点产物中「我的创作」卡片只渲染了类型标签（纹样共创/智能配色/…），
 * 不显示创作标题，且没有点击查看详情的入口。本脚本在不改动原站
 * Vue 源码的前提下做产物级增强：
 *
 *   1）把卡片标题（<strong>）从「类型标签」替换为真实创作标题；
 *   2）在标题前补一个类型徽标（保留类型信息）；
 *   3）卡片可点击 / 回车，弹出详情弹窗（标题、类型、时间、原始需求、创作摘要）；
 *   4）所有样式以 .ce- 前缀隔离，不污染原站其它页面。
 *
 * 数据来源：wenyao:creations（与前端读取同源），按渲染顺序匹配卡片。
 * 移除方式：删除 index.html 中本脚本的 <script> 标签即可，原站功能不变。
 * ============================================================ */
(function () {
  'use strict';

  if (window.__ceEnhanceLoaded) return;
  window.__ceEnhanceLoaded = true;

  var CRE_KEY = 'wenyao:creations';
  var TYPE_LABEL = { generate: '纹样共创', color: '智能配色', transfer: '风格迁移', story: '故事剧场' };
  var STYLE_ID = 'ceEnhanceStyle';

  function readCreations() {
    try {
      var a = JSON.parse(localStorage.getItem(CRE_KEY) || '[]');
      if (Array.isArray(a) && a.length) return a;
    } catch (e) { /* ignore */ }
    try {
      var u = JSON.parse(localStorage.getItem('wb_user') || 'null');
      if (u && Array.isArray(u.creations)) return u.creations;
    } catch (e) { /* ignore */ }
    return [];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.profile__creation{cursor:pointer}' +
      '.ce-badge{display:inline-flex;align-items:center;gap:6px;margin:0;padding:0;' +
      'font-size:11.5px;font-weight:600;letter-spacing:1.5px;color:#a9822e;' +
      'background:none;border:none;vertical-align:middle;line-height:1.5}' +
      '.ce-badge::before{content:"";width:5px;height:5px;border-radius:50%;background:#b8892e;' +
      'box-shadow:0 0 0 2px rgba(200,155,60,.18)}' +
      '.ce-title{font-size:15px}' +
      '#ceModal{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;' +
      'background:rgba(40,28,24,.5);font-family:inherit}' +
      '#ceModal.ce-open{display:flex}' +
      '.ce-modal{width:min(540px,92vw);max-height:88vh;overflow:auto;background:#fbf6ec;border:1px solid #e6d8bf;' +
      'border-radius:14px;box-shadow:0 20px 56px rgba(0,0,0,.28)}' +
      '.ce-modal__hd{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #efe2cb}' +
      '.ce-modal__hd h3{margin:0;color:#9d2933;font-size:18px;word-break:break-all}' +
      '.ce-modal__close{border:none;background:transparent;font-size:22px;line-height:1;color:#8a6d3b;cursor:pointer;padding:0 4px}' +
      '.ce-modal__cover{display:flex;align-items:center;justify-content:center;height:200px;margin:16px 20px 0;' +
      'background:linear-gradient(135deg,#f3e4c8,#fbf6ec);border:1px dashed #d9c39a;border-radius:10px;font-size:64px;color:#9d2933}' +
      '.ce-modal__cover img{max-width:100%;max-height:100%;border-radius:8px;object-fit:contain}' +
      '.ce-modal__body{padding:14px 20px 6px}' +
      '.ce-modal__row{margin:12px 0;line-height:1.6}' +
      '.ce-modal__row .k{color:#8a6d3b;font-weight:600;margin-right:8px}' +
      '.ce-modal__desc{background:#fdfaf2;border:1px solid #efe2cb;border-radius:8px;padding:10px 12px;color:#5b4a36;margin-top:6px;line-height:1.7}' +
      '.ce-modal__hint{text-align:center;color:#a98c5a;font-size:12px;padding:8px 20px 16px}';
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function closeModal() {
    var m = document.getElementById('ceModal');
    if (m) m.classList.remove('ce-open');
  }

  function openModal(c) {
    injectStyle();
    var label = TYPE_LABEL[c.type] || c.type || '创作';
    var cover = (c.output && c.output.images && c.output.images[0])
      ? '<img src="' + esc(c.output.images[0]) + '" alt="封面">'
      : '<span>' + esc(label.charAt(0)) + '</span>';
    var time = c.createdAt ? new Date(c.createdAt).toLocaleString('zh-CN') : '';

    var modal = document.getElementById('ceModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'ceModal';
      document.body.appendChild(modal);
      modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    }
    modal.innerHTML =
      '<div class="ce-modal" role="dialog" aria-modal="true">' +
        '<div class="ce-modal__hd"><h3>' + esc(c.title || label) + '</h3>' +
        '<button class="ce-modal__close" aria-label="关闭">&times;</button></div>' +
        '<div class="ce-modal__cover">' + cover + '</div>' +
        '<div class="ce-modal__body">' +
          '<div class="ce-modal__row"><span class="k">类型</span>' + esc(label) + '</div>' +
          (time ? '<div class="ce-modal__row"><span class="k">创建时间</span>' + esc(time) + '</div>' : '') +
          (c.prompt ? '<div class="ce-modal__row"><span class="k">原始需求</span><div class="ce-modal__desc">' + esc(c.prompt) + '</div></div>' : '') +
          (c.summary ? '<div class="ce-modal__row"><span class="k">创作摘要</span><div class="ce-modal__desc">' + esc(c.summary) + '</div></div>' : '') +
          (c.content ? '<div class="ce-modal__row"><span class="k">内容</span><div class="ce-modal__desc">' + esc(c.content) + '</div></div>' : '') +
        '</div>' +
        '<div class="ce-modal__hint">演示数据 · 由前端 mock 生成</div>' +
      '</div>';
    modal.querySelector('.ce-modal__close').addEventListener('click', closeModal);
    modal.classList.add('ce-open');
  }

  function enhance() {
    if (location.pathname.indexOf('/profile') < 0) return;
    var list = document.querySelector('.profile__creations');
    if (!list) return;
    var cards = list.querySelectorAll('.profile__creation');
    var data = readCreations();
    cards.forEach(function (card, idx) {
      if (card.__ceDone) return;
      var c = data[idx] || {};
      var info = card.querySelector('.profile__creation-info');
      var strong = card.querySelector('strong');
      // 1) 标题：用真实创作标题替换原有的类型标签
      if (strong && c.title) {
        strong.textContent = c.title;
        strong.classList.add('ce-title');
      }
      // 2) 类型徽标（保留类型信息，避免只显示标题时丢失类型）
      if (c.type && info && !card.querySelector('.ce-badge')) {
        var badge = document.createElement('span');
        badge.className = 'ce-badge';
        badge.textContent = TYPE_LABEL[c.type] || c.type;
        if (strong) info.insertBefore(badge, strong);
        else info.insertBefore(badge, info.firstChild);
      }
      // 3) 点击 / 回车打开详情
      card.__ceDone = true;
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.addEventListener('click', function () { openModal(c); });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(c); }
      });
    });
  }

  function start() {
    injectStyle();
    // 持续修正：Vue 重渲染后新节点也能被增强（__ceDone 防止重复绑定）
    var obs = new MutationObserver(function () { enhance(); });
    obs.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
    enhance();
  }

  if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})();
