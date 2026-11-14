/* ==========================================================================
   [MAP-CULTURE-FILTER] 纹样地图 · 文化归类联动筛选（考古学严谨性）
   --------------------------------------------------------------------------
   背景：本站 /map 为打包后的 Vue3 组件，生产实例不可访问，底层 mock 区域
        数据只有「现代民族」字段，没有史前考古学文化字段。因此这里采用
        DOM 注入 + 幂等 tick 保活，不改动任何 Vue 源码与站内数据文件。

   实现：
     1. 图层按钮「民族」视觉更名「文化/族群」（CSS 伪元素为主，JS 兜底同步文本）
     2. 在「朝代」下拉右侧注入「文化归类」下拉，注入节点带
        data-v-a1c08584 属性以复用站内 MapFilters 的 scoped 样式
     3. 维度联动：
        · 新石器（neolithic）→ 史前考古学文化（仰韶 / 马家窑 / 大汶口 /
          红山 / 良渚 / 崧泽），选项内绝不出现「苗族 / 汉族」等现代民族
        · 其余历史朝代 → 民族 / 族群（沿用站内 mock 的 7 类）
        · 全部朝代 → 禁用并显示占位，避免出现不严谨的跨期组合
     4. 选中后：高亮对应区域散点、淡化其余、展示考古学信息卡；
        被 mock 按朝代过滤掉的区域，用虚线「演示补充点位」兜底
     5. 「清空筛选」/ 路由切换自动复位

   作用域：仅 /map 且存在 .china-map__stage；离开页面主动清理。
   ========================================================================== */
(function () {
  'use strict';

  var CSS_HREF = '/assets/map-culture-filter.css?v=20261110culture3';
  var SCOPE = 'data-v-a1c08584';
  var SEL_ID = 'wbCultureSelect';
  var DIM_ID = 'wbCultureDim';
  var INFO_ID = 'wbCultureInfo';
  var GROUP_CLASS = 'wb-cf-group';
  var TICK_MS = 650;
  var SVGNS = 'http://www.w3.org/2000/svg';

  /* ----------------------------------------------------------------------
     15 个区域：坐标取自运行时 .map-marker 的 transform（切换朝代后稳定，
     只是子集），用于把 SVG 散点反向映射回区域 id。
     ---------------------------------------------------------------------- */
  var REGIONS = [
    { id: 'beijing',   name: '北京',   x: 693.8, y: 296.5 },
    { id: 'yunnan',    name: '云南',   x: 479.7, y: 609.7 },
    { id: 'guizhou',   name: '贵州',   x: 542.2, y: 576.1 },
    { id: 'jiangsu',   name: '江苏',   x: 731.3, y: 462.6 },
    { id: 'zhejiang',  name: '浙江',   x: 753.1, y: 498.3 },
    { id: 'sichuan',   name: '四川',   x: 501.6, y: 489.9 },
    { id: 'tibet',     name: '西藏',   x: 298.4, y: 513.0 },
    { id: 'xinjiang',  name: '新疆',   x: 243.7, y: 214.5 },
    { id: 'shaanxi',   name: '陕西',   x: 576.6, y: 414.2 },
    { id: 'henan',     name: '河南',   x: 650.0, y: 403.7 },
    { id: 'guangdong', name: '广东',   x: 645.3, y: 649.7 },
    { id: 'hunan',     name: '湖南',   x: 639.1, y: 542.5 },
    { id: 'shandong',  name: '山东',   x: 703.1, y: 363.7 },
    { id: 'gansu',     name: '甘肃',   x: 496.9, y: 376.4 },
    { id: 'neimenggu', name: '内蒙古', x: 620.3, y: 277.5 }
  ];

  /* ----------------------------------------------------------------------
     史前考古学文化（依据站内 dynasties 数据「新石器」文案：
     仰韶 / 马家窑 / 大汶口与崧泽 / 红山 / 良渚）
     ---------------------------------------------------------------------- */
  var PRE = [
    { id: 'yangshao', name: '仰韶文化',   era: '距今约 7000–5000 年', area: '黄河中游 · 陕西、河南、陇东',
      pts: ['shaanxi', 'henan', 'gansu'], marks: '人面鱼纹、鱼纹、花瓣纹',
      desc: '彩陶鼎盛，鱼纹由写实渐趋几何化，是最早的成体系纹样之一' },
    { id: 'majiayao', name: '马家窑文化', era: '距今约 5000–4000 年', area: '黄河上游 · 甘肃、青东',
      pts: ['gansu', 'sichuan'], marks: '漩涡纹、回纹、蛙纹',
      desc: '以流转线条写水波，漩涡纹被视为回纹类几何母题的源头' },
    { id: 'dawenkou', name: '大汶口文化', era: '距今约 6300–4500 年', area: '海岱地区 · 山东、苏北、豫东',
      pts: ['shandong', 'jiangsu', 'henan'], marks: '八角星纹、编织纹',
      desc: '八角星纹被视作早期宇宙观图式，常见于陶器与玉器' },
    { id: 'hongshan', name: '红山文化',   era: '距今约 6500–5000 年', area: '西辽河上游 · 内蒙古东南',
      pts: ['neimenggu'], marks: '玉龙、勾云纹、勾连纹',
      desc: '玉器礼制初现，卷曲勾连的云形母题影响后世云纹' },
    { id: 'liangzhu', name: '良渚文化',   era: '距今约 5300–4300 年', area: '环太湖 · 浙江、江苏',
      pts: ['zhejiang', 'jiangsu'], marks: '神人兽面纹、兽面纹',
      desc: '微刻神徽具有强烈宗教性，是兽面纹谱系的远端源头' },
    { id: 'songze',   name: '崧泽文化',   era: '距今约 6000–5300 年', area: '环太湖 · 江苏、浙江',
      pts: ['jiangsu', 'zhejiang'], marks: '八角星纹、编织纹、圆点纹',
      desc: '良渚之前身，陶器几何印纹与刻划纹渐兴' }
  ];

  /* ----------------------------------------------------------------------
     历史时期民族 / 族群（沿用站内 mock 的 ethnicGroups / 图例色表 7 类）
     ---------------------------------------------------------------------- */
  var ETH = [
    { id: 'han',    name: '汉族',     era: '历史时期 · 分布最广', area: '中原及东部各省',
      pts: ['beijing', 'jiangsu', 'zhejiang', 'sichuan', 'shaanxi', 'henan', 'guangdong', 'hunan', 'shandong', 'gansu'],
      marks: '龙纹、云纹、回纹、缠枝纹', desc: '纹样高度程式化，「图必有意，意必吉祥」' },
    { id: 'miao',   name: '苗族',     era: '历史时期 · 西南山地', area: '贵州、云南、湖南',
      pts: ['guizhou', 'yunnan', 'hunan'], marks: '蝴蝶妈妈纹、涡妥纹、龙纹',
      desc: '以服饰为载体，纹样承担族群记忆与迁徙叙事' },
    { id: 'bai',    name: '白族',     era: '历史时期 · 滇西', area: '云南大理一带',
      pts: ['yunnan'], marks: '扎染蝴蝶纹、几何连续纹',
      desc: '扎染以针缝防染，形成自然冰裂与晕染边界' },
    { id: 'zang',   name: '藏族',     era: '历史时期 · 青藏高原', area: '西藏、川西',
      pts: ['tibet', 'sichuan'], marks: '八宝纹、卷草纹、金刚纹',
      desc: '纹样与宗教仪轨紧密相扣，构图讲究对称与满铺' },
    { id: 'uyghur', name: '维吾尔族', era: '历史时期 · 西域', area: '新疆',
      pts: ['xinjiang'], marks: '巴旦木纹、艾德莱斯纹',
      desc: '丝路织染，几何骨架与植物纹样交融' },
    { id: 'mongol', name: '蒙古族',   era: '历史时期 · 北方草原', area: '内蒙古',
      pts: ['neimenggu'], marks: '盘长纹、犄角纹、云纹',
      desc: '连续盘长寓吉祥绵延，犄角纹源出游牧生活' },
    { id: 'hui',    name: '回族',     era: '历史时期 · 西北', area: '甘肃、新疆',
      pts: ['gansu', 'xinjiang'], marks: '几何纹、阿拉伯书法纹',
      desc: '尚几何与文字装饰，题材避具象，讲究无限连续' }
  ];

  var DIM = {
    pre: {
      seal: '考', tag: '史前 · 考古学文化', options: PRE,
      note: '史前时期尚无现代民族概念，故按「考古学文化」划分；「汉族 / 苗族」等现代民族称谓不适用于此期。'
    },
    eth: {
      seal: '族', tag: '历史时期 · 民族/族群', options: ETH,
      note: '进入历史时期后，依文献可考的民族 / 族群归类；此维度与史前考古学文化不可混用。'
    }
  };

  /* 只有新石器属史前；其余非空朝代均按历史时期处理 */
  var PRE_DYNASTIES = ['neolithic'];

  var state = { dyn: '', dim: null, chosen: '' };
  var installed = false;
  var lastGhostSig = 'init';
  var boundSels = [];

  /* ---------------------------- 工具 ---------------------------- */
  function q(sel, root) { return (root || document).querySelector(sel); }
  function pathNow() { return location.pathname.replace(/\/+$/, ''); }
  function dimFor(dyn) {
    if (!dyn) return null;
    return PRE_DYNASTIES.indexOf(dyn) >= 0 ? 'pre' : 'eth';
  }
  function regionById(id) {
    for (var i = 0; i < REGIONS.length; i++) if (REGIONS[i].id === id) return REGIONS[i];
    return null;
  }
  function regionName(id) { var r = regionById(id); return r ? r.name : id; }
  function regionIdOf(marker) {
    var t = marker.getAttribute('transform') || '';
    var mm = t.match(/translate\(\s*([\d.]+)\s+([\d.]+)\s*\)/);
    if (!mm) return null;
    var x = parseFloat(mm[1]), y = parseFloat(mm[2]);
    for (var i = 0; i < REGIONS.length; i++) {
      if (Math.abs(REGIONS[i].x - x) < 0.6 && Math.abs(REGIONS[i].y - y) < 0.6) return REGIONS[i].id;
    }
    return null;
  }
  function currentChosen() {
    if (!state.chosen || !state.dim || !DIM[state.dim]) return null;
    var list = DIM[state.dim].options;
    for (var i = 0; i < list.length; i++) if (list[i].id === state.chosen) return list[i];
    return null;
  }

  /* ------------------------ 样式兜底注入 ------------------------ */
  function ensureCss() {
    var found = false, links = document.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < links.length; i++) {
      if ((links[i].getAttribute('href') || '').indexOf('map-culture-filter.css') >= 0) { found = true; break; }
    }
    if (found) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = CSS_HREF;
    document.head.appendChild(l);
  }

  /* --------------------- 1) 更名「民族」按钮 --------------------- */
  function renameEthBtn() {
    var seg = q('.map-filters__seg');
    if (!seg) return;
    var b = seg.children[3];
    if (b && b.textContent.trim() === '民族') b.textContent = '文化/族群';
  }

  /* --------------------- 2) 注入「文化归类」下拉 --------------------- */
  function ensureGroup(bar, dynSel) {
    if (q('.' + GROUP_CLASS, bar)) return false;

    var g = document.createElement('div');
    g.className = 'map-filters__group ' + GROUP_CLASS;
    g.setAttribute(SCOPE, '');

    var label = document.createElement('span');
    label.className = 'map-filters__label';
    label.setAttribute(SCOPE, '');
    label.textContent = '文化归类';

    var sel = document.createElement('select');
    sel.className = 'map-filters__select wb-cf-select';
    sel.setAttribute(SCOPE, '');
    sel.id = SEL_ID;

    var dim = document.createElement('span');
    dim.className = 'wb-cf-dim is-idle';
    dim.id = DIM_ID;
    dim.textContent = '随朝代联动';

    g.appendChild(label);
    g.appendChild(sel);
    g.appendChild(dim);

    /* 插到「朝代」group 之后、清空按钮（或其注释占位）之前 */
    var dynGroup = dynSel.closest ? dynSel.closest('.map-filters__group') : null;
    var anchor = dynGroup ? dynGroup.nextSibling : null;
    if (anchor && anchor.parentNode === bar) bar.insertBefore(g, anchor);
    else bar.appendChild(g);

    if (boundSels.indexOf(sel) < 0) {
      boundSels.push(sel);
      sel.addEventListener('change', function () {
        state.chosen = sel.value || '';
        render();
      });
    }
    return true;
  }

  /* --------------------- 3) 注入信息卡 --------------------- */
  function ensureInfo(bar) {
    if (document.getElementById(INFO_ID)) return false;

    var info = document.createElement('div');
    info.className = 'wb-cf-info';
    info.id = INFO_ID;
    info.innerHTML =
      '<div class="wb-cf-info__seal"></div>' +
      '<div class="wb-cf-info__body">' +
        '<div class="wb-cf-info__head">' +
          '<span class="wb-cf-info__title"></span>' +
          '<span class="wb-cf-info__era"></span>' +
          '<span class="wb-cf-info__tag"></span>' +
        '</div>' +
        '<div class="wb-cf-info__lines"></div>' +
        '<div class="wb-cf-info__note"></div>' +
      '</div>' +
      '<button class="wb-cf-info__close" type="button" aria-label="收起文化归类说明">×</button>';

    if (bar.nextSibling) bar.parentNode.insertBefore(info, bar.nextSibling);
    else bar.parentNode.appendChild(info);

    q('.wb-cf-info__close', info).addEventListener('click', function () {
      var s = document.getElementById(SEL_ID);
      if (s) s.value = '';
      state.chosen = '';
      render();
    });
    return true;
  }

  /* --------------------- 4) 按朝代重建选项 --------------------- */
  function syncOptions(dyn) {
    var sel = document.getElementById(SEL_ID);
    var dimEl = document.getElementById(DIM_ID);
    if (!sel || !dimEl) return;

    var d = dimFor(dyn);
    state.dim = d;
    state.chosen = '';

    if (!d) {
      sel.innerHTML = '<option value="">请先选择朝代</option>';
      sel.value = '';
      sel.disabled = true;
      sel.title = '请先选择朝代，以匹配对应的文化归类维度';
      dimEl.className = 'wb-cf-dim is-idle';
      dimEl.textContent = '随朝代联动';
      return;
    }

    var html = '<option value="">全部' + (d === 'pre' ? '考古学文化' : '民族 / 族群') + '</option>';
    for (var i = 0; i < DIM[d].options.length; i++) {
      html += '<option value="' + DIM[d].options[i].id + '">' + DIM[d].options[i].name + '</option>';
    }
    sel.innerHTML = html;
    sel.value = '';
    sel.disabled = false;
    sel.title = DIM[d].tag;
    dimEl.className = 'wb-cf-dim' + (d === 'pre' ? ' is-pre' : '');
    dimEl.textContent = d === 'pre' ? '史前文化' : '民族 / 族群';
  }

  /* --------------------- 5) 信息卡 + 散点高亮 --------------------- */
  function fillInfo(info, c, d, ghostCount) {
    q('.wb-cf-info__seal', info).textContent = DIM[d].seal;
    q('.wb-cf-info__title', info).textContent = c.name;
    q('.wb-cf-info__era', info).textContent = c.era;
    q('.wb-cf-info__tag', info).textContent = DIM[d].tag;
    var pts = [];
    for (var i = 0; i < c.pts.length; i++) pts.push(regionName(c.pts[i]));
    q('.wb-cf-info__lines', info).innerHTML =
      '<div><b>主要分布</b>　' + c.area + '</div>' +
      '<div><b>代表纹样</b>　' + c.marks + '</div>' +
      '<div><b>纹样特征</b>　' + c.desc + '</div>' +
      '<div><b>本站演示点位</b>　' + pts.join('、') + '</div>';
    var note = '※ ' + DIM[d].note;
    /* 只有确实补了虚线点位时才解释它，避免无中生有的说明 */
    if (ghostCount > 0) note += '　（虚线圈为本站演示补充点位，底层 mock 未按朝代收录该区域）';
    q('.wb-cf-info__note', info).textContent = note;
  }

  function markerParent() {
    var m = q('.map-marker');
    return m ? m.parentElement : null;
  }
  function makeGhost(r, id, sole) {
    var g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'wb-cf-ghost' + (sole ? ' is-sole' : ''));
    g.setAttribute('transform', 'translate(' + r.x + ' ' + r.y + ')');
    g.setAttribute('data-wb-cf-ghost', id);
    var ring = document.createElementNS(SVGNS, 'circle');
    ring.setAttribute('class', 'wb-cf-ghost__ring');
    ring.setAttribute('r', '34');
    var core = document.createElementNS(SVGNS, 'circle');
    core.setAttribute('class', 'wb-cf-ghost__core');
    core.setAttribute('r', '9');
    g.appendChild(ring);
    g.appendChild(core);
    return g;
  }
  function clearGhosts() {
    var gs = document.querySelectorAll('.wb-cf-ghost');
    for (var i = 0; i < gs.length; i++) {
      if (gs[i].parentNode) gs[i].parentNode.removeChild(gs[i]);
    }
  }

  function highlight(chosen) {
    var markers = document.querySelectorAll('.map-marker');
    var wanted = {}, existing = {}, i, id, m, hlCount = 0;
    if (chosen) for (i = 0; i < chosen.pts.length; i++) wanted[chosen.pts[i]] = 1;

    /* 先扫描一遍：统计真实命中数 + 现存区域，判定是否需要柔和降级 */
    for (i = 0; i < markers.length; i++) {
      id = regionIdOf(markers[i]);
      if (id) existing[id] = 1;
      if (id && wanted[id]) hlCount++;
    }
    var need = [];
    if (chosen) {
      for (i = 0; i < chosen.pts.length; i++) if (!existing[chosen.pts[i]]) need.push(chosen.pts[i]);
    }
    var soft = !!(chosen && hlCount === 0 && need.length > 0);

    /* class 每轮幂等刷新：Vue 重渲染可能重写 className */
    for (i = 0; i < markers.length; i++) {
      m = markers[i];
      id = regionIdOf(m);
      m.classList.remove('wb-cf-hl', 'wb-cf-dim', 'wb-cf-dim-soft');
      if (chosen) {
        if (id && wanted[id]) m.classList.add('wb-cf-hl');
        else m.classList.add(soft ? 'wb-cf-dim-soft' : 'wb-cf-dim');
      }
    }

    /* 补充点位：仅在需求集合 / 降级状态变化时重建，避免每轮重置虚线动画 */
    var sig = (chosen ? chosen.id : '-') + '|' + (soft ? 'soft' : '') + '|' + need.join(',');
    if (sig !== lastGhostSig || document.querySelectorAll('.wb-cf-ghost').length !== need.length) {
      lastGhostSig = sig;
      clearGhosts();
      var svgG = markerParent();
      if (svgG && chosen) {
        for (i = 0; i < need.length; i++) {
          var r = regionById(need[i]);
          if (r) svgG.appendChild(makeGhost(r, need[i], soft));
        }
      }
    }
    return need.length;
  }

  function render() {
    var info = document.getElementById(INFO_ID);
    var chosen = currentChosen();
    var ghostCount = highlight(chosen);
    if (info) {
      if (chosen) { fillInfo(info, chosen, state.dim, ghostCount); info.classList.add('is-on'); }
      else info.classList.remove('is-on');
    }
  }

  /* --------------------- 6) 清理（离开 /map） --------------------- */
  function cleanup() {
    var g = q('.' + GROUP_CLASS); if (g && g.parentNode) g.parentNode.removeChild(g);
    var info = document.getElementById(INFO_ID); if (info && info.parentNode) info.parentNode.removeChild(info);
    clearGhosts();
    var ms = document.querySelectorAll('.map-marker');
    for (var i = 0; i < ms.length; i++) ms[i].classList.remove('wb-cf-hl', 'wb-cf-dim', 'wb-cf-dim-soft');
    state = { dyn: '', dim: null, chosen: '' };
    lastGhostSig = 'reset';
    boundSels = [];
  }

  /* --------------------- 7) tick 保活 --------------------- */
  function bindDynasty(dynSel) {
    if (dynSel.__wbCfBound) return;
    dynSel.__wbCfBound = 1;
    dynSel.addEventListener('change', function () {
      state.dyn = dynSel.value || '';
      syncOptions(state.dyn);
      render();
    });
  }

  function tick() {
    if (pathNow() !== '/map' || !q('.china-map__stage')) {
      if (installed) { cleanup(); installed = false; }
      return;
    }
    var bar = q('.map-filters');
    var dynSel = q('.map-filters__select');
    if (!bar || !dynSel) return;

    installed = true;
    ensureCss();
    renameEthBtn();
    var created = ensureGroup(bar, dynSel);
    ensureInfo(bar);
    bindDynasty(dynSel);

    var dyn = dynSel.value || '';
    if (created || dyn !== state.dyn) {
      state.dyn = dyn;
      syncOptions(dyn);
      render();
    } else {
      /* Vue 重渲染可能清掉高亮 class / 移除补充点位，这里幂等刷新 */
      highlight(currentChosen());
    }
  }

  function boot() {
    tick();
    setInterval(tick, TICK_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
