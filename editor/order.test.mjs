import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPost, savePost, listPosts } from './content.mjs';
import { listOrderedPosts, movePost } from './post-order.mjs';
import { publishPostOrder } from './order-publish.mjs';
import { enablePostOrder } from './order-support.mjs';
import { parsePostOrder, sortPosts } from '../lib/post-order.mjs';
import { buildSnapshot, run } from './publish.mjs';
import { createEditorServer } from './server.mjs';

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const article = (slug, date = '2026-09-13') => ({ slug, title: `文章 ${slug}`, date, category: '笔记', description: '', content: '正文原样保留。', draft: false, version: null });
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-order-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await savePost(root, article('newer-note', '2026-09-14'));
  await savePost(root, article('older-note', '2026-09-12'));
  return root;
}
async function move(root, slug, direction) {
  return movePost(root, { slug, direction, version: (await listOrderedPosts(root)).orderVersion });
}
async function repository(t) {
  const root = await fixture(t);
  const remote = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-order-remote-')));
  t.after(() => fs.rm(remote, { recursive: true, force: true }));
  const git = (args) => run('git', args, { cwd: root });
  for (const name of ['app', 'lib', 'public', 'site.config.ts', 'package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json', 'next-env.d.ts']) await fs.cp(path.join(sourceRoot, name), path.join(root, name), { recursive: true });
  // Start from the previously deployed date-only reader, without its new helper.
  let reader = await fs.readFile(path.join(root, 'lib/posts.ts'), 'utf8');
  reader = reader.replace("import { readPostOrder, sortPosts } from './post-order.mjs';\n", '')
    .replace('  return sortPosts(posts.filter((post) => !post.draft), await readPostOrder(process.cwd()));', '  return posts.filter((post) => !post.draft).sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));');
  await fs.writeFile(path.join(root, 'lib/posts.ts'), reader);
  await fs.rm(path.join(root, 'lib/post-order.mjs'));
  await fs.writeFile(path.join(root, 'README.md'), 'original\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n.next/\nout/\n*.tsbuildinfo\n');
  await fs.symlink(path.join(sourceRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  await run('git', ['init', '--bare', remote]);
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Order Test']);
  await git(['config', 'user.email', 'order@example.test']);
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial website']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', '-u', 'origin', 'main']);
  return { root, remote, git, initial: await git(['rev-parse', 'HEAD']), reader };
}

test('moving posts persists their order without editing MDX, dates or versions; new and deleted posts reconcile', async (t) => {
  const root = await fixture(t);
  const originals = await listPosts(root);
  const first = await listOrderedPosts(root);
  assert.equal(first.orderSaved, false);
  assert.deepEqual(first.posts.map((post) => post.slug), ['newer-note', 'older-note']);
  const moved = await move(root, 'older-note', 'up');
  assert.deepEqual(moved.posts.map((post) => post.slug), ['older-note', 'newer-note']);
  assert.equal(moved.orderSaved, true);
  for (const post of originals) assert.deepEqual(await readPost(root, post.slug), post);
  await assert.rejects(movePost(root, { slug: 'newer-note', direction: 'up', version: first.orderVersion }), { status: 409 });
  await assert.rejects(move(root, 'older-note', 'up'), /边界/);
  await assert.rejects(move(root, 'newer-note', 'down'), /边界/);
  await savePost(root, { ...await readPost(root, 'newer-note'), title: '修改标题仍保持顺序' });
  assert.deepEqual((await listPosts(root)).map((post) => post.slug), ['older-note', 'newer-note']);
  await savePost(root, { ...article('new-draft'), draft: true });
  assert.deepEqual((await listPosts(root)).map((post) => post.slug), ['new-draft', 'older-note', 'newer-note']);
  await fs.unlink(path.join(root, 'content/posts/older-note.mdx'));
  assert.deepEqual((await listPosts(root)).map((post) => post.slug), ['new-draft', 'newer-note']);
  await move(root, 'new-draft', 'down');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'content/post-order.json'), 'utf8')), ['newer-note', 'new-draft']);
});

test('order validates requests, duplicate/path entries and prevents symlink writes', async (t) => {
  const root = await fixture(t);
  assert.throws(() => parsePostOrder('["same","same"]'));
  assert.throws(() => parsePostOrder('["../outside"]'));
  await assert.rejects(move(root, 'older-note', 'sideways'), /上移或下移/);
  await assert.rejects(move(root, '../outside', 'up'), /文章网址/);
  await assert.rejects(move(root, 'absent', 'up'), { status: 404 });
  const outside = path.join(root, 'outside.json');
  await fs.writeFile(outside, '[]');
  await fs.symlink(outside, path.join(root, 'content/post-order.json'));
  await assert.rejects(listOrderedPosts(root), /符号链接/);
  assert.equal(await fs.readFile(outside, 'utf8'), '[]');
  assert.deepEqual(sortPosts([], ['deleted-note']), []);
});

test('first order publication builds the existing website with new order support while excluding staged and unsaved content', async (t) => {
  const { root, remote, git, reader } = await repository(t);
  await fs.writeFile(path.join(root, 'README.md'), 'unrelated staged\n');
  await fs.appendFile(path.join(root, 'lib/posts.ts'), '\n// unrelated staged reader change\n');
  await savePost(root, { ...await readPost(root, 'newer-note'), content: 'unpublished content' });
  await git(['add', 'README.md', 'lib/posts.ts', 'content/posts/newer-note.mdx']);
  await fs.appendFile(path.join(root, 'lib/posts.ts'), '// newer local reader change\n');
  await savePost(root, { ...article('private-draft', '2026-09-15'), draft: true });
  const ordered = await move(root, 'older-note', 'up');
  assert.deepEqual(ordered.posts.map((post) => post.slug), ['private-draft', 'older-note', 'newer-note']);
  let builtReader;
  await publishPostOrder(root, { version: ordered.orderVersion, build: async (directory, repositoryRoot, log) => {
    builtReader = await fs.readFile(path.join(directory, 'lib/posts.ts'), 'utf8');
    assert.equal(builtReader, enablePostOrder(reader));
    assert.equal(await fs.readFile(path.join(directory, 'README.md'), 'utf8'), 'original\n');
    assert.match((await readPost(await fs.realpath(directory), 'newer-note')).content, /正文原样保留/);
    await assert.rejects(fs.stat(path.join(directory, 'content/posts/private-draft.mdx')), { code: 'ENOENT' });
    await buildSnapshot(directory, repositoryRoot, log);
    const home = await fs.readFile(path.join(directory, 'out/index.html'), 'utf8');
    assert.ok(home.indexOf('href="/notes/older-note/"') < home.indexOf('href="/notes/newer-note/"'));
    assert.doesNotMatch(home, /private-draft|unpublished content/);
  } });
  assert.deepEqual(JSON.parse(await run('git', ['--git-dir', remote, 'show', 'main:content/post-order.json'])), ['older-note', 'newer-note']);
  assert.equal(await git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']), 'content/post-order.json\nlib/post-order.mjs\nlib/posts.ts');
  assert.match(await git(['show', ':lib/posts.ts']), /unrelated staged reader change/);
  assert.doesNotMatch(await git(['show', ':lib/posts.ts']), /newer local reader change/);
  assert.match(await fs.readFile(path.join(root, 'lib/posts.ts'), 'utf8'), /newer local reader change/);
  assert.match(await git(['diff', '--cached', '--', 'content/posts/newer-note.mdx']), /unpublished content/);
  assert.equal(await run('git', ['--git-dir', remote, 'show', 'main:lib/posts.ts'], { trim: false }), builtReader);
});

test('order publish fails safely on builds and concurrent ordering and retries failed pushes without duplicate commits', async (t) => {
  const { root, remote, git, initial } = await repository(t);
  let ordered = await move(root, 'older-note', 'up');
  await assert.rejects(publishPostOrder(root, { version: ordered.orderVersion, build: async () => { throw new Error('bad build'); } }), /bad build/);
  assert.equal(await git(['rev-parse', 'HEAD']), initial);
  await assert.rejects(publishPostOrder(root, { version: ordered.orderVersion, build: async () => { await move(root, 'older-note', 'down'); } }), /构建期间/);
  assert.equal(await git(['rev-parse', 'HEAD']), initial);
  ordered = await move(root, 'older-note', 'up');
  const hook = path.join(remote, 'hooks/pre-receive');
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(publishPostOrder(root, { version: ordered.orderVersion, build: async () => {} }));
  const committed = await git(['rev-parse', 'HEAD']);
  await fs.rm(hook);
  await publishPostOrder(root, { version: ordered.orderVersion, build: async () => {} });
  assert.equal(await git(['rev-parse', 'HEAD']), committed);
  assert.equal(await run('git', ['--git-dir', remote, 'rev-parse', 'main']), committed);
  const reversed = await move(root, 'older-note', 'down');
  await publishPostOrder(root, { version: reversed.orderVersion, build: async () => {} });
  assert.equal(await git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']), 'content/post-order.json');
});

test('order publish refuses unrelated commits and remote divergence', async (t) => {
  const { root, git, initial } = await repository(t);
  const ordered = await move(root, 'older-note', 'up');
  await fs.writeFile(path.join(root, 'README.md'), 'other commit\n');
  await git(['add', 'README.md']);
  await git(['commit', '-m', 'Other commit']);
  await assert.rejects(publishPostOrder(root, { version: ordered.orderVersion, build: async () => {} }), /其他未推送/);
  await git(['push', 'origin', 'main']);
  await git(['reset', '--mixed', initial]);
  await assert.rejects(publishPostOrder(root, { version: ordered.orderVersion, build: async () => {} }), /远程 main 有新提交/);
});

test('ordering endpoints require LAN login and CSRF, reject stale clients, and share all publishing locks', async (t) => {
  const root = await fixture(t);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const server = await createEditorServer({ root, lan: true, password: 'order-test-password', orderPublisher: async () => { await pending; return { commit: 'abc1234' }; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { finish(); server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = ''; let token = '';
  const post = (route, data, headers = {}) => fetch(`${origin}${route}`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-Editor-Token': token, ...headers }, body: JSON.stringify(data) });
  for (const route of ['/api/order/move', '/api/order/publish']) assert.equal((await post(route, {})).status, 401);
  const login = await post('/api/login', { password: 'order-test-password' });
  cookie = login.headers.get('set-cookie').split(';')[0];
  ({ token } = await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } }).then((response) => response.json()));
  const list = await fetch(`${origin}/api/posts`, { headers: { Cookie: cookie } }).then((response) => response.json());
  const input = { slug: 'older-note', direction: 'up', version: list.orderVersion };
  assert.equal((await post('/api/order/move', input, { 'X-Editor-Token': '' })).status, 403);
  assert.equal((await post('/api/order/move', input, { Origin: 'https://evil.example' })).status, 403);
  const response = await post('/api/order/move', input);
  assert.equal(response.status, 200);
  const moved = await response.json();
  assert.deepEqual(moved.posts.map((post) => post.slug), ['older-note', 'newer-note']);
  assert.equal((await post('/api/order/move', input)).status, 409);
  assert.equal((await post('/api/order/publish', { version: moved.orderVersion })).status, 202);
  for (const route of ['/api/save', '/api/delete', '/api/publish', '/api/site/save', '/api/site/publish', '/api/order/move', '/api/order/publish']) assert.equal((await post(route, input)).status, 409);
  finish();
});
