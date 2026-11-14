/* 生产静态服务器：托管非遗纹样数字博物馆（含 SPA history 路由回退） */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
// 静态资源与 3D 模型独立存放在项目根的 04 目录，按 URL 前缀映射到这里，
// 前端代码与打包产物中的 /patterns、/models 等绝对路径无需任何改动。
const ASSET_ROOT = path.join(ROOT, '..', '04_静态资源与3D模型');
const ASSET_PREFIXES = ['patterns', 'models', 'avatars', 'artifacts', 'fonts'];
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json'
};

function send(res, code, type, data, cache) {
  // HTML / JS / CSS 不缓存，保证改动立即生效（避免浏览器沿用旧的 admin_gate.js 等）；
  // 图片 / 字体等长尾静态资源仍可长缓存。
  const directive = cache !== undefined ? cache
    : (type && /text\/html|javascript|css/.test(type) ? 'no-cache' : 'public, max-age=3600');
  res.writeHead(code, {
    'Content-Type': type || 'application/octet-stream',
    'Cache-Control': directive
  });
  res.end(data);
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  const seg = urlPath.split('/')[1] || '';
  const baseDir = ASSET_PREFIXES.includes(seg) ? ASSET_ROOT : ROOT;
  let filePath = path.join(baseDir, urlPath);
  if (!filePath.startsWith(baseDir)) return send(res, 403, 'text/plain', 'forbidden');

  // ── 管理后台：/admin 及其子路由（/admin/login、/admin/dashboard 等）
  //    回退到后台 SPA；/admin/*.js 等真实文件仍按静态文件服务 ──
  const isAdminRoute = urlPath === '/admin' || urlPath.startsWith('/admin/');
  const isAdminAsset = isAdminRoute && !!path.extname(urlPath) && fs.existsSync(filePath);
  if (isAdminRoute && !isAdminAsset) {
    const adminFile = path.join(ROOT, 'admin', 'index.html');
    if (fs.existsSync(adminFile)) {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(adminFile));
    }
  }
  // ── 纹样素材清单接口（供后台统计 / 素材墙使用） ──
  if (urlPath === '/api/patterns') {
    try {
      const dir = path.join(ASSET_ROOT, 'patterns');
      const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.webp'));
      return send(res, 200, 'application/json; charset=utf-8',
        JSON.stringify({ total: files.length, files }));
    } catch (e) {
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ total: 0, files: [] }));
    }
  }

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      return send(res, 200, MIME[ext] || 'application/octet-stream', fs.readFileSync(filePath));
    }
    // ── AI 对话演示页：/demo 直接返回自包含的 ai-chat 演示组件 ──
  if (urlPath === '/demo') {
    const demoFile = path.join(ROOT, 'demo.html');
    if (fs.existsSync(demoFile)) {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(demoFile));
    }
  }
  // ── 融合版工作台：链接2 红壳 + 链接1 真实逻辑（标签联动 / ReAct / 视觉）──
  if (urlPath === '/workshop') {
    const wsFile = path.join(ROOT, 'ai-workshop.html');
    if (fs.existsSync(wsFile)) {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(wsFile));
    }
  }

  // ── API 反向代理：/api/* 转发到本地后端 8000 ──
  //    这样页面与接口同源（都由本 server 提供），彻底解决外网/跨设备访问与 CORS 问题。
  if (urlPath.startsWith('/api/')) {
    const options = {
      host: '127.0.0.1',
      port: 8000,
      path: req.url,                       // 含 query string，原样转发给后端
      method: req.method,
      headers: { ...req.headers, host: '127.0.0.1:8000' }
    };
    const proxyReq = http.request(options, (proxyRes) => {
      // 真流式直透：不做任何 buffer / 攒批。立即下发响应头，禁用 Nagle 与
      // 中间层缓冲，保证后端第一个 token 能立刻到达浏览器。
      const hdrs = { ...proxyRes.headers };
      delete hdrs['content-length'];       // 交给 Node 用 chunked，避免按长度攒包
      delete hdrs['transfer-encoding'];
      hdrs['Cache-Control'] = 'no-cache, no-store, no-transform, must-revalidate';
      hdrs['X-Accel-Buffering'] = 'no';   // 关掉 Nginx 类反代的 proxy_buffering
      hdrs['Connection'] = 'keep-alive';
      res.writeHead(proxyRes.statusCode, hdrs);
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
      proxyRes.pipe(res);                 // 边收边转，零缓冲
    });
    proxyReq.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('后端服务暂不可用（8000）：' + e.message);
    });
    req.pipe(proxyReq);
    return;
  }

  // SPA 回退：无扩展名的路由请求统一返回 index.html
    if (!path.extname(urlPath)) {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(ROOT, 'index.html')));
    }
    return send(res, 404, 'text/plain', 'not found');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`纹以载道·数启新章 已启动: http://${HOST}:${PORT}`);
});
