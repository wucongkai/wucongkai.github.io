import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import { EditorError, previewPost, savePost, validateSlug } from './content.mjs';
import { deletePost, publishPost } from './publish.mjs';
import { previewSiteSection, readSiteSection, saveSiteSection, validateSection } from './site-content.mjs';
import { publishSiteSection } from './site-publish.mjs';
import { listOrderedPosts, movePost } from './post-order.mjs';
import { publishPostOrder } from './order-publish.mjs';

const editorDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.dirname(editorDirectory);
const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif' };
const sessionLifetime = 12 * 60 * 60 * 1000;

export function lanAddresses() {
  return [...new Set(Object.values(networkInterfaces()).flat().filter((address) => address && address.family === 'IPv4' && !address.internal).map((address) => address.address))];
}

async function readJSON(request) {
  if (request.headers['content-type'] !== 'application/json') throw new EditorError('请使用 JSON 请求。', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new EditorError('内容过大，请将图片作为独立文件引用。', 413);
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new EditorError('请求内容不是有效的 JSON。'); }
}

export async function createEditorServer({ root = defaultRoot, publisher = publishPost, deleter = deletePost, sitePublisher = publishSiteSection, orderPublisher = publishPostOrder, lan = false, password = '', addresses = [] } = {}) {
  if (lan && (typeof password !== 'string' || password.length < 12)) throw new EditorError('局域网访问口令至少需要 12 个字符。');
  root = await fs.realpath(root);
  const token = randomBytes(32).toString('hex');
  const passwordHash = createHash('sha256').update(password).digest();
  const sessions = new Map();
  const attempts = new Map();
  const workspace = createHash('sha256').update(root).digest('hex').slice(0, 16);
  let writing = false;
  let job = null;
  const assets = new Map([
    ['/', [path.join(editorDirectory, 'index.html'), 'text/html; charset=utf-8']],
    ['/login', [path.join(editorDirectory, 'login.html'), 'text/html; charset=utf-8']],
    ['/login.js', [path.join(editorDirectory, 'login.js'), 'text/javascript; charset=utf-8']],
    ['/editor.js', [path.join(editorDirectory, 'editor.js'), 'text/javascript; charset=utf-8']],
    ['/editor.css', [path.join(editorDirectory, 'editor.css'), 'text/css; charset=utf-8']],
    ['/site', [path.join(editorDirectory, 'site.html'), 'text/html; charset=utf-8']],
    ['/site-editor.js', [path.join(editorDirectory, 'site-editor.js'), 'text/javascript; charset=utf-8']],
    ['/site.css', [path.join(defaultRoot, 'app/globals.css'), 'text/css; charset=utf-8']],
    ['/favicon.svg', [path.join(defaultRoot, 'public/favicon.svg'), 'image/svg+xml']],
  ]);
  for (const [font, weight] of [['merienda-one', 400], ['kalam', 400], ['kalam', 700], ['fira-mono', 400]]) {
    const filename = `${font}-latin-${weight}-normal.woff2`;
    assets.set(`/fonts/${filename}`, [path.join(defaultRoot, 'node_modules/@fontsource', font, 'files', filename), 'font/woff2']);
  }

  const server = http.createServer(async (request, response) => {
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; img-src 'self' https: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'");
    try {
      const port = server.address().port;
      const hosts = ['127.0.0.1', 'localhost', ...(lan ? addresses : [])].map((address) => `${address}:${port}`);
      if (!hosts.includes(request.headers.host)) throw new EditorError('请使用终端显示的本机或局域网地址访问编辑器。', 403);
      const origin = `http://${request.headers.host}`;
      if (request.headers.origin && request.headers.origin !== origin) throw new EditorError('不允许跨站请求。', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new EditorError('不允许跨站请求。', 403);
      const url = new URL(request.url, origin);
      const now = Date.now();
      for (const [key, expiry] of sessions) if (expiry <= now) sessions.delete(key);
      for (const [key, attempt] of attempts) if (attempt.until <= now) attempts.delete(key);
      const cookieName = `wiki_editor_${port}`;
      const session = (request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const authenticated = !lan || Boolean(session && sessions.has(session));

      if (request.method === 'POST' && url.pathname === '/api/login') {
        if (request.headers.origin !== origin) throw new EditorError('不允许跨站登录。', 403);
        if (!lan) return send(200, { ok: true });
        const client = request.socket.remoteAddress;
        const attempt = attempts.get(client) || { count: 0, until: now + 5 * 60 * 1000 };
        if (attempt.count >= 10) throw new EditorError('口令错误次数过多，请 5 分钟后再试。', 429);
        const data = await readJSON(request);
        const matches = typeof data.password === 'string' && timingSafeEqual(passwordHash, createHash('sha256').update(data.password).digest());
        if (!matches) {
          attempt.count++;
          if (attempts.size >= 1000 && !attempts.has(client)) attempts.delete(attempts.keys().next().value);
          attempts.set(client, attempt);
          throw new EditorError('访问口令不正确，请查看启动编辑器的终端。', 401);
        }
        attempts.delete(client);
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        const credential = randomBytes(32).toString('hex');
        sessions.set(credential, now + sessionLifetime);
        response.setHeader('Set-Cookie', `${cookieName}=${credential}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}`);
        return send(200, { ok: true });
      }
      if (!authenticated && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/images/'))) {
        return send(401, { error: '请先输入访问口令。', requiresLogin: true });
      }
      if (request.method === 'GET') {
        if (url.pathname === '/api/session') return send(200, { token, workspace, mode: lan ? 'lan' : 'local' });
        if (url.pathname === '/api/posts') return send(200, await listOrderedPosts(root));
        if (url.pathname === '/api/status') return send(200, { job });
        if (url.pathname === '/api/site') return send(200, { entry: await readSiteSection(root, url.searchParams.get('section')) });
        let asset = assets.get(url.pathname);
        if (!asset && url.pathname.startsWith('/images/')) {
          const publicRoot = await fs.realpath(path.join(root, 'public'));
          const filename = await fs.realpath(path.resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`));
          const mime = mimeTypes[path.extname(filename).toLowerCase()];
          if (!filename.startsWith(publicRoot + path.sep) || !mime) throw new EditorError('图片路径无效。', 404);
          asset = [filename, mime];
        }
        if (!asset) throw new EditorError('页面不存在。', 404);
        const body = await fs.readFile(asset[0]);
        response.writeHead(200, { 'Content-Type': asset[1] });
        return response.end(body);
      }
      if (request.method !== 'POST') throw new EditorError('不支持的请求方法。', 405);
      if (request.headers.origin !== origin || request.headers['x-editor-token'] !== token) throw new EditorError('编辑器会话已失效，请刷新页面后重试。', 403);
      const data = await readJSON(request);
      if (url.pathname === '/api/logout') {
        sessions.delete(session);
        response.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/preview') {
        if (typeof data.content !== 'string' || data.content.length > 500000) throw new EditorError('正文格式不正确或过长。');
        try { return send(200, { html: await previewPost(data) }); }
        catch (error) { throw new EditorError(`正文暂时无法预览：${error.message}`, 422); }
      }
      if (url.pathname === '/api/site/preview') return send(200, { html: previewSiteSection(data.section, data.data) });
      if (['/api/order/move', '/api/order/publish'].includes(url.pathname)) {
        if (writing || job?.status === 'running') throw new EditorError('正在保存、发布或删除，请稍后再试。', 409);
        if (url.pathname === '/api/order/move') {
          writing = true;
          try { return send(200, await movePost(root, data)); }
          finally { writing = false; }
        }
        if (typeof data.version !== 'string') throw new EditorError('请先读取并调整文章顺序。');
        job = { operation: 'order', status: 'running', version: data.version, stage: '准备发布文章排序', log: '', commit: null };
        const activeJob = job;
        void Promise.resolve().then(() => orderPublisher(root, {
          version: data.version,
          report: (update) => { Object.assign(activeJob, { ...update, log: (activeJob.log + (update.log || '')).slice(-40000) }); },
        })).then((result) => { Object.assign(activeJob, result, { status: 'succeeded' }); })
          .catch((error) => { Object.assign(activeJob, { status: 'failed', stage: '排序发布未完成，本地顺序已保留', error: error.message }); });
        return send(202, { job });
      }
      if (['/api/site/save', '/api/site/publish'].includes(url.pathname)) {
        if (writing || job?.status === 'running') throw new EditorError('正在保存、发布或删除，请稍后再试。', 409);
        validateSection(data.section);
        if (url.pathname === '/api/site/save') {
          writing = true;
          try { return send(200, { entry: await saveSiteSection(root, data) }); }
          finally { writing = false; }
        }
        if (typeof data.version !== 'string') throw new EditorError('请先保存内容。');
        job = { operation: 'site', section: data.section, version: data.version, status: 'running', stage: '准备发布', log: '', commit: null };
        const activeJob = job;
        void Promise.resolve().then(() => sitePublisher(root, data.section, {
          version: data.version,
          report: (update) => { Object.assign(activeJob, { ...update, log: (activeJob.log + (update.log || '')).slice(-40000) }); },
        })).then((result) => { Object.assign(activeJob, result, { status: 'succeeded' }); })
          .catch((error) => { Object.assign(activeJob, { status: 'failed', stage: '发布未完成，本地内容已保留', error: error.message }); });
        return send(202, { job });
      }
      if (!['/api/save', '/api/publish', '/api/delete'].includes(url.pathname)) throw new EditorError('接口不存在。', 404);
      if (writing || job?.status === 'running') throw new EditorError('正在保存、发布或删除，请稍后再试。', 409);
      if (url.pathname === '/api/save') {
        writing = true;
        try { return send(200, { post: await savePost(root, data) }); }
        finally { writing = false; }
      }
      validateSlug(data.slug);
      if (typeof data.version !== 'string') throw new EditorError('请先保存文章。');
      const deleting = url.pathname === '/api/delete';
      if (deleting && data.confirmSlug !== data.slug) throw new EditorError('请先确认要删除的文章。');
      job = { operation: deleting ? 'delete' : 'publish', status: 'running', slug: data.slug, version: data.version, stage: deleting ? '准备删除文章' : '准备发布', log: '', commit: null };
      const activeJob = job;
      void Promise.resolve().then(() => (deleting ? deleter : publisher)(root, data.slug, {
        version: data.version,
        report: (update) => { Object.assign(activeJob, { ...update, log: (activeJob.log + (update.log || '')).slice(-40000) }); },
      })).then((result) => {
        Object.assign(activeJob, result, { status: 'succeeded' });
      }).catch((error) => {
        const stage = deleting ? activeJob.pushed ? '线上删除已推送，本地清理未完成' : '删除未完成，本地文章已保留' : '发布未完成，本地文章已保留';
        Object.assign(activeJob, { status: 'failed', stage, error: error.message });
      });
      return send(202, { job });
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      send(status, { error: error.message || '本地编辑器发生错误。' });
    }
  });
  server.requestTimeout = 30000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error('本地编辑器需要 Node.js 22 或更高版本。请先运行 nvm use 22（或 nvm use 24）。');
    process.exitCode = 1;
  } else {
    const port = Number(process.env.EDITOR_PORT || 4311);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('EDITOR_PORT 必须是 1–65535 之间的端口号。');
    const host = process.env.EDITOR_HOST || (process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1');
    if (!isIPv4(host)) throw new Error('EDITOR_HOST 请填写 IPv4 地址，例如 127.0.0.1、0.0.0.0 或 10.31.112.198。');
    const lan = host !== '127.0.0.1';
    const password = lan ? process.env.EDITOR_PASSWORD || randomBytes(12).toString('base64url') : '';
    const addresses = host === '0.0.0.0' ? lanAddresses() : [host];
    const server = await createEditorServer({ lan, password, addresses });
    server.on('error', (error) => {
      console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，可以使用 EDITOR_PORT=${port < 65535 ? port + 1 : 4311} npm run editor。` : error.message);
      process.exitCode = 1;
    });
    server.listen(port, host, () => {
      console.log(`\n写作台已启动：${host === '0.0.0.0' || host === '127.0.0.1' ? `http://127.0.0.1:${port}` : `http://${host}:${port}`}\n编辑完成后点击「保存并发布」，自动提交并推送当前内容。`);
      if (lan) console.log(`\n局域网地址：\n${addresses.map((address) => `  http://${address}:${port}`).join('\n')}\n访问口令：${password}\n请只与允许编辑、发布文章的人共享口令。会话有效期 12 小时，重启后需重新登录。`);
      console.log('\n按 Ctrl+C 关闭。\n');
    });
  }
}
