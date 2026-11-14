/* ============================================================
 * admin_gate.js —— 前台「个人中心」登录页的管理员分流入口
 * ------------------------------------------------------------
 * 在 /profile 登录界面输入管理员账号 admin / Admin123456 时，
 * 不走普通用户登录逻辑，直接写入后台 token 并跳转 /admin。
 * 其余邮箱/密码仍走页面原有登录（localStorage Mock）流程。
 *
 * 实现要点：
 * - document 捕获阶段事件委托，不受 Vue 重渲染影响；
 * - 提交按钮的判据是「位于包含密码框的 <form> 内」，
 *   「登录 / 注册」Tab 均在表单外，不会被误伤；
 * - 覆盖三条提交路径：点击提交按钮 / 表单原生 submit / 密码框回车。
 * ============================================================ */
(function () {
  'use strict';

  var ADMIN_USER = 'admin';
  var ADMIN_PASS = 'Admin123456';

  function loginInputs() {
    var email = document.querySelector('input.profile__input[type="email"]')
      || document.querySelector('input[placeholder="邮箱"]');
    var pwd = document.querySelector('input.profile__input[type="password"]')
      || document.querySelector('input[placeholder*="密码"]');
    return { email: email, pwd: pwd };
  }

  function isAdmin(t) {
    if (!t.email || !t.pwd) return false;
    var u = (t.email.value || '').trim().toLowerCase();
    var p = (t.pwd.value || '').trim();
    // 管理员密码唯一且固定；只要密码正确、账号字段已填写（admin 或任意邮箱）即视为管理员。
    // 这样无论在前台「邮箱」框输入 admin 还是管理员邮箱，都能正确分流进后台。
    if (p !== ADMIN_PASS) return false;
    return u === ADMIN_USER || u.indexOf('@') >= 0;
  }

  function goAdmin(e) {
    if (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
    }
    try {
      var token = 'mock-admin-token-' + Date.now();
      // 写入主站兼容 key
      localStorage.setItem('admin_token', token);
      localStorage.setItem('admin_user', 'admin');
      // 同步写入后台 SPA 的 token key（wenyao:admin_token），使会话无缝带入 /admin
      var ttl = 2 * 60 * 60 * 1000;
      localStorage.setItem('wenyao:admin_token', JSON.stringify({
        token: token, user: 'admin', iat: Date.now(), exp: Date.now() + ttl
      }));
    } catch (err) { /* ignore */ }
    window.location.href = '/admin';
  }

  /* 提交按钮判据：位于「包含密码框的 form」内的按钮 */
  function isSubmitButton(btn) {
    if (!btn || !btn.closest) return false;
    var form = btn.closest('form');
    return !!(form && form.querySelector('input[type="password"]'));
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (btn && isSubmitButton(btn) && isAdmin(loginInputs())) {
      goAdmin(e);
    }
  }, true);

  // 表单原生提交（回车 / submit 型按钮）
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.querySelector || !form.querySelector('input[type="password"]')) return;
    if (isAdmin(loginInputs())) goAdmin(e);
  }, true);

  // 密码框回车兜底（按钮非 submit 型时，回车可能不触发 form submit）
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var t = loginInputs();
    if (e.target === t.pwd && isAdmin(t)) goAdmin(e);
  }, true);

  /* [CLEANUP] 登录页底部的「管理员提示」小字已按需求移除：不再注入 #adminGateHint。
     管理员分流逻辑（isAdmin / goAdmin / 三条提交路径）全部保留，仅去掉可见提示文字。 */
})();
