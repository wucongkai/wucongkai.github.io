import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { listPosts, previewPost, readPost, savePost } from './content.mjs';
import { createEditorServer } from './server.mjs';
import { buildSnapshot, deletePost, publishPost, run } from './publish.mjs';

const article = (slug = 'first-note') => ({ slug, title: '测试文章', date: '2026-09-13', description: '文章摘要', category: '学习笔记', draft: true, content: '## 小标题\n\n正文。\n', version: null });

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-editor-test-')));
  await fs.mkdir(path.join(root, 'content/posts'), { recursive: true });
  await fs.mkdir(path.join(root, 'public'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function repository(t) {
  const root = await fixture(t);
  const remote = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-remote-test-')));
  t.after(() => fs.rm(remote, { recursive: true, force: true }));
  const git = (args) => run('git', args, { cwd: root });
  await run('git', ['init', '--bare', remote]);
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Editor Test']);
  await git(['config', 'user.email', 'editor@example.test']);
  await savePost(root, { ...article(), draft: false });
  await fs.writeFile(path.join(root, 'README.md'), 'original\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.editor-trash/\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial site']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', '-u', 'origin', 'main']);
  const initialHead = await git(['rev-parse', 'HEAD']);
  const post = await savePost(root, { ...await readPost(root, 'first-note'), content: '## 更新后的正文\n\nhello\n' });
  return { root, remote, git, initialHead, post };
}

test('save and read Chinese articles, preserve extra metadata, list drafts, reject overwrite and stale versions', async (t) => {
  const root = await fixture(t);
  const post = await savePost(root, article());
  assert.equal(post.title, '测试文章');
  assert.equal((await listPosts(root))[0].draft, true);
  await assert.rejects(savePost(root, article()), { status: 409 });
  const filename = path.join(root, 'content/posts/first-note.mdx');
  await fs.appendFile(filename, '\n外部编辑\n');
  await assert.rejects(savePost(root, { ...post, title: '旧窗口的标题' }), { status: 409 });
  let text = await fs.readFile(filename, 'utf8');
  await fs.writeFile(filename, text.replace('---\n', '---\ncustom: keep-me\n'));
  const latest = await readPost(root, post.slug);
  await savePost(root, { ...latest, title: '新标题' });
  text = await fs.readFile(filename, 'utf8');
  assert.match(text, /custom: keep-me/);
  assert.equal((await readPost(root, post.slug)).title, '新标题');
});

test('reject invalid dates, path traversal and symlink writes', async (t) => {
  const root = await fixture(t);
  await assert.rejects(savePost(root, { ...article(), date: '2026-02-30' }), { status: 400 });
  await assert.rejects(savePost(root, { ...article(), slug: '../outside' }), { status: 400 });
  const outside = path.join(root, 'outside.mdx');
  await fs.writeFile(outside, 'must stay unchanged');
  await fs.symlink(outside, path.join(root, 'content/posts/link.mdx'));
  await assert.rejects(savePost(root, article('link')), { status: 400 });
  assert.equal(await fs.readFile(outside, 'utf8'), 'must stay unchanged');
});

test('an empty repository can create articles again after the last tracked article directory disappears', async (t) => {
  const root = await fixture(t);
  await fs.rmdir(path.join(root, 'content/posts'));
  await fs.rmdir(path.join(root, 'content'));
  assert.deepEqual(await listPosts(root), []);
  const post = await savePost(root, article('start-again'));
  assert.equal((await readPost(root, post.slug)).title, post.title);
});

test('preview shares GFM, code highlighting and MDX details with the public site', async () => {
  const html = await previewPost({ ...article(), title: '<unsafe>', content: '| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst n = 1;\n```\n\n<details><summary>展开</summary>正文</details>' });
  assert.match(html, /class="table-scroll"/);
  assert.match(html, /hljs-keyword/);
  assert.match(html, /<details>/);
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /script-src &#x27;none&#x27;/);
  await assert.rejects(previewPost({ ...article(), content: '<details>' }));
});

test('HTTP editor requires same-origin session tokens and serializes writes while publishing', async (t) => {
  const root = await fixture(t);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const server = await createEditorServer({ root, publisher: async () => { await pending; return { commit: 'abc1234' }; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { finish(); server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(`${origin}/api/session`).then((response) => response.json());
  const post = (route, data, headers = {}) => fetch(`${origin}${route}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Editor-Token': token, ...headers }, body: JSON.stringify(data) });
  assert.equal((await post('/api/save', article(), { 'X-Editor-Token': '' })).status, 403);
  assert.equal((await post('/api/save', article(), { Origin: 'https://other.example' })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    http.get(`${origin}/api/session`, { headers: { Host: 'other.example' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(wrongHost, 403);
  const response = await post('/api/save', article());
  assert.equal(response.status, 200);
  const { post: saved } = await response.json();
  assert.equal((await post('/api/publish', saved)).status, 202);
  assert.equal((await post('/api/save', { ...saved, title: 'busy' })).status, 409);
  assert.equal((await post('/api/publish', saved)).status, 409);
  assert.equal((await post('/api/delete', { ...saved, confirmSlug: saved.slug })).status, 409);
  finish();
});

test('LAN mode protects content, authenticates allowed IPs, saves after login and invalidates logout', async (t) => {
  const root = await fixture(t);
  const password = 'test-only-lan-password';
  const server = await createEditorServer({ root, lan: true, password, addresses: ['10.31.112.198'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const port = server.address().port;
  const transport = `http://127.0.0.1:${port}`;
  const host = `10.31.112.198:${port}`;
  const origin = `http://${host}`;
  const request = (route, data, headers = {}) => new Promise((resolve, reject) => {
    // http.request preserves an explicit Host header when testing an allowed LAN IP over loopback.
    const outgoing = http.request(`${transport}${route}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Host: host, Origin: origin, 'Content-Type': 'application/json', ...headers },
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: incoming.headers })));
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(data === undefined ? undefined : JSON.stringify(data));
  });
  assert.equal((await request('/login')).status, 200);
  for (const route of ['/api/session', '/api/posts', '/api/status', '/images/private.png']) {
    const response = await request(route);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).requiresLogin, true);
  }
  assert.equal((await request('/api/save', article())).status, 401);
  assert.equal((await request('/api/publish', article())).status, 401);
  assert.equal((await request('/api/delete', article())).status, 401);
  assert.equal((await request('/api/login', { password: 'wrong' })).status, 401);
  assert.equal((await request('/api/login', { password }, { Origin: 'https://other.example' })).status, 403);
  const login = await request('/api/login', { password });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  const auth = { Cookie: cookie };
  const session = await request('/api/session', undefined, auth).then((response) => response.json());
  assert.equal(session.mode, 'lan');
  assert.ok(session.token);
  assert.equal((await request('/api/posts', undefined, auth)).status, 200);
  assert.equal((await request('/api/save', article(), auth)).status, 403);
  assert.equal((await request('/api/delete', { ...article(), confirmSlug: 'first-note' }, auth)).status, 403);
  const response = await request('/api/save', article(), { ...auth, 'X-Editor-Token': session.token });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).post.title, article().title);
  assert.equal((await request('/api/logout', {}, { ...auth, 'X-Editor-Token': session.token })).status, 200);
  assert.equal((await request('/api/session', undefined, auth)).status, 401);
});

test('LAN mode requires a strong startup password and rate-limits repeated failed logins', async (t) => {
  const root = await fixture(t);
  await assert.rejects(createEditorServer({ root, lan: true }), /至少需要 12/);
  const server = await createEditorServer({ root, lan: true, password: 'test-only-lan-password' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (let index = 0; index < 11; index++) {
    const response = await fetch(`${origin}/api/login`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(response.status, index < 10 ? 401 : 429);
  }
});

test('publish validates and pushes exactly the current article, preserving unrelated staged edits and local drafts', async (t) => {
  const { root, remote, git, post } = await repository(t);
  await fs.writeFile(path.join(root, 'README.md'), 'unfinished change\n');
  await git(['add', 'README.md']);
  await savePost(root, article('unrelated-draft'));
  let checked = false;
  await publishPost(root, post.slug, { version: post.version, build: async (snapshot) => {
    assert.equal(await fs.readFile(path.join(snapshot, 'README.md'), 'utf8'), 'original\n');
    assert.match(await fs.readFile(path.join(snapshot, 'content/posts/first-note.mdx'), 'utf8'), /更新后的正文/);
    await assert.rejects(fs.stat(path.join(snapshot, 'content/posts/unrelated-draft.mdx')), { code: 'ENOENT' });
    checked = true;
  } });
  assert.equal(checked, true);
  assert.equal(await git(['diff', '--cached', '--name-only']), 'README.md');
  assert.equal(await run('git', ['--git-dir', remote, 'rev-parse', 'main']), await git(['rev-parse', 'HEAD']));
  assert.equal(await git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']), 'content/posts/first-note.mdx');
});

test('a failed build creates no commit or push and preserves the saved article', async (t) => {
  const { root, remote, git, post, initialHead } = await repository(t);
  await assert.rejects(publishPost(root, post.slug, { version: post.version, build: async () => { throw new Error('bad MDX'); } }), /bad MDX/);
  assert.equal(await git(['rev-parse', 'HEAD']), initialHead);
  assert.equal(await run('git', ['--git-dir', remote, 'rev-parse', 'main']), initialHead);
  assert.equal((await readPost(root, post.slug)).version, post.version);
  assert.equal(await git(['diff', '--cached', '--name-only']), '');
});

test('a rejected push can be retried without duplicate commits', async (t) => {
  const { root, remote, git, post } = await repository(t);
  const hook = path.join(remote, 'hooks/pre-receive');
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(publishPost(root, post.slug, { version: post.version, build: async () => {} }));
  const committed = await git(['rev-parse', 'HEAD']);
  await fs.rm(hook);
  await publishPost(root, post.slug, { version: post.version, build: async () => {} });
  assert.equal(await git(['rev-parse', 'HEAD']), committed);
  assert.equal(await run('git', ['--git-dir', remote, 'rev-parse', 'main']), committed);
});

test('publishing refuses unrelated pending commits and remote divergence', async (t) => {
  const { root, remote, git, post, initialHead } = await repository(t);
  await fs.writeFile(path.join(root, 'README.md'), 'a local commit\n');
  await git(['add', 'README.md']);
  await git(['commit', '-m', 'Unrelated change']);
  await assert.rejects(publishPost(root, post.slug, { version: post.version, build: async () => {} }), /其他未推送/);
  assert.equal(await run('git', ['--git-dir', remote, 'rev-parse', 'main']), initialHead);
  await git(['push', 'origin', 'main']);
  // Simulate local main being behind the remote while retaining the saved article.
  await git(['reset', '--mixed', initialHead]);
  await assert.rejects(publishPost(root, post.slug, { version: post.version, build: async () => {} }), /远程 main 有新提交/);
});

test('an external edit during the build prevents committing a different article version', async (t) => {
  const { root, git, post, initialHead } = await repository(t);
  await assert.rejects(publishPost(root, post.slug, { version: post.version, build: async () => {
    await fs.appendFile(path.join(root, 'content/posts/first-note.mdx'), '\nConcurrent edit\n');
  } }), /构建期间/);
  assert.equal(await git(['rev-parse', 'HEAD']), initialHead);
});

test('real Next.js builds publish and delete articles, including the final article', async (t) => {
  const { root, remote, git } = await repository(t);
  const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  for (const name of ['app', 'lib', 'public', 'site.config.ts', 'package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json', 'next-env.d.ts']) {
    await fs.cp(path.join(source, name), path.join(root, name), { recursive: true });
  }
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n.next/\nout/\n*.tsbuildinfo\n.editor-trash/\n');
  await fs.symlink(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  await git(['add', '.']);
  await git(['commit', '-m', 'Add website source']);
  await git(['push', 'origin', 'main']);
  const post = await savePost(root, { ...article('new-public-note'), draft: false });
  const result = await publishPost(root, post.slug, { version: post.version });
  assert.ok(result.commit);
  const published = await run('git', ['--git-dir', remote, 'show', 'main:content/posts/new-public-note.mdx']);
  assert.match(published, /测试文章/);
  assert.match(published, /draft: false/);
  await deletePost(root, post.slug, { version: post.version, build: async (snapshot, repositoryRoot, log) => {
    await buildSnapshot(snapshot, repositoryRoot, log);
    const home = await fs.readFile(path.join(snapshot, 'out/index.html'), 'utf8');
    assert.doesNotMatch(home, /\/notes\/new-public-note\//);
    await assert.rejects(fs.stat(path.join(snapshot, 'out/notes/new-public-note/index.html')), { code: 'ENOENT' });
    await fs.stat(path.join(snapshot, 'out/notes/first-note/index.html'));
  } });
  const last = await readPost(root, 'first-note');
  await deletePost(root, last.slug, { version: last.version, build: async (snapshot, repositoryRoot, log) => {
    await buildSnapshot(snapshot, repositoryRoot, log);
    const home = await fs.readFile(path.join(snapshot, 'out/index.html'), 'utf8');
    assert.match(home, /第一篇笔记正在整理中/);
    await assert.rejects(fs.stat(path.join(snapshot, 'out/notes/first-note/index.html')), { code: 'ENOENT' });
  } });
  assert.deepEqual(await listPosts(root), []);
  assert.equal(await run('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main', '--', 'content/posts']), '');
});

test('delete commits only the selected article, keeps a local backup and preserves unrelated staging', async (t) => {
  const { root, remote, git, post } = await repository(t);
  const source = await fs.readFile(path.join(root, 'content/posts/first-note.mdx'), 'utf8');
  await fs.writeFile(path.join(root, 'README.md'), 'unrelated staged work\n');
  await git(['add', 'README.md', 'content/posts/first-note.mdx']);
  await savePost(root, article('another-draft'));
  const result = await deletePost(root, post.slug, { version: post.version, build: async (snapshot) => {
    assert.equal((await readPost(root, post.slug)).version, post.version);
    assert.equal(await fs.readFile(path.join(snapshot, 'README.md'), 'utf8'), 'original\n');
    await assert.rejects(fs.stat(path.join(snapshot, 'content/posts/first-note.mdx')), { code: 'ENOENT' });
  } });
  assert.equal(result.deleted, true);
  assert.equal(await fs.readFile(path.join(root, result.backup), 'utf8'), source);
  assert.equal(await git(['check-ignore', result.backup]), result.backup);
  await assert.rejects(readPost(root, post.slug), { status: 404 });
  assert.equal(await git(['diff', '--cached', '--name-only']), 'README.md');
  assert.equal(await git(['diff-tree', '--no-commit-id', '--name-status', '-r', 'HEAD']), 'D\tcontent/posts/first-note.mdx');
  assert.equal(await run('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main', '--', 'content/posts/first-note.mdx']), '');
  assert.equal((await readPost(root, 'another-draft')).draft, true);
});

test('delete rejects stale versions and preserves files and history when its build fails', async (t) => {
  const { root, remote, git, post, initialHead } = await repository(t);
  await assert.rejects(deletePost(root, post.slug, { version: 'stale' }), { status: 409 });
  await assert.rejects(deletePost(root, post.slug, { version: post.version, build: async () => { throw new Error('delete build failed'); } }), /delete build failed/);
  assert.equal((await readPost(root, post.slug)).version, post.version);
  assert.equal(await git(['rev-parse', 'HEAD']), initialHead);
  assert.equal(await run('git', ['--git-dir', remote, 'rev-parse', 'main']), initialHead);
});

test('a failed deletion push keeps the article selectable and can be retried without a duplicate commit', async (t) => {
  const { root, remote, git, post, initialHead } = await repository(t);
  const hook = path.join(remote, 'hooks/pre-receive');
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(deletePost(root, post.slug, { version: post.version, build: async () => {} }));
  const committed = await git(['rev-parse', 'HEAD']);
  assert.notEqual(committed, initialHead);
  assert.equal((await readPost(root, post.slug)).version, post.version);
  assert.equal((await listPosts(root))[0].slug, post.slug);
  assert.equal(await run('git', ['--git-dir', remote, 'rev-parse', 'main']), initialHead);
  await fs.rm(hook);
  const result = await deletePost(root, post.slug, { version: post.version, build: async () => {} });
  assert.equal(result.deleted, true);
  assert.equal(await git(['rev-parse', 'HEAD']), committed);
  assert.equal(await run('git', ['--git-dir', remote, 'rev-parse', 'main']), committed);
  assert.equal((await fs.readdir(path.join(root, '.editor-trash'))).length, 1);
});

test('deleting an uncommitted draft keeps a backup without creating a commit or building', async (t) => {
  const { root, git, initialHead } = await repository(t);
  const post = await savePost(root, article('only-local'));
  await git(['add', 'content/posts/only-local.mdx']);
  const result = await deletePost(root, post.slug, { version: post.version, build: async () => { assert.fail('An uncommitted draft does not need a new website build'); } });
  assert.equal(result.localOnly, true);
  assert.equal(result.deleted, true);
  assert.equal(result.commit, null);
  assert.equal(await git(['rev-parse', 'HEAD']), initialHead);
  assert.equal(await git(['diff', '--cached', '--name-only']), '');
  assert.ok(await fs.readFile(path.join(root, result.backup), 'utf8'));
});

test('deleting preserves new local edits made after the checked snapshot is committed', async (t) => {
  const { root, git, post } = await repository(t);
  const hook = path.join(root, '.git/hooks/post-commit');
  await fs.writeFile(hook, '#!/bin/sh\nprintf "\\nA newer local edit\\n" >> content/posts/first-note.mdx\n', { mode: 0o755 });
  const result = await deletePost(root, post.slug, { version: post.version, build: async () => {} });
  assert.equal(result.localRetained, true);
  assert.equal(result.deleted, false);
  assert.match((await readPost(root, post.slug)).content, /A newer local edit/);
  assert.equal(await git(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'content/posts/first-note.mdx']), '');
});

test('HTTP deletion requires explicit confirmation and locks other mutations until completion', async (t) => {
  const root = await fixture(t);
  const post = await savePost(root, article());
  let finish;
  let called = false;
  const pending = new Promise((resolve) => { finish = resolve; });
  const server = await createEditorServer({ root, deleter: async (targetRoot, slug, options) => {
    assert.equal(targetRoot, root);
    assert.equal(slug, post.slug);
    assert.equal(options.version, post.version);
    called = true;
    await pending;
    return { deleted: true, localOnly: true };
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { finish(); server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(`${origin}/api/session`).then((response) => response.json());
  const send = (route, body, headers = {}) => fetch(origin + route, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Editor-Token': token, ...headers }, body: JSON.stringify(body),
  });
  assert.equal((await send('/api/delete', post)).status, 400);
  assert.equal(called, false);
  assert.equal((await send('/api/delete', { ...post, confirmSlug: post.slug }, { 'X-Editor-Token': '' })).status, 403);
  const response = await send('/api/delete', { ...post, confirmSlug: post.slug });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).job.operation, 'delete');
  assert.equal((await send('/api/save', post)).status, 409);
  assert.equal((await send('/api/publish', post)).status, 409);
  assert.equal((await send('/api/delete', { ...post, confirmSlug: post.slug })).status, 409);
  finish();
});
