'use strict';

const byId = (id) => document.getElementById(id);
const fields = { title: byId('post-title'), slug: byId('post-slug'), date: byId('post-date'), category: byId('post-category'), description: byId('post-description'), content: byId('post-content') };
let token = '';
let workspace = '';
let posts = [];
let orderVersion = '';
let orderSaved = false;
let current = null;
let cleanValue = '';
let busy = false;
let backedUp = false;
let previewTimer;
let previewController;
let previewSequence = 0;
let watching = false;

function notice(text, error = false) {
  const element = byId('message');
  element.textContent = text;
  element.className = `notice${error ? ' error' : ''}`;
  element.hidden = !text;
}

async function api(route, data, signal) {
  const response = await fetch(route, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-Editor-Token': token },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: signal || AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (response.status === 401 && result.requiresLogin) {
    backup();
    busy = false;
    window.location.replace('/login');
    throw new Error('需要重新登录，未保存的修改已尝试暂存到当前浏览器。');
  }
  if (!response.ok) { const error = new Error(result.error || '请求失败，请重试。'); error.status = response.status; throw error; }
  return result;
}

function storageKey(post = current) { return `wiki-editor:${workspace}:${post?.version ? post.slug : 'new'}`; }
function readBackup(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (!value || !value.post || !Object.keys(fields).every((name) => typeof value.post[name] === 'string')) return null;
    return value;
  } catch { return null; }
}
function removeBackup(key) { try { localStorage.removeItem(key); } catch { /* Saving a file remains available without browser storage. */ } }
function values() { return { ...current, ...Object.fromEntries(Object.entries(fields).map(([name, element]) => [name, element.value])) }; }
function dirty() { return current && JSON.stringify(values()) !== cleanValue; }

function backup() {
  if (!current) return;
  const post = values();
  backedUp = false;
  byId('discard-changes').hidden = !dirty();
  if (!dirty()) {
    removeBackup(storageKey(current));
    byId('save-state').textContent = current.version ? '已保存到本地文件' : '还未开始写作';
    return;
  }
  try {
    localStorage.setItem(storageKey(current), JSON.stringify({ post, cleanValue }));
    backedUp = true;
    byId('save-state').textContent = '已暂存浏览器 · 尚未保存文件';
  } catch {
    byId('save-state').textContent = '浏览器暂存不可用，请及时保存';
  }
}

function setBusy(value) {
  busy = value;
  byId('post-fields').disabled = value || !current;
  for (const id of ['save-post', 'publish-post', 'new-post']) byId(id).disabled = value;
  byId('delete-post').hidden = !current?.version;
  for (const id of ['delete-post', 'confirm-delete', 'cancel-delete']) byId(id).disabled = value || !current?.version;
  document.querySelectorAll('.post-item').forEach((button) => { button.disabled = value; });
  updateOrderControls();
}

function updateOrderControls() {
  const filtering = Boolean(byId('search').value.trim());
  document.querySelectorAll('.post-move').forEach((button) => { button.disabled = busy || filtering || button.dataset.boundary === 'true'; });
  byId('publish-order').disabled = busy || !orderSaved || !orderVersion;
}

function acceptList(result) {
  ({ posts, orderVersion, orderSaved } = result);
  byId('order-state').textContent = orderSaved ? '当前使用自定义顺序。' : '未调整时按日期由新到旧排列。';
  renderList();
}

async function refreshList() { acceptList(await api('/api/posts')); }

async function moveArticle(slug, direction) {
  if (busy || byId('search').value.trim()) return;
  backup();
  setBusy(true);
  try {
    acceptList(await api('/api/order/move', { slug, direction, version: orderVersion }));
    byId('order-state').textContent = '顺序已保存到本地，点击「发布排序」同步首页。';
  } catch (error) {
    if (error.status === 409 || error.status === 404) {
      try { await refreshList(); } catch { /* Preserve the original error. */ }
    }
    byId('order-state').textContent = error.message;
  } finally {
    setBusy(false);
    const row = [...document.querySelectorAll('.post-row')].find((item) => item.dataset.slug === slug);
    const button = row?.querySelector(`[data-direction="${direction}"]`);
    (button && !button.disabled ? button : row?.querySelector('.post-item'))?.focus();
  }
}

async function publishOrder() {
  if (busy || !orderSaved) return;
  backup(); setBusy(true);
  try {
    const { job } = await api('/api/order/publish', { version: orderVersion });
    showJob(job);
    await watchPublish();
  } catch (error) { byId('order-state').textContent = error.message; }
  finally { setBusy(false); }
}

function canSwitch() {
  if (busy) return false;
  backup();
  if (dirty() && !backedUp) {
    notice('浏览器无法暂存，请先保存当前文章后再切换。', true);
    return false;
  }
  return true;
}

function renderList() {
  const query = byId('search').value.toLocaleLowerCase().trim();
  const matches = posts.filter((post) => `${post.title} ${post.category} ${post.slug}`.toLocaleLowerCase().includes(query));
  const list = byId('post-list');
  list.replaceChildren();
  byId('post-count').textContent = String(posts.length);
  for (const post of matches) {
    const row = document.createElement('div');
    row.className = 'post-row';
    row.dataset.slug = post.slug;
    const button = document.createElement('button');
    button.type = 'button';
    const active = current?.version && current.slug === post.slug;
    button.className = `post-item${active ? ' active' : ''}`;
    button.disabled = busy;
    if (active) button.setAttribute('aria-current', 'true');
    const title = document.createElement('span');
    title.className = 'post-item-title';
    title.textContent = post.title;
    const meta = document.createElement('span');
    meta.className = 'post-item-meta';
    const date = document.createElement('span');
    date.textContent = post.date.replaceAll('-', '.');
    const state = document.createElement('span');
    state.textContent = readBackup(storageKey(post)) ? '有暂存修改' : post.draft ? '草稿' : post.category;
    meta.append(date, state);
    button.append(title, meta);
    button.addEventListener('click', () => { if (canSwitch()) selectPost(post); });
    row.append(button);
    const controls = document.createElement('div');
    controls.className = 'post-order-controls';
    const index = posts.indexOf(post);
    for (const [direction, text, boundary] of [['up', '上移', index === 0], ['down', '下移', index === posts.length - 1]]) {
      const move = document.createElement('button');
      move.type = 'button';
      move.className = 'text-button post-move';
      move.textContent = text;
      move.dataset.direction = direction;
      move.dataset.boundary = String(boundary);
      move.setAttribute('aria-label', `${text}文章：${post.title}`);
      move.title = query ? '请清空搜索后调整完整列表顺序' : `${text}这篇文章`;
      move.addEventListener('click', () => { void moveArticle(post.slug, direction); });
      controls.append(move);
    }
    row.append(controls);
    list.append(row);
  }
  if (!matches.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = query ? '没有找到匹配的文章。' : '还没有文章，写下第一篇吧。';
    list.append(empty);
  }
  if (query) byId('order-state').textContent = '清空搜索后，可以调整完整列表顺序。';
  else if (byId('order-state').textContent === '清空搜索后，可以调整完整列表顺序。') byId('order-state').textContent = orderSaved ? '当前使用自定义顺序。' : '未调整时按日期由新到旧排列。';
  updateOrderControls();
}

function selectPost(post, restore = true) {
  const saved = restore ? readBackup(storageKey(post)) : null;
  current = { ...(saved?.post || post) };
  try { sessionStorage.setItem(`wiki-editor:${workspace}:selected`, current.version ? current.slug : 'new'); } catch { /* The article list remains usable without session storage. */ }
  for (const [name, input] of Object.entries(fields)) input.value = current[name];
  cleanValue = saved?.cleanValue || JSON.stringify(current);
  backedUp = Boolean(saved);
  fields.slug.readOnly = Boolean(current.version);
  byId('slug-hint').textContent = current.version ? `/notes/${current.slug}/ · 网址已固定` : '首次保存后固定，用于 /notes/文章网址/';
  byId('post-state').textContent = current.draft ? '本地草稿' : '公开文章';
  byId('save-state').textContent = saved ? '已恢复浏览器暂存 · 尚未保存文件' : current.version ? '已保存到本地文件' : '还未开始写作';
  byId('discard-changes').hidden = !saved;
  byId('discard-prompt').hidden = true;
  byId('delete-confirm').hidden = true;
  setBusy(busy);
  notice(saved ? '已恢复上次未保存的修改。点击「保存到本地」写入文章文件。' : '');
  if (saved && saved.post.version !== post.version) notice('已恢复暂存内容，但文件在其他地方发生过变化。请先复制正文留存，再刷新并重新打开文章，避免覆盖修改。', true);
  renderList();
  updateWordCount();
  requestPreview();
}

function newPost() {
  const date = new Date();
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  // getRandomValues is also available on ordinary HTTP LAN addresses.
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { slug: `note-${today}-${suffix}`, title: '', date: today, category: '学习笔记', description: '', content: '', draft: true, version: null };
}

function updateWordCount() { byId('word-count').textContent = `${fields.content.value.replace(/\s/g, '').length.toLocaleString()} 字符`; }

function requestPreview() {
  clearTimeout(previewTimer);
  previewController?.abort();
  const sequence = ++previewSequence;
  previewTimer = setTimeout(async () => {
    previewController = new AbortController();
    try {
      const result = await api('/api/preview', values(), previewController.signal);
      if (sequence !== previewSequence) return;
      byId('preview').srcdoc = result.html;
      byId('preview').classList.remove('stale');
      byId('preview-error').hidden = true;
    } catch (error) {
      if (error.name === 'AbortError' || sequence !== previewSequence) return;
      byId('preview-error').textContent = error.message;
      byId('preview-error').hidden = false;
      byId('preview').classList.add('stale');
    }
  }, 450);
}

function showJob(job) {
  byId('publish-progress').hidden = false;
  byId('publish-stage').textContent = job.stage;
  byId('progress-marker').className = `progress-marker ${job.status}`;
  byId('commit-id').textContent = job.commit || '';
  byId('publish-log').textContent = job.log;
  byId('actions-link').hidden = (job.status !== 'succeeded' && !job.pushed) || Boolean(job.localOnly);
  const deleting = job.operation === 'delete';
  const ordering = job.operation === 'order';
  const result = ordering ? job.status === 'succeeded' ? '文章排序已推送到 GitHub，首页将在 Actions 部署完成后按新顺序显示。文章正文和日期保持原样。'
    : job.status === 'failed' ? `${job.error}\n本地顺序已保留，修复问题后点击「发布排序」重试。`
      : '正在发布文章顺序，请保持写作台服务运行。'
    : deleting ? job.status === 'succeeded'
    ? job.localRetained ? '线上删除已处理，但本地文章在操作期间被修改，新内容已保留。请重新打开检查。'
      : job.localOnly ? '文章只保存在本地，已删除，无需更新线上网站。'
        : '文章删除已推送到 GitHub。本地文件已删除，线上文章会在 Actions 部署完成后下线。'
    : job.status === 'failed' ? `${job.error}\n${job.pushed ? '删除已推送，请检查本地文件；线上状态以 Actions 部署结果为准。' : '本地文章已保留。修复问题后重新点击「删除文章」可重试，不会重复创建同一删除提交。'}`
      : '正在检查并同步文章删除，请保持写作台服务运行。'
    : job.status === 'succeeded'
    ? `${job.operation === 'site' ? job.section === 'about' ? '关于我' : '项目' : '当前文章'}已推送到 GitHub。网站更新以 Actions 部署完成为准，通常需要几分钟。`
    : job.status === 'failed' ? `${job.error}\n修复问题后可再次点击「保存并发布」，不会重复提交相同内容。`
      : '正在发布内容，请保持写作台服务运行。';
  byId('publish-result').textContent = result + (job.backup ? `\n删除前的本机备份：${job.backup}` : '');
}

async function refreshAfterDeletion(job) {
  await refreshList();
  if (current?.slug === job.slug && current.version) {
    if (dirty()) {
      notice('该文章已在本地发生变化。当前未保存的编辑仍保留在编辑区，请复制内容留存后重新载入。', true);
    } else if (job.deleted) {
      removeBackup(storageKey(current));
      selectPost(posts[0] || newPost());
    } else {
      const latest = posts.find((post) => post.slug === job.slug);
      if (latest) selectPost(latest);
    }
  }
  renderList();
}

async function watchPublish() {
  if (watching) return;
  watching = true;
  setBusy(true);
  try {
    while (true) {
      const { job } = await api('/api/status');
      if (!job) break;
      showJob(job);
      if (job.status !== 'running') {
        if (job.operation === 'delete' && job.status === 'succeeded') await refreshAfterDeletion(job);
        if (job.operation === 'order') byId('order-state').textContent = job.status === 'succeeded' ? '排序已推送，等待网站部署完成。' : '排序发布未完成，可点击「发布排序」重试。';
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    notice(`无法读取发布进度：${error.message}。请保持编辑器终端运行，刷新页面可重新查看状态。`, true);
  } finally {
    watching = false;
    setBusy(false);
  }
}

async function save(publish = false) {
  if (busy || !current || !byId('post-form').reportValidity()) return;
  const previousKey = storageKey(current);
  const input = values();
  if (publish) input.draft = false;
  backup();
  setBusy(true);
  notice('');
  try {
    const { post } = await api('/api/save', input);
    removeBackup(previousKey);
    removeBackup(storageKey(post));
    posts = posts.filter((item) => item.slug !== post.slug).concat(post);
    selectPost(post, false);
    await refreshList();
    notice(publish ? '文章已保存，正在准备发布。' : '已保存到本地文件。线上网站将在点击「保存并发布」后更新。');
    if (publish) {
      const { job } = await api('/api/publish', { slug: post.slug, version: post.version });
      showJob(job);
      notice('');
      await watchPublish();
    }
  } catch (error) {
    notice(error.message, true);
  } finally { setBusy(false); }
}

function requestDelete() {
  if (busy || !current?.version) return;
  if (dirty()) {
    notice('这篇文章有未保存的修改，请先保存或放弃修改，再删除文章。', true);
    return;
  }
  byId('delete-title').textContent = current.title;
  byId('delete-confirm').hidden = false;
  byId('cancel-delete').focus();
}

async function confirmDelete() {
  if (busy || !current?.version || byId('delete-confirm').hidden) return;
  if (dirty()) { byId('delete-confirm').hidden = true; requestDelete(); return; }
  setBusy(true);
  notice('');
  try {
    const { job } = await api('/api/delete', { slug: current.slug, version: current.version, confirmSlug: current.slug });
    byId('delete-confirm').hidden = true;
    showJob(job);
    await watchPublish();
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
}

byId('post-form').addEventListener('submit', (event) => { event.preventDefault(); void save(); });
byId('publish-post').addEventListener('click', () => { void save(true); });
byId('delete-post').addEventListener('click', requestDelete);
byId('confirm-delete').addEventListener('click', () => { void confirmDelete(); });
byId('cancel-delete').addEventListener('click', () => { byId('delete-confirm').hidden = true; byId('delete-post').focus(); });
byId('new-post').addEventListener('click', () => {
  if (!canSwitch()) return;
  selectPost(newPost());
  fields.title.focus();
});
byId('search').addEventListener('input', renderList);
byId('publish-order').addEventListener('click', () => { void publishOrder(); });
document.querySelectorAll('.section-nav a').forEach((link) => link.addEventListener('click', (event) => { if (!canSwitch()) event.preventDefault(); }));
byId('logout').addEventListener('click', async () => {
  if (!canSwitch()) return;
  setBusy(true);
  try { await api('/api/logout', {}); busy = false; window.location.replace('/login'); }
  catch (error) { notice(error.message, true); setBusy(false); }
});
byId('discard-changes').addEventListener('click', () => { byId('discard-prompt').hidden = false; });
byId('cancel-discard').addEventListener('click', () => { byId('discard-prompt').hidden = true; });
byId('confirm-discard').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try {
    const result = await api('/api/posts');
    const latest = current.version ? result.posts.find((post) => post.slug === current.slug) : newPost();
    if (!latest) throw new Error('原文章已被删除或移动，请先复制当前内容留存。');
    removeBackup(storageKey(current));
    acceptList(result);
    selectPost(latest, false);
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
});
byId('post-fields').addEventListener('input', () => {
  byId('discard-prompt').hidden = true;
  byId('delete-confirm').hidden = true;
  if (!byId('message').classList.contains('error')) notice('');
  backup(); updateWordCount(); requestPreview();
});
byId('toggle-preview').addEventListener('click', () => {
  const visible = byId('preview-pane').hidden;
  byId('preview-pane').hidden = !visible;
  byId('writing-panes').classList.toggle('preview-hidden', !visible);
  byId('toggle-preview').textContent = visible ? '收起预览' : '展开预览';
  byId('toggle-preview').setAttribute('aria-pressed', String(visible));
});
document.querySelectorAll('[data-format]').forEach((button) => button.addEventListener('click', () => {
  const textarea = fields.content;
  const { selectionStart: start, selectionEnd: end } = textarea;
  const selected = textarea.value.slice(start, end);
  const snippets = {
    heading: ['\n## ', selected || '小标题', '\n'], bold: ['**', selected || '加粗文字', '**'],
    link: ['[', selected || '链接文字', '](https://example.com)'], quote: ['\n> ', selected || '引用内容', '\n'],
    code: ['\n```javascript\n', selected || '// 在这里写代码', '\n```\n'], image: ['![', selected || '图片说明', '](/images/example.png)'],
  };
  const [prefix, text, suffix] = snippets[button.dataset.format];
  textarea.setRangeText(prefix + text + suffix, start, end, 'end');
  textarea.focus();
  textarea.setSelectionRange(start + prefix.length, start + prefix.length + text.length);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}));
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
});
window.addEventListener('beforeunload', (event) => {
  if (busy || (dirty() && !backedUp)) { event.preventDefault(); event.returnValue = ''; }
});

async function start() {
  try {
    const session = await api('/api/session');
    ({ token, workspace } = session);
    byId('editor-mode').textContent = session.mode === 'lan' ? '局域网写作台' : '本地写作台';
    byId('logout').hidden = session.mode !== 'lan';
    await refreshList();
    const unsavedNew = readBackup(storageKey(null));
    let selectedSlug;
    try { selectedSlug = sessionStorage.getItem(`wiki-editor:${workspace}:selected`); } catch { /* Fall back to the article list. */ }
    selectPost(selectedSlug === 'new' || (!selectedSlug && unsavedNew) ? newPost() : posts.find((post) => post.slug === selectedSlug) || posts[0] || newPost());
    const { job } = await api('/api/status');
    if (job) showJob(job);
    if (job?.status === 'running') await watchPublish();
  } catch (error) {
    byId('connection-error').textContent = `连接本地编辑器失败：${error.message}。请确认 npm run editor 仍在运行，然后刷新页面。`;
    byId('connection-error').hidden = false;
  }
}
void start();
