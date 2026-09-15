import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewSiteSection, readSiteSection, readSiteSource, replaceSection, saveSiteSection, sectionFromSource } from './site-content.mjs';
import { publishSiteSection } from './site-publish.mjs';
import { buildSnapshot, run } from './publish.mjs';
import { createEditorServer } from './server.mjs';

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const original = await fs.readFile(path.join(sourceRoot, 'site.config.ts'), 'utf8');
const project = (name) => ({ name, description: '项目简介', href: 'https://example.com/project', label: '持续更新' });

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-site-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'site.config.ts'), original);
  return root;
}
async function repository(t) {
  const root = await fixture(t);
  const remote = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-site-remote-')));
  t.after(() => fs.rm(remote, { recursive: true, force: true }));
  const git = (args, options = {}) => run('git', args, { cwd: root, ...options });
  await run('git', ['init', '--bare', remote]);
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Site Editor Test']);
  await git(['config', 'user.email', 'site@example.test']);
  await fs.writeFile(path.join(root, 'README.md'), 'original\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Initial site']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['push', '-u', 'origin', 'main']);
  return { root, remote, git, initial: await git(['rev-parse', 'HEAD']) };
}
async function change(root, section, data) {
  const entry = await readSiteSection(root, section);
  return saveSiteSection(root, { ...entry, data: { ...entry.data, ...data } });
}

test('site saves preserve other fields and comments, allow independent section versions, reject stale edits', async (t) => {
  const root = await fixture(t);
  const source = original.replace('export const site = {', 'export const site = {\n  // retain unrelated configuration\n  custom: process.env.SITE_EXTRA,');
  await fs.writeFile(path.join(root, 'site.config.ts'), source);
  const projects = await readSiteSection(root, 'projects');
  const about = await change(root, 'about', { name: '新的名字', bio: ['第一段', '第二段'] });
  await saveSiteSection(root, { ...projects, data: { projects: [project('项目 B'), project('项目 A')] } });
  assert.deepEqual((await readSiteSection(root, 'about')), about);
  assert.match(await readSiteSource(root), /\/\/ retain unrelated configuration\n  custom: process.env.SITE_EXTRA,/);
  assert.match(await readSiteSource(root), /url: 'https:\/\/wucongkai.github.io'/);
  const noOp = await readSiteSource(root);
  await saveSiteSection(root, await readSiteSection(root, 'about'));
  assert.equal(await readSiteSource(root), noOp);
  await assert.rejects(saveSiteSection(root, projects), { status: 409 });
  assert.deepEqual((await change(root, 'projects', { projects: [] })).data.projects, []);
});

test('site validation rejects unsafe links, invalid fields, duplicate projects, dynamic expressions and symlinks', async (t) => {
  const root = await fixture(t);
  for (const href of ['javascript:alert(1)', '//evil.example', '/\\evil.example', 'data:text/html,x', 'https://user:pass@example.com']) {
    await assert.rejects(change(root, 'projects', { projects: [{ ...project('invalid'), href }] }), { status: 400 });
  }
  for (const href of ['/', '/notes/hello-world/', '#about', 'https://example.com']) await change(root, 'projects', { projects: [{ ...project('valid'), href }] });
  await assert.rejects(change(root, 'projects', { projects: [project('duplicate'), project('duplicate')] }), /不能重复/);
  await assert.rejects(change(root, 'about', { email: 'not-an-email' }), /邮箱/);
  await assert.rejects(change(root, 'about', { name: '' }), /请填写/);
  assert.throws(() => sectionFromSource(original.replace("name: 'wucongkai'", 'name: (() => { throw new Error("never execute"); })()'), 'about'), /动态表达式/);
  const filename = path.join(root, 'site.config.ts');
  await fs.rename(filename, path.join(root, 'outside.ts'));
  await fs.symlink(path.join(root, 'outside.ts'), filename);
  await assert.rejects(readSiteSection(root, 'about'), /符号链接/);
  assert.equal(await fs.readFile(path.join(root, 'outside.ts'), 'utf8'), await fs.readFile(filename, 'utf8'));
});

test('site preview uses homepage classes, escapes text and hides an empty contact email', () => {
  const html = previewSiteSection('projects', { projects: [project('<script>alert(1)</script>')] });
  assert.match(html, /class="project-list"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  const about = previewSiteSection('about', { ...sectionFromSource(original, 'about').data, email: '', bio: ['段落一', '段落二'] });
  assert.match(about, /<p>段落一<\/p><p>段落二<\/p>/);
  assert.doesNotMatch(about, /mailto:/);
  assert.match(about, /script-src &#x27;none&#x27;/);
});

test('publishing a section excludes other local and staged fields in the same file and preserves their staging', async (t) => {
  const { root, git, remote } = await repository(t);
  await change(root, 'about', { name: 'staged name' });
  await fs.writeFile(path.join(root, 'README.md'), 'unrelated staged\n');
  await git(['add', 'site.config.ts', 'README.md']);
  await change(root, 'about', { name: 'newer unstaged name' });
  const entry = await change(root, 'projects', { projects: [project('B'), project('A')] });
  await publishSiteSection(root, 'projects', { version: entry.version, build: async (directory) => {
    assert.deepEqual((await readSiteSection(directory, 'projects')).data.projects, entry.data.projects);
    assert.equal((await readSiteSection(directory, 'about')).data.name, sectionFromSource(original, 'about').data.name);
    assert.equal(await fs.readFile(path.join(directory, 'README.md'), 'utf8'), 'original\n');
  } });
  assert.equal((await readSiteSection(root, 'about')).data.name, 'newer unstaged name');
  const staged = await git(['show', ':site.config.ts']);
  assert.equal(sectionFromSource(staged, 'about').data.name, 'staged name');
  assert.deepEqual(sectionFromSource(staged, 'projects').data.projects, entry.data.projects);
  assert.equal(await git(['diff', '--cached', '--name-only']), 'README.md\nsite.config.ts');
  const pushed = await run('git', ['--git-dir', remote, 'show', 'main:site.config.ts']);
  assert.equal(sectionFromSource(pushed, 'about').data.name, sectionFromSource(original, 'about').data.name);
  assert.deepEqual(sectionFromSource(pushed, 'projects').data.projects, entry.data.projects);
  assert.equal(await git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']), 'site.config.ts');
});

test('site publish retains changes on build failure and prevents publishing a concurrent edit', async (t) => {
  const { root, git, initial } = await repository(t);
  const entry = await change(root, 'about', { name: 'saved name' });
  await assert.rejects(publishSiteSection(root, 'about', { version: entry.version, build: async () => { throw new Error('build failed'); } }), /build failed/);
  assert.equal(await git(['rev-parse', 'HEAD']), initial);
  assert.equal((await readSiteSection(root, 'about')).data.name, 'saved name');
  await assert.rejects(publishSiteSection(root, 'about', { version: entry.version, build: async () => { await change(root, 'about', { name: 'external edit' }); } }), /构建期间/);
  assert.equal(await git(['rev-parse', 'HEAD']), initial);
});

test('failed site push can retry the same commit while retaining other staged content', async (t) => {
  const { root, remote, git } = await repository(t);
  const entry = await change(root, 'about', { title: '新的网站标题' });
  await change(root, 'projects', { projects: [project('pending project')] });
  await git(['add', 'site.config.ts']);
  const hook = path.join(remote, 'hooks/pre-receive');
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(publishSiteSection(root, 'about', { version: entry.version, build: async () => {} }));
  const committed = await git(['rev-parse', 'HEAD']);
  assert.equal((await readSiteSection(root, 'projects')).data.projects[0].name, 'pending project');
  await fs.rm(hook);
  await publishSiteSection(root, 'about', { version: entry.version, build: async () => {} });
  assert.equal(await git(['rev-parse', 'HEAD']), committed);
  assert.equal(await run('git', ['--git-dir', remote, 'rev-parse', 'main']), committed);
  assert.match(await git(['diff', '--cached']), /pending project/);
});

test('site publishing refuses unrelated pending commits and remote divergence', async (t) => {
  const { root, git, initial } = await repository(t);
  const entry = await change(root, 'projects', { projects: [] });
  await fs.writeFile(path.join(root, 'README.md'), 'unrelated commit\n');
  await git(['add', 'README.md']);
  await git(['commit', '-m', 'Unrelated']);
  await assert.rejects(publishSiteSection(root, 'projects', { version: entry.version, build: async () => {} }), /其他未推送/);
  await git(['push', 'origin', 'main']);
  await git(['reset', '--mixed', initial]);
  await assert.rejects(publishSiteSection(root, 'projects', { version: entry.version, build: async () => {} }), /远程 main 有新提交/);
});

test('site HTTP endpoints require login, same-origin CSRF tokens and share the article mutation lock', async (t) => {
  const root = await fixture(t);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const password = 'site-test-password';
  const server = await createEditorServer({ root, lan: true, password, sitePublisher: async () => { await pending; return { commit: 'abc1234' }; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { finish(); server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = ''; let token = '';
  const post = (route, data, headers = {}) => fetch(`${origin}${route}`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-Editor-Token': token, ...headers }, body: JSON.stringify(data) });
  assert.equal((await fetch(`${origin}/api/site?section=about`)).status, 401);
  for (const route of ['/api/site/save', '/api/site/preview', '/api/site/publish']) assert.equal((await post(route, {})).status, 401);
  const login = await post('/api/login', { password });
  cookie = login.headers.get('set-cookie').split(';')[0];
  ({ token } = await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } }).then((response) => response.json()));
  const entry = await readSiteSection(root, 'projects');
  assert.equal((await post('/api/site/save', entry, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/site/publish', entry, { 'X-Editor-Token': '' })).status, 403);
  assert.equal((await post('/api/site/save', entry)).status, 200);
  assert.equal((await post('/api/site/preview', entry)).status, 200);
  assert.equal((await post('/api/site/save', { ...entry, section: '../file' })).status, 400);
  assert.equal((await post('/api/site/publish', entry)).status, 202);
  for (const route of ['/api/save', '/api/publish', '/api/delete', '/api/site/save', '/api/site/publish']) assert.equal((await post(route, entry)).status, 409);
  assert.equal((await post('/api/site/preview', entry)).status, 200);
  finish();
});

test('real site builds publish an empty project list and updated about text without requiring template changes', async (t) => {
  const { root, git } = await repository(t);
  for (const name of ['app', 'lib', 'public', 'content', 'package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json', 'next-env.d.ts']) {
    await fs.cp(path.join(sourceRoot, name), path.join(root, name), { recursive: true });
  }
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n.next/\nout/\n*.tsbuildinfo\n');
  await fs.symlink(path.join(sourceRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  await git(['add', '.']);
  await git(['commit', '-m', 'Add website source']);
  await git(['push', 'origin', 'main']);
  const about = await change(root, 'about', { title: '新的主页标题', bio: ['第一段：含有 "引号" 和 <标签>。', '第二段：正常显示。'], email: '', github: 'https://github.com/example' });
  const projects = await change(root, 'projects', { projects: [] });
  await publishSiteSection(root, 'projects', { version: projects.version, build: async (directory, repositoryRoot, log) => {
    await buildSnapshot(directory, repositoryRoot, log);
    const html = await fs.readFile(path.join(directory, 'out/index.html'), 'utf8');
    assert.match(html, /<ul class="project-list"><\/ul>/);
    assert.doesNotMatch(html, /新的主页标题/);
  } });
  await publishSiteSection(root, 'about', { version: about.version, build: async (directory, repositoryRoot, log) => {
    await buildSnapshot(directory, repositoryRoot, log);
    const html = await fs.readFile(path.join(directory, 'out/index.html'), 'utf8');
    assert.match(html, /新的主页标题/);
    assert.match(html, /&lt;标签&gt;/);
    assert.match(html, /第二段：正常显示/);
    assert.doesNotMatch(html, /mailto:/);
    assert.match(html, /<ul class="project-list"><\/ul>/);
  } });
});
