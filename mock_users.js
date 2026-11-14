/* ============================================================
 * mock_users.js —— 测试账号（纯前端 Mock，不依赖后端 / 数据库）
 * ------------------------------------------------------------
 * 对应源码规范中的 src/api/mock/users.ts + src/api/mock/auth.ts。
 * 因当前交付物为已构建产物（无源码树），此处以注入脚本方式提供等价实现：
 *
 * 1）账号数据：test@wenyang-museum.com / Test123456（收藏 5 / 创作 3（含纹样配图）/ 对话 3 含完整长文）
 * 2）登录链路：沿用站点原生 mock 登录（wenyao:users 查邮箱+密码 → wb_token），
 *    本脚本仅负责「确保账号已存在」，不拦截、不改写原有登录逻辑；
 *    登录成功后额外写入 wb_user（含 favorites / creations / chats）。
 * 3）页面呈现：登录页与个人中心顶部标注「当前为演示模式」；
 *    个人中心注入「AI 对话记录」区块（原产物无此区块）；头像替换为 /avatars/test-user.png。
 * 4）数据持久化：收藏 / 创作读写 wenyao:favorites / wenyao:creations，刷新后保持。
 *
 * 移除方式：删除 index.html 中本脚本的 <script> 标签即可，不影响其它功能。
 * ============================================================ */
(function () {
  'use strict';

  var USERS_KEY = 'wenyao:users';      // 站点原生账号表（mock 登录读取）
  var TOKEN_KEY = 'wb_token';          // 站点原生 token
  var USER_KEY = 'wb_user';            // 规范要求的当前用户信息
  var FAV_KEY = 'wenyao:favorites';    // 收藏（纹样 id 数组）
  var CRE_KEY = 'wenyao:creations';    // 创作记录
  var CHAT_KEY = 'wenyao:chats';       // AI 对话记录
  var SEED_FLAG = 'wenyao:mock_seeded_v1';
  var SEED_FLAG_V2 = 'wenyao:mock_seeded_v2';   // v2：创作配图 + 完整长对话迁移

  // ── 账号数据（等价于 src/api/mock/users.ts） ──
  var MOCK_USERS = [
    {
      id: 0,
      username: '系统管理员',
      email: 'admin@wenyang-museum.com',
      password: 'Admin123456',
      role: 'admin',
      avatar: '/avatars/test-user.png',
      favorites: [],
      creations: [],
      chats: []
    },
    {
      id: 1,
      username: '测试用户',
      email: 'test@wenyang-museum.com',
      password: 'Test123456',
      avatar: '/avatars/test-user.png',
      favorites: ['G01', 'A01', 'P01', 'J01', 'J06'],
      creations: [
        {
          id: 1, type: 'generate', title: '唐代风格宝相花', createdAt: '2026-10-01',
          prompt: '请以盛唐审美生成一枚宝相花纹样，结构对称、富丽饱满。',
          summary: '以唐代宝相花为母题，融合卷草与莲瓣，配色取石青、描金，呈现雍容华贵的盛唐气象。',
          output: { images: ['/patterns/A20.webp'] }
        },
        {
          id: 2, type: 'color', title: '青花缠枝莲配色', createdAt: '2026-10-02',
          prompt: '为青花瓷缠枝莲纹设计一套传统配色方案。',
          summary: '提取青花瓷缠枝莲的钴蓝与釉白，形成沉静典雅的传统色卡，适用于文创与界面延展。',
          output: { images: ['/patterns/P08.webp'] }
        },
        {
          id: 3, type: 'story', title: '蝴蝶妈妈的传说', createdAt: '2026-10-03',
          prompt: '以苗族蜡染蝴蝶纹为灵感，创作一段故事剧场脚本。',
          summary: '讲述苗族古歌中蝴蝶妈妈孵化万物生灵的传说，画面以蜡染冰纹表现图腾之美。',
          output: { images: ['/patterns/M04.webp'] }
        }
      ],
      chats: [
        {
          id: 1,
          question: '云纹和雷纹有什么区别',
          answer: '这两者可以说是青铜时代纹样世界里"一圆一方"的一对兄弟。\n\n云纹以圆润的卷曲线条为骨架，线条舒展流动、连绵不断，取意于天上舒卷的云气，寓意高升如意、绵延不绝。它从商周云雷纹中逐渐分化出来，到汉代发展出极富动感的"云气纹"，常见于漆器、瓦当与织锦之上。\n\n雷纹则恰好相反：以方折的回旋线条构成，一道道方折的"回"字形层层外扩，节奏凝重、古朴庄严。古人以雷声象征天威，因此雷纹多饰于青铜器的颈部与足部，作为衬托主纹的地纹。\n\n简单记：柔和的圆弧卷曲是云纹，方正的回形折线是雷纹——圆者流动为云，方者回旋为雷。',
          createdAt: '2026-10-01'
        },
        {
          id: 2,
          question: '苗族蜡染的蝴蝶纹有什么寓意',
          answer: '蝴蝶纹在苗族文化中有着近乎创世神话的地位。苗族古歌传唱：蝴蝶妈妈从枫香树心中孕育而生，与水泡"游方"相恋，生下十二个蛋，由鹡宇鸟孵化出苗族始祖姜央，以及雷、龙、虎等万物生灵。\n\n因此蝴蝶纹不只是装饰，更是"生命繁衍、族群起源"的图腾象征。在苗族的蜡染裙饰与背扇上，蝴蝶常与石榴纹、鱼纹、铜鼓纹相伴出现，寄托着护佑子孙、祈福纳吉的愿望。\n\n有趣的是，蜡染匠人画蝴蝶时并不刻意求形似——冰裂纹会替她们完成最后的"点睛"：蜂蜡在浸染中龟裂，靛蓝顺着裂缝渗入布面，每一只蝴蝶都长出独一无二的冰纹翅膀。这正是蜡染"人作一半、天成一半"的魅力所在。',
          createdAt: '2026-10-02'
        },
        {
          id: 3,
          question: '想给中秋文创礼盒配一枚传统纹样，有什么推荐',
          answer: '中秋主题可以从"月宫、玉兔、桂树、缠枝"这几组意象入手，推荐三个方向：\n\n① 团窠桂花纹：以圆形团窠为骨架，中心满饰桂枝与桂花，外圈用如意云头收边——圆形呼应满月，"桂"又谐音"贵"，寓意团圆富贵，最稳重也最不易出错。\n\n② 玉兔捣药纹：以侧面剪影的玉兔居中，背景衬缠枝莲或流云纹，风格可参考汉画像石的质朴感，适合走国潮童趣路线。\n\n③ 海水江崖托月纹：底部以简化的海水江崖托起一轮满月，气势开阔，适合作为礼盒盖面的主视觉。\n\n配色上建议使用"石青＋月白＋描金"三色体系：石青沉静、月白清雅，描金点缀月辉，避开大红大绿，更能衬托中秋清朗的气质。',
          createdAt: '2026-10-03'
        }
      ]
    }
  ];

  // ── localStorage 读写 ──
  function read(key, dft) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : dft;
    } catch (e) { return dft; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
  }

  // ── 播种：账号写入 wenyao:users；演示数据仅在首次写入（不覆盖用户后续操作） ──
  function seed() {
    var users = read(USERS_KEY, []) || [];
    var changed = false;
    MOCK_USERS.forEach(function (u) {
      var exists = users.some(function (x) { return x.email === u.email; });
      if (!exists) {
        users.push({
          id: u.id, username: u.username, email: u.email,
          password: u.password, avatar: u.avatar
        });
        changed = true;
      }
    });
    if (changed) write(USERS_KEY, users);

    if (!localStorage.getItem(SEED_FLAG)) {
      // 注意：种子数据取「测试用户」（管理员 MOCK_USERS[0] 的收藏/创作/对话为空）
      var tu = MOCK_USERS.filter(function (u) { return u.email === 'test@wenyang-museum.com'; })[0] || MOCK_USERS[0];
      if (read(FAV_KEY, null) === null) write(FAV_KEY, tu.favorites);
      if (read(CRE_KEY, null) === null) write(CRE_KEY, tu.creations);
      if (read(CHAT_KEY, null) === null) write(CHAT_KEY, tu.chats);
      try { localStorage.setItem(SEED_FLAG, '1'); } catch (e) { /* ignore */ }
    }

    // v2 迁移：为老数据补齐创作配图与完整长对话（按 id 合并，保留用户新增条目）
    if (!localStorage.getItem(SEED_FLAG_V2)) {
      var tu2 = MOCK_USERS.filter(function (u) { return u.email === 'test@wenyang-museum.com'; })[0];
      if (tu2) {
        var cre = read(CRE_KEY, null);
        write(CRE_KEY, cre === null ? tu2.creations : mergeById(cre, tu2.creations));
        var chatsOld = read(CHAT_KEY, null);
        write(CHAT_KEY, chatsOld === null ? tu2.chats : mergeById(chatsOld, tu2.chats));
      }
      try { localStorage.setItem(SEED_FLAG_V2, '1'); } catch (e) { /* ignore */ }
    }
  }

  // 按 id 把 updates 覆盖进 list（同 id 更新字段，不存在则追加，其余条目原样保留）
  function mergeById(list, updates) {
    if (!Array.isArray(list)) return updates;
    updates.forEach(function (u) {
      var hit = -1;
      for (var i = 0; i < list.length; i++) { if (list[i] && list[i].id === u.id) { hit = i; break; } }
      if (hit >= 0) list[hit] = Object.assign({}, list[hit], u);
      else list.push(u);
    });
    return list;
  }

  // ── 同步 wb_user（等价于 mockGetCurrentUser 的写入侧） ──
  function currentEmail() {
    var t = localStorage.getItem(TOKEN_KEY);
    if (!t) return null;
    // token 以 JSON 字符串形式存储（形如 "\"mock:user@x.com\""），需先还原再去掉 mock: 前缀
    try { t = JSON.parse(t); } catch (e) { /* 非 JSON 则原样使用 */ }
    return String(t).replace(/^mock:/, '');
  }

  function syncUser() {
    var email = currentEmail();
    if (!email) {
      try { localStorage.removeItem(USER_KEY); } catch (e) { /* ignore */ }
      return;
    }
    var mu = MOCK_USERS.filter(function (u) { return u.email === email.toLowerCase(); })[0];
    var base = mu || (read(USERS_KEY, []) || []).filter(function (x) { return x.email === email; })[0];
    if (!base) {
      try { localStorage.removeItem(USER_KEY); } catch (e) { /* ignore */ }
      return;
    }
    write(USER_KEY, {
      id: base.id,
      username: base.username,
      email: base.email,
      avatar: base.avatar || '/avatars/test-user.png',
      favorites: read(FAV_KEY, mu ? mu.favorites : []),
      creations: read(CRE_KEY, []),
      chats: read(CHAT_KEY, mu ? mu.chats : [])
    });
  }

  // ── 登录兜底：确认账号存在于 wenyao:users（随后仍走站点原生登录） ──
  function inputs() {
    var email = document.querySelector('input.profile__input[type="email"]')
      || document.querySelector('input[placeholder="邮箱"]');
    var pwd = document.querySelector('input.profile__input[type="password"]')
      || document.querySelector('input[placeholder*="密码"]');
    return { email: email, pwd: pwd };
  }

  function ensureUser(email, password) {
    var mu = MOCK_USERS.filter(function (u) {
      return u.email === String(email || '').trim().toLowerCase();
    })[0];
    if (!mu || mu.password !== String(password || '').trim()) return false;
    var users = read(USERS_KEY, []) || [];
    if (!users.some(function (x) { return x.email === mu.email; })) {
      users.push({
        id: mu.id, username: mu.username, email: mu.email,
        password: mu.password, avatar: mu.avatar
      });
      write(USERS_KEY, users);
    }
    return true;
  }

  function preLogin() {
    var t = inputs();
    if (t.email && t.pwd) ensureUser(t.email.value, t.pwd.value);
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (btn && btn.closest && btn.closest('form')) preLogin();
  }, true);

  document.addEventListener('submit', function (e) {
    if (e.target && e.target.querySelector && e.target.querySelector('input[type="password"]')) preLogin();
  }, true);

  // ── UI：演示模式提示 / 对话记录区块 / 头像 ──
  var BANNER_TEXT = '当前为演示模式，测试账号：test@wenyang-museum.com / Test123456';

  function bannerStyle() {
    return 'margin:10px 0;padding:9px 14px;border-radius:10px;font-size:12px;line-height:1.6;' +
      'background:rgba(255,252,244,.7);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);' +
      'border:1px dashed rgba(200,155,60,.5);color:#8a6d3b;';
  }

  function addLoginBanner() {
    if (document.getElementById('mockDemoBannerLogin')) return;
    var t = inputs();
    if (!t.pwd || !t.email) return;
    var card = t.pwd.closest('form');
    card = card && card.parentElement ? card.parentElement : null;
    if (!card) return;
    var el = document.createElement('div');
    el.id = 'mockDemoBannerLogin';
    el.style.cssText = bannerStyle() + 'text-align:center;';
    el.textContent = BANNER_TEXT;
    card.insertBefore(el, card.firstChild);
  }

  function addProfileBanner() {
    if (document.getElementById('mockDemoBannerProfile')) return;
    var main = document.querySelector('.profile__main');
    if (!main) return;
    var el = document.createElement('div');
    el.id = 'mockDemoBannerProfile';
    el.style.cssText = bannerStyle();
    el.textContent = BANNER_TEXT;
    main.insertBefore(el, main.firstChild);
  }

  function chatStyle() {
    if (document.getElementById('mockChatStyle')) return;
    var css =
      /* —— 列表条目：单行截断预览，整条可点击 —— */
      '#mockChatsSection .mockchat{position:relative;display:flex;flex-direction:column;gap:7px;' +
      'padding:15px 70px 15px 8px;background:transparent;border:none;border-radius:0;' +
      'border-bottom:1px dashed rgba(157,41,51,.16);box-shadow:none;cursor:pointer;outline:none;' +
      'transition:background .2s ease}' +
      '#mockChatsSection .mockchat:hover,#mockChatsSection .mockchat:focus-visible{background:rgba(200,155,60,.07)}' +
      '#mockChatsSection .mockchat:last-child{border-bottom:none}' +
      '#mockChatsSection .mockchat__time{position:absolute;top:14px;right:40px;font-size:11px;' +
      'color:#c2b394;letter-spacing:.5px}' +
      /* 右上角精致删除按钮：悬停卡片时显现，点击移除该条对话 */
      '#mockChatsSection .mockchat__del{position:absolute;top:11px;right:8px;width:24px;height:24px;' +
      'display:grid;place-items:center;border-radius:50%;border:1px solid rgba(157,41,51,.28);' +
      'background:rgba(255,252,244,.92);color:#9d2933;cursor:pointer;opacity:0;transform:scale(.82);' +
      'transition:opacity .18s ease,transform .18s ease,background .2s ease,color .2s ease,box-shadow .2s ease;z-index:3}' +
      '#mockChatsSection .mockchat:hover .mockchat__del,' +
      '#mockChatsSection .mockchat:focus-within .mockchat__del{opacity:1;transform:scale(1)}' +
      '#mockChatsSection .mockchat__del:hover{background:#9d2933;color:#f5e9c9;border-color:#9d2933;box-shadow:0 4px 12px rgba(157,41,51,.35)}' +
      '#mockChatsSection .mockchat__more{position:absolute;bottom:15px;right:8px;font-size:12px;' +
      'color:#b8892e;letter-spacing:1px;opacity:.7;transition:opacity .2s ease,transform .2s ease}' +
      '#mockChatsSection .mockchat:hover .mockchat__more{opacity:1;transform:translateX(2px)}' +
      /* 提问行：金色引号 + 单行截断 */
      '#mockChatsSection .mockchat__q{display:flex;gap:8px;align-items:baseline;max-width:100%;min-width:0;' +
      'font-weight:700;font-size:14px;color:#4a3826;line-height:1.65;transition:color .2s ease}' +
      '#mockChatsSection .mockchat:hover .mockchat__q{color:#9d2933}' +
      '#mockChatsSection .mockchat__qtext{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '#mockChatsSection .mockchat__mark{flex:none;font-family:Georgia,"Noto Serif SC","STSong",serif;' +
      'font-size:24px;line-height:0;color:#b8892e;transform:translateY(7px)}' +
      /* 回答预览行：AI 徽标 + 单行截断 */
      '#mockChatsSection .mockchat__a{display:flex;gap:9px;align-items:flex-start;min-width:0;padding-right:6px}' +
      '#mockChatsSection .mockchat__ai{flex:none;width:22px;height:22px;border-radius:6px;display:grid;' +
      'place-items:center;background:linear-gradient(135deg,#9d2933,#7e2129);color:#f5e9c9;' +
      'font-weight:700;font-size:10px;margin-top:2px}' +
      '#mockChatsSection .mockchat__aprev{flex:1;min-width:0;font-size:13px;color:#8c8175;line-height:1.9;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      /* —— 详情弹窗：毛玻璃遮罩 + 国风宣纸卡片 —— */
      '.mockmodal{position:fixed;inset:0;z-index:99990;display:flex;align-items:center;justify-content:center;' +
      'padding:24px;opacity:0;visibility:hidden;transition:opacity .25s ease,visibility .25s ease}' +
      '.mockmodal.is-open{opacity:1;visibility:visible}' +
      '.mockmodal__mask{position:absolute;inset:0;background:rgba(34,24,16,.45);' +
      'backdrop-filter:blur(10px) saturate(1.05);-webkit-backdrop-filter:blur(10px) saturate(1.05)}' +
      '.mockmodal__dialog{position:relative;width:min(640px,94vw);max-height:82vh;display:flex;flex-direction:column;' +
      'background:linear-gradient(165deg,#fdf9ee 0%,#f9f1de 100%);border:1px solid rgba(200,155,60,.55);' +
      'border-radius:18px;box-shadow:0 32px 80px rgba(60,40,10,.35),0 0 0 4px rgba(200,155,60,.08);' +
      'transform:translateY(16px) scale(.97);transition:transform .28s ease;overflow:hidden}' +
      '.mockmodal.is-open .mockmodal__dialog{transform:none}' +
      '.mockmodal__head{display:flex;align-items:center;gap:12px;padding:18px 22px 14px;flex:none;' +
      'border-bottom:1px solid rgba(200,155,60,.28)}' +
      '.mockmodal__title{font-family:var(--font-title,serif);font-size:18px;color:#9d2933;letter-spacing:2px;margin:0}' +
      '.mockmodal__date{margin-left:auto;font-size:12px;color:#b9ab8f;letter-spacing:.5px}' +
      '.mockmodal__close{flex:none;margin-left:6px;width:30px;height:30px;border-radius:50%;' +
      'border:1px solid rgba(200,155,60,.5);background:rgba(255,252,244,.9);color:#8a6d3b;font-size:15px;' +
      'line-height:1;cursor:pointer;display:grid;place-items:center;transition:all .22s ease}' +
      '.mockmodal__close:hover{background:#9d2933;border-color:#9d2933;color:#f5e9c9;transform:rotate(90deg)}' +
      '.mockmodal__body{padding:20px 24px 24px;overflow-y:auto;display:flex;flex-direction:column;gap:16px}' +
      '.mockmodal__body::-webkit-scrollbar{width:6px}' +
      '.mockmodal__body::-webkit-scrollbar-thumb{background:rgba(200,155,60,.35);border-radius:3px}' +
      '.mockmodal__q{display:flex;gap:10px;align-self:flex-start;max-width:88%;padding:12px 16px;' +
      'border-radius:4px 16px 16px 16px;background:rgba(200,155,60,.12);border:1px solid rgba(200,155,60,.28);' +
      'font-weight:700;font-size:14.5px;color:#4a3826;line-height:1.75;white-space:pre-line}' +
      '.mockmodal__qmark{flex:none;font-family:Georgia,"Noto Serif SC",serif;font-size:26px;line-height:0;' +
      'color:#b8892e;transform:translateY(8px)}' +
      '.mockmodal__a{display:flex;gap:12px;align-items:flex-start}' +
      '.mockmodal__ai{flex:none;width:30px;height:30px;border-radius:8px;display:grid;place-items:center;' +
      'background:linear-gradient(135deg,#9d2933,#7e2129);color:#f5e9c9;font-weight:700;font-size:12px;margin-top:2px}' +
      '.mockmodal__atext{flex:1;min-width:0;font-size:14px;color:#5b4a36;line-height:1.95;white-space:pre-line;' +
      'padding:2px 0 14px;border-bottom:1px solid rgba(200,155,60,.25)}' +
      '.mockmodal__hint{text-align:center;color:#b9ab8f;font-size:11.5px;letter-spacing:1px;padding-bottom:14px}';
    var st = document.createElement('style');
    st.id = 'mockChatStyle';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ── 对话详情弹窗（毛玻璃遮罩 + 国风卡片，遮罩点击 / 关闭按钮 / Esc 均可关闭） ──
  var CHAT_MODAL_ID = 'mockChatModal';

  function chatModal() {
    var m = document.getElementById(CHAT_MODAL_ID);
    if (m) return m;
    m = document.createElement('div');
    m.id = CHAT_MODAL_ID;
    m.className = 'mockmodal';
    m.innerHTML =
      '<div class="mockmodal__mask"></div>' +
      '<div class="mockmodal__dialog" role="dialog" aria-modal="true" aria-label="对话详情">' +
        '<div class="mockmodal__head">' +
          '<h3 class="mockmodal__title">对话详情</h3>' +
          '<span class="mockmodal__date"></span>' +
          '<button class="mockmodal__close" aria-label="关闭">✕</button>' +
        '</div>' +
        '<div class="mockmodal__body">' +
          '<div class="mockmodal__q"><span class="mockmodal__qmark">\u201C</span><span class="mockmodal__qtext"></span></div>' +
          '<div class="mockmodal__a"><span class="mockmodal__ai">AI</span><div class="mockmodal__atext"></div></div>' +
          '<div class="mockmodal__hint">—— 完 · 点击遮罩或按 Esc 关闭 ——</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) {
      if (e.target === m || (e.target.classList && e.target.classList.contains('mockmodal__mask'))) closeChatModal();
    });
    m.querySelector('.mockmodal__close').addEventListener('click', closeChatModal);
    return m;
  }

  function closeChatModal() {
    var m = document.getElementById(CHAT_MODAL_ID);
    if (m) m.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  function openChatModal(c) {
    chatStyle();
    var m = chatModal();
    m.querySelector('.mockmodal__date').textContent = c.createdAt || '';
    m.querySelector('.mockmodal__qtext').textContent = c.question || '';
    m.querySelector('.mockmodal__atext').textContent = c.answer || '';
    m.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeChatModal();
  });

  function addChats() {
    if (document.getElementById('mockChatsSection')) return;
    var main = document.querySelector('.profile__main');
    if (!main) return;
    var chats = read(CHAT_KEY, []) || [];
    if (!chats.length) return;
    chatStyle();

    var heads = main.querySelectorAll('.profile__h');
    var anchorSection = null;
    for (var i = 0; i < heads.length; i++) {
      if (heads[i].textContent.indexOf('我的创作') >= 0) {
        anchorSection = heads[i].parentElement;
        break;
      }
    }

    var sec = document.createElement('section');
    sec.className = 'profile__section';
    sec.id = 'mockChatsSection';
    var h = document.createElement('h2');
    h.className = 'profile__h';
    h.textContent = 'AI 对话记录';
    sec.appendChild(h);

    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;';
    chats.forEach(function (c) {
      // 条目容器：单行截断预览，整条可点击查看完整对话
      var item = document.createElement('div');
      item.className = 'mockchat';
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.setAttribute('title', '点击查看完整对话');
      // 时间戳：右上角、调淡
      var time = document.createElement('span');
      time.className = 'mockchat__time';
      time.textContent = c.createdAt || '';
      // 提问行：金色引号 + 单行截断
      var q = document.createElement('div');
      q.className = 'mockchat__q';
      var mark = document.createElement('span');
      mark.className = 'mockchat__mark';
      mark.textContent = '\u201C';
      var qText = document.createElement('span');
      qText.className = 'mockchat__qtext';
      qText.textContent = c.question;
      q.appendChild(mark); q.appendChild(qText);
      // 回答预览行：AI 徽标 + 单行截断
      var a = document.createElement('div');
      a.className = 'mockchat__a';
      var ai = document.createElement('span');
      ai.className = 'mockchat__ai';
      ai.textContent = 'AI';
      var aprev = document.createElement('span');
      aprev.className = 'mockchat__aprev';
      aprev.textContent = c.answer || '';
      a.appendChild(ai); a.appendChild(aprev);
      // 右上角删除按钮（点击移除该条对话，stopPropagation 避免触发详情弹窗）
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'mockchat__del';
      del.setAttribute('aria-label', '删除对话');
      del.title = '删除对话';
      del.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m2 0v14a1 1 0 01-1 1H6a1 1 0 01-1-1V6h14zM10 11v6M14 11v6"/></svg>';
      del.addEventListener('click', function (e) {
        e.stopPropagation(); e.preventDefault();
        var all = read(CHAT_KEY, []) || [];
        var di = all.findIndex(function (x) { return x && x.id === c.id; });
        if (di >= 0) { all.splice(di, 1); write(CHAT_KEY, all); }
        if (item.parentNode) item.parentNode.removeChild(item);
      });
      // 右下角"查看全文"提示
      var more = document.createElement('span');
      more.className = 'mockchat__more';
      more.textContent = '查看全文 \u203A';
      // 点击 / 回车 → 弹出完整对话
      item.addEventListener('click', function () { openChatModal(c); });
      item.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChatModal(c); }
      });
      item.appendChild(time); item.appendChild(q); item.appendChild(a); item.appendChild(del); item.appendChild(more);
      wrap.appendChild(item);
    });
    sec.appendChild(wrap);

    if (anchorSection && anchorSection.parentElement) {
      anchorSection.parentElement.insertBefore(sec, anchorSection.nextSibling);
    } else {
      main.appendChild(sec);
    }
  }

  function setAvatar() {
    var av = document.querySelector('.profile__avatar');
    if (!av) return;
    if (av.getAttribute('data-mock-avatar') === '1') return;
    var mu = read(USER_KEY, null);
    var src = (mu && mu.avatar) || '/avatars/test-user.png';
    av.setAttribute('data-mock-avatar', '1');
    av.style.overflow = 'hidden';
    var img = document.createElement('img');
    img.src = src;
    img.alt = (mu && mu.username) || '用户头像';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;';
    img.onerror = function () {
      if (img.parentNode) img.parentNode.removeChild(img);
      av.removeAttribute('data-mock-avatar');
    };
    av.innerHTML = '';
    av.appendChild(img);
  }

  function tick() {
    try {
      seed();
      syncUser();
      /* [CLEANUP] 个人中心登录页顶部的「演示模式」虚线提示框已按需求移除：不再注入 #mockDemoBannerLogin */
      addProfileBanner();   /* 仅个人中心（已登录）页保留演示提示；如需一并移除可注释此行 */
      addChats();
      setAvatar();
    } catch (e) { /* 静默失败，绝不污染主站功能 */ }
  }

  setInterval(tick, 800);
  tick();
})();
