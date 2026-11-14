// [AI-WORKFLOW] 已废弃：主站 bundle 的导航数组原生包含「AI 共创」（/ai），
// 本脚本曾是迁移期的注入方案，会导致导航出现两个「AI 共创」。
// 现改为守卫版：仅当导航中完全没有指向 /ai 的链接时才补插（正常情况下永远不会触发）。
(function () {
  function addWf() {
    var nav = document.querySelector('nav.app-nav');
    if (!nav) return false;
    var has = nav.querySelector('a[data-aiwf]');
    if (!has) {
      // 兼容 Vue Router 渲染的链接（href 可能是 /ai 或由 to 属性渲染）
      var links = nav.querySelectorAll('a');
      for (var i = 0; i < links.length; i++) {
        var h = links[i].getAttribute('href') || links[i].getAttribute('to') || '';
        if (h === '/ai' || h.indexOf('/ai') === 0 || links[i].textContent.indexOf('AI 共创') >= 0) { has = links[i]; break; }
      }
    }
    if (has) return true;
    var a = document.createElement('a');
    a.setAttribute('data-v-0d85b9be', '');
    a.setAttribute('data-aiwf', '1');
    a.setAttribute('href', '/ai');
    a.className = 'nav-link';
    a.textContent = 'AI 共创';
    var all = nav.querySelectorAll('a.nav-link');
    var last = all[all.length - 1];
    if (last) nav.insertBefore(a, last);
    else nav.appendChild(a);
    return true;
  }
  setInterval(function () { try { addWf(); } catch (e) { /* ignore */ } }, 600);
  addWf();
  document.addEventListener('DOMContentLoaded', addWf);
})();
