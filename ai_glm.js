/* ============================================================
 * ai_glm.js —— 智谱 GLM-4-Flash 流式调用客户端（复用已调试逻辑）
 * ------------------------------------------------------------
 * 迁移自第二个项目的 ai-copilot.js 中已验证的 GLM-4-Flash 调用链路：
 *   · 端点  https://open.bigmodel.cn/api/paas/v4/  （OpenAI 兼容）
 *   · 模型  glm-4-flash
 *   · 流式   SSE（chat/completions?stream=true）
 *
 * 配置优先级：
 *   1) window.__AI_CONFIG__   （可由部署方覆盖，明文 key）
 *   2) globalThis.__AI_ENDPOINT__ （copilot 初始化写出，但 key 已脱敏，仅作展示）
 *   3) 内置默认值（与主站 copilot 完全一致，保证开箱即用）
 *
 * 提供 window.AiGlm.streamChat({messages,onThinking,onToken,onDone,onError,signal})
 *   —— 支持：思考态回调 / 逐字流式回调 / 完成回调 / 失败兜底回调 / 中断信号
 * ============================================================ */
(function () {
  'use strict';

  var DEFAULTS = {
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    apiKey: 'd5b8fbf4c6c640308b3096a7172d87ea.KLDxIKne9xLlmHnV',
    model: 'glm-4-flash'
  };

  function getConfig() {
    var cfg = (typeof window !== 'undefined' && window.__AI_CONFIG__) || {};
    var ep = (typeof globalThis !== 'undefined' && globalThis.__AI_ENDPOINT__) || {};
    var base = cfg.baseURL || DEFAULTS.baseURL;
    // 注意：copilot 写出的 __AI_ENDPOINT__.key 是脱敏后的（****），不可用于请求，
    // 故 key 始终以 window.__AI_CONFIG__ 或内置默认值为准。
    var key = cfg.apiKey || DEFAULTS.apiKey;
    var model = cfg.model || ep.model || DEFAULTS.model;
    var useMock = cfg.useMock !== undefined ? !!cfg.useMock : (!key || !base);
    return { baseURL: base, apiKey: key, model: model, useMock: useMock, mode: useMock ? 'mock' : 'real' };
  }

  // 失败兜底：保留已生成内容或给出友好提示，绝不白屏
  function fail(opts, msg) {
    if (opts.onError) opts.onError(msg);
    return false;
  }

  // 演示兜底（无 key / 接口异常时）：给出贴合纹样的拟真回答，保证体验不中断
  function mockStream(opts) {
    var onThinking = opts.onThinking || function () {};
    var onToken = opts.onToken || function () {};
    var onDone = opts.onDone || function () {};
    var full = '';
    var lastUser = '';
    var msgs = opts.messages || [];
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { lastUser = msgs[i].content || ''; break; }
    }
    var nameMatch = (lastUser.match(/【(.+?)】/) || [])[1] || '该纹样';
    var text =
      '（演示模式 · 未配置 API Key，以下为示例回答）\n\n' +
      '【' + nameMatch + '】是中国传统非遗纹样中的经典母题。其造型圆融流转、疏密有致，' +
      '常见于织锦、陶瓷与建筑装饰，寓意吉祥绵延、生生不息。\n\n' +
      '若用于衍生创新，可在保留其骨架韵律的基础上，融入当代配色与几何语言，' +
      '既承古意，又具新貌——例如以描金勾边、石青填地，转译为丝巾、潮玩或数字壁纸等载体。';
    onThinking();
    var idx = 0;
    var timer = setInterval(function () {
      if (idx >= text.length) {
        clearInterval(timer);
        onDone(full);
        return;
      }
      var step = Math.min(2 + Math.floor(Math.random() * 3), text.length - idx);
      var piece = text.slice(idx, idx + step);
      idx += step;
      full += piece;
      onToken(piece);
    }, 18);
    return true;
  }

  async function streamChat(opts) {
    opts = opts || {};
    var cfg = getConfig();
    if (cfg.useMock || !cfg.apiKey || !cfg.baseURL) {
      return mockStream(opts);
    }

    var onThinking = opts.onThinking || function () {};
    var onToken = opts.onToken || function () {};
    var onDone = opts.onDone || function () {};
    var onError = opts.onError || function () {};

    onThinking();
    var url = String(cfg.baseURL).replace(/\/+$/, '') + '/chat/completions';
    var payload = {
      model: cfg.model,
      messages: opts.messages || [],
      stream: true,
      temperature: 0.85,
      max_tokens: 1200
    };

    var resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.apiKey
        },
        body: JSON.stringify(payload),
        signal: opts.signal
      });
    } catch (e) {
      return fail(opts, '网络连接失败，请检查网络后重试。');
    }

    if (!resp.ok) {
      var hint = resp.status === 401 ? 'API Key 无效或已失效' :
        resp.status === 429 ? '请求过于频繁，请稍后再试' :
        'AI 服务暂时不可用（' + resp.status + '）';
      return fail(opts, hint + '，稍后重试即可。');
    }

    var reader, decoder, buf = '', full = '';
    try {
      reader = resp.body.getReader();
      decoder = new TextDecoder('utf-8');
    } catch (e) {
      return fail(opts, '当前环境不支持流式读取，请更换现代浏览器。');
    }

    try {
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        buf += decoder.decode(r.value, { stream: true });
        var parts = buf.split('\n');
        buf = parts.pop();
        for (var k = 0; k < parts.length; k++) {
          var line = parts[k].trim();
          if (!line) continue;
          if (line.indexOf('data:') === 0) line = line.slice(5).trim();
          if (line === '[DONE]') continue;
          if (!line) continue;
          try {
            var j = JSON.parse(line);
            var delta = j.choices && j.choices[0] && j.choices[0].delta;
            var content = delta && delta.content;
            if (content) { full += content; onToken(content); }
          } catch (_) { /* 跨包分包 JSON，忽略残片 */ }
        }
      }
      onDone(full);
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') { onDone(full); return true; }
      if (full) { onDone(full); return true; } // 已生成部分内容则尽量保留
      return fail(opts, '生成过程被中断，请点击重试。');
    }
  }

  // 连通性自检（用于面板状态展示）
  async function probe() {
    var cfg = getConfig();
    if (cfg.useMock || !cfg.apiKey || !cfg.baseURL) return { ok: false, mock: true };
    try {
      // 改为探测同源根路径，避免浏览器直连智谱 API（内置 Key 失效会触发 401）
      var r = await fetch('/', { cache: 'no-store' });
      return { ok: r.ok, mock: false };
    } catch (e) {
      return { ok: false, mock: false };
    }
  }

  window.AiGlm = { streamChat: streamChat, getConfig: getConfig, probe: probe };
})();
