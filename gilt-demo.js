/* ==========================================================================
   gilt-demo.js —— 「演示模式」标注层
   --------------------------------------------------------------------------
   只做三件事，全部是叠加，不触碰原应用逻辑：
     1) 给指向 /ai、/ai-workshop 的链接追加「演示」角标（导航、移动端抽屉、页脚一起覆盖）
     2) 当路由处于 AI 页面时，显示底部常驻说明条
     3) 给右下角 AI 助手悬浮按钮加角标
   SPA 路由通过 pushState 补丁 + popstate + MutationObserver 三重感知，
   任何一次跳转都会重新同步。若需改为「隐藏入口」，把 HIDE_INSTEAD 改成 true。
   ========================================================================== */
(function () {
  'use strict';

  var HIDE_INSTEAD = false;           // true = 隐藏 AI 入口而非标注
  var REAL_MODE = true;               // ★ AI 导览已接入真实后端（/api/agent_chat）：
                                      //   不再注入「演示模式」黄条与「演示」角标
  var AI_PATHS = ['/ai', '/ai-workshop'];
  var BAR_TEXT = '本页 AI 能力由浏览器本地模拟，未接入真实模型与后端';

  function isAiPath(p) {
    if (!p) return false;
    p = p.replace(/\/+$/, '') || '/';
    return AI_PATHS.indexOf(p) !== -1;
  }

  /* ---------- 说明条 ---------- */
  var bar = null;
  function ensureBar() {
    if (bar && document.body.contains(bar)) return bar;
    bar = document.createElement('div');
    bar.id = 'giltDemoBar';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');

    var dot = document.createElement('span');
    dot.className = 'gdb-dot';

    var strong = document.createElement('span');
    strong.className = 'gdb-strong';
    strong.textContent = '演示模式';

    var sep = document.createElement('span');
    sep.className = 'gdb-sep';

    var text = document.createElement('span');
    text.className = 'gdb-text';
    text.textContent = BAR_TEXT;

    bar.appendChild(dot);
    bar.appendChild(strong);
    bar.appendChild(sep);
    bar.appendChild(text);
    document.body.appendChild(bar);
    return bar;
  }

  function syncBar() {
    if (HIDE_INSTEAD || REAL_MODE) return;   // REAL_MODE：黄条彻底不注入
    var el = ensureBar();
    var on = isAiPath(location.pathname);
    if (on) el.classList.add('is-on');
    else el.classList.remove('is-on');
  }

  /* ---------- 链接角标 ---------- */
  function tagLinks() {
    if (REAL_MODE) return;   // REAL_MODE：不再给 AI 入口加「演示」角标
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var path;
      try {
        path = new URL(a.href, location.origin).pathname;
      } catch (e) {
        continue;
      }
      if (!isAiPath(path)) continue;
      if (a.querySelector('.gilt-demo-tag')) continue;
      if (a.closest && a.closest('#giltDemoBar')) continue;

      if (HIDE_INSTEAD) {
        a.style.setProperty('display', 'none', 'important');
        continue;
      }

      var tag = document.createElement('span');
      tag.className = 'gilt-demo-tag';
      tag.textContent = '演示';
      tag.setAttribute('aria-hidden', 'true');
      a.appendChild(tag);
    }
  }

  /* ---------- AI 助手按钮角标 ---------- */
  function tagAssistant() {
    if (REAL_MODE) return;   // REAL_MODE：悬浮按钮不再加「演示」角标
    var fab = document.querySelector('.ai-assistant__fab');
    if (!fab || fab.querySelector('.gilt-demo-fab')) return;
    if (HIDE_INSTEAD) {
      fab.style.setProperty('display', 'none', 'important');
      return;
    }
    var cs = window.getComputedStyle(fab);
    if (cs.position === 'static') fab.style.position = 'relative';
    var badge = document.createElement('span');
    badge.className = 'gilt-demo-fab';
    badge.textContent = '演示';
    badge.setAttribute('aria-hidden', 'true');
    fab.appendChild(badge);

    var label = fab.getAttribute('aria-label') || 'AI 助手';
    if (label.indexOf('演示') === -1) {
      fab.setAttribute('aria-label', label + '（演示模式）');
      fab.setAttribute('title', label + ' · 演示模式，本地模拟回复');
    }
  }

  /* ---------- 统一同步 ---------- */
  var pending = false;
  function sync() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      syncBar();
      tagLinks();
      tagAssistant();
    });
  }

  function boot() {
    sync();
    // 首屏异步渲染（组件懒加载）后再补一次
    setTimeout(sync, 300);
    setTimeout(sync, 1200);
  }

  /* ---------- SPA 路由感知 ---------- */
  try {
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      if (typeof orig !== 'function') return;
      history[m] = function () {
        var r = orig.apply(this, arguments);
        setTimeout(sync, 0);
        return r;
      };
    });
  } catch (e) {
    /* ignore */
  }
  window.addEventListener('popstate', sync);
  window.addEventListener('hashchange', sync);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 监听 DOM 变化（路由切换、抽屉打开、组件重渲染）
  try {
    var obs = new MutationObserver(function () {
      sync();
    });
    var startObserve = function () {
      obs.observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) startObserve();
    else document.addEventListener('DOMContentLoaded', startObserve);
  } catch (e) {
    /* 老浏览器降级：仅依赖定时同步 */
  }

  // 兜底轮询（极低频，防止观察器在特殊场景漏掉）
  setInterval(sync, 2500);
})();
