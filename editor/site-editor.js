'use strict';

const byId = (id) => document.getElementById(id);
const section = new URLSearchParams(window.location.search).get('section') === 'about' ? 'about' : 'projects';
const label = section === 'about' ? '关于我' : '项目';
const aboutNames = ['name', 'title', 'description', 'github', 'email'];
let token = '';
let workspace = '';
let current = null;
let cleanValue = '';
let busy = false;
let backedUp = false;
let previewTimer;
let previewController;
let previewSequence = 0;
const removed = [];

byId('section-heading').textContent = section === 'about' ? '讲述你的故事。' : '让作品，慢慢被看见。';
byId('section-description').textContent = section === 'about' ? '更新个人介绍、网站信息与联系方式。' : '整理你的项目，分享正在做的事。';
byId('section-label').textContent = label;
byId('publish-hint').textContent = `发布仅更新“${label}”。`;
document.querySelector(`[data-section="${section}"]`).setAttribute('aria-current', 'page');
byId(`${section}-fields`).hidden = false;
document.querySelectorAll(`#${section === 'about' ? 'projects' : 'about'}-fields input, #${section === 'about' ? 'projects' : 'about'}-fields textarea`).forEach((input) => { input.disabled = true; });

function notice(text, error = false) {
  byId('message').textContent = text;
  byId('message').className = `notice${error ? ' error' : ''}`;
  byId('message').hidden = !text;
}

async function api(route, data, signal) {
  const response = await fetch(route, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-Editor-Token': token },
    body: data === undefined ? undefined : JSON.stringify(data), signal: signal || AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (response.status === 401 && result.requiresLogin) {
    backup(); busy = false;
    window.location.replace(`/login?next=${encodeURIComponent(`/site?section=${section}`)}`);
    throw new Error('需要重新登录。');
  }
  if (!response.ok) throw new Error(result.error || '请求失败，请重试。');
  return result;
}

function storageKey() { return `wiki-editor:${workspace}:site:${section}`; }
function values() {
  if (section === 'projects') return { projects: [...document.querySelectorAll('.project-card')].map((card) => Object.fromEntries([...card.querySelectorAll('[data-field]')].map((input) => [input.dataset.field, input.value]))) };
  return { ...Object.fromEntries(aboutNames.map((name) => [name, byId(`site-${name}`).value])), bio: byId('site-bio').value.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean) };
}
function dirty() { return current && JSON.stringify(values()) !== cleanValue; }
function removeBackup() { try { localStorage.removeItem(storageKey()); } catch { /* Files can still be saved. */ } }
function readBackup() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) || 'null');
    if (!saved?.entry || saved.entry.section !== section || typeof saved.cleanValue !== 'string') return null;
    const data = saved.entry.data;
    const valid = section === 'projects' ? Array.isArray(data.projects) && data.projects.every((project) => ['name', 'description', 'href', 'label'].every((key) => typeof project[key] === 'string'))
      : aboutNames.every((key) => typeof data[key] === 'string') && Array.isArray(data.bio) && data.bio.every((paragraph) => typeof paragraph === 'string');
    return valid ? saved : null;
  } catch { return null; }
}
function backup() {
  if (!current) return;
  backedUp = false;
  byId('discard-changes').hidden = !dirty();
  if (!dirty()) {
    removeBackup();
    byId('save-state').textContent = '已保存到本地文件';
    return;
  }
  try {
    localStorage.setItem(storageKey(), JSON.stringify({ entry: { ...current, data: values() }, cleanValue }));
    backedUp = true;
    byId('save-state').textContent = '已暂存浏览器 · 尚未保存文件';
  } catch { byId('save-state').textContent = '浏览器暂存不可用，请及时保存'; }
}

function setBusy(value) {
  busy = value;
  byId('site-fields').disabled = value || !current;
  for (const id of ['save-site', 'publish-site']) byId(id).disabled = value || !current;
}
function canLeave() {
  if (busy) return false;
  backup();
  if (dirty() && !backedUp) { notice('浏览器无法暂存，请先保存当前内容后再切换。', true); return false; }
  return true;
}

function renderProjects(projects) {
  const cards = byId('project-cards');
  cards.replaceChildren();
  projects.forEach((project, index) => {
    const card = byId('project-template').content.firstElementChild.cloneNode(true);
    card.dataset.index = String(index);
    card.querySelector('h3').textContent = `项目 ${String(index + 1).padStart(2, '0')}`;
    card.querySelectorAll('[data-field]').forEach((input) => { input.value = project[input.dataset.field]; });
    for (const action of ['up', 'down', 'remove']) {
      const button = card.querySelector(`[data-action="${action}"]`);
      button.setAttribute('aria-label', `${button.textContent}项目 ${index + 1}`);
      button.disabled = action === 'up' && index === 0 || action === 'down' && index === projects.length - 1;
    }
    cards.append(card);
  });
  byId('project-count').textContent = String(projects.length);
  byId('projects-empty').hidden = projects.length !== 0;
  byId('add-project').disabled = projects.length >= 100;
}

function display(entry, restore = false) {
  const saved = restore ? readBackup() : null;
  current = saved?.entry || entry;
  if (section === 'projects') renderProjects(current.data.projects);
  else {
    aboutNames.forEach((name) => { byId(`site-${name}`).value = current.data[name]; });
    byId('site-bio').value = current.data.bio.join('\n\n');
  }
  cleanValue = saved?.cleanValue || JSON.stringify(values());
  backedUp = Boolean(saved);
  removed.length = 0;
  byId('project-removed').hidden = true;
  byId('discard-prompt').hidden = true;
  byId('discard-changes').hidden = !saved;
  byId('save-state').textContent = saved ? '已恢复浏览器暂存 · 尚未保存文件' : '已保存到本地文件';
  notice(saved ? saved.entry.version !== entry.version ? '已恢复暂存内容，但本地文件也发生了变化。请先复制内容留存，再放弃修改并重新载入，避免覆盖。' : '已恢复上次未保存的修改。' : '', Boolean(saved && saved.entry.version !== entry.version));
  setBusy(busy);
  requestPreview();
}

function requestPreview() {
  clearTimeout(previewTimer);
  previewController?.abort();
  const sequence = ++previewSequence;
  previewTimer = setTimeout(async () => {
    previewController = new AbortController();
    try {
      const { html } = await api('/api/site/preview', { section, data: values() }, previewController.signal);
      if (sequence !== previewSequence) return;
      byId('site-preview').srcdoc = html;
      byId('site-preview').classList.remove('stale');
      byId('preview-error').hidden = true;
    } catch (error) {
      if (error.name === 'AbortError' || sequence !== previewSequence) return;
      byId('preview-error').textContent = `预览待更新：${error.message}`;
      byId('preview-error').hidden = false;
      byId('site-preview').classList.add('stale');
    }
  }, 450);
}
function changed() {
  byId('discard-prompt').hidden = true;
  if (!byId('message').classList.contains('error')) notice('');
  backup(); requestPreview();
}

function showJob(job) {
  byId('publish-progress').hidden = false;
  byId('publish-stage').textContent = job.stage;
  byId('publish-log').textContent = job.log;
  byId('commit-id').textContent = job.commit || '';
  byId('progress-marker').className = `progress-marker ${job.status}`;
  byId('actions-link').hidden = (job.status !== 'succeeded' && !job.pushed) || Boolean(job.localOnly);
  const subject = job.operation === 'order' ? '文章排序' : job.operation === 'site' ? job.section === 'about' ? '关于我' : '项目' : '文章';
  byId('publish-result').textContent = job.status === 'succeeded' ? job.localOnly ? '本地操作已完成。' : `${subject}${job.operation === 'delete' ? '删除' : '更新'}已推送到 GitHub。网站将在 Actions 部署完成后更新，通常需要几分钟。`
    : job.status === 'failed' ? `${job.error}\n本地内容已保留；修复问题后，在对应编辑页重试即可。` : `正在处理${subject}，请保持写作台服务运行。`;
}
async function watchJob() {
  setBusy(true);
  try {
    while (true) {
      const { job } = await api('/api/status');
      if (!job) break;
      showJob(job);
      if (job.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) { notice(`无法读取进度：${error.message}。刷新页面可以重新查看。`, true); }
  finally { setBusy(false); }
}
async function save(publish = false) {
  if (busy || !current || !byId('site-form').reportValidity()) return;
  const input = { ...current, data: values() };
  backup(); setBusy(true); notice('');
  try {
    const { entry } = await api('/api/site/save', input);
    removeBackup(); display(entry);
    notice(publish ? '内容已保存，正在准备发布。' : `“${label}”已保存到本地。点击「保存并发布」后更新线上网站。`);
    if (publish) {
      const { job } = await api('/api/site/publish', { section, version: entry.version });
      showJob(job); notice('');
      await watchJob();
    }
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
}

byId('site-form').addEventListener('submit', (event) => { event.preventDefault(); void save(); });
byId('publish-site').addEventListener('click', () => { void save(true); });
byId('site-fields').addEventListener('input', changed);
byId('add-project').addEventListener('click', () => {
  const { projects } = values();
  if (busy || projects.length >= 100) return;
  projects.push({ name: '', description: '', href: '', label: '' });
  renderProjects(projects); changed();
  byId('project-cards').lastElementChild.querySelector('input').focus();
});
byId('project-cards').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || busy) return;
  const index = Number(button.closest('.project-card').dataset.index);
  const { projects } = values();
  let destination = index;
  if (button.dataset.action === 'remove') {
    removed.push({ project: projects.splice(index, 1)[0], index });
    byId('removed-label').textContent = `已移除“${removed.at(-1).project.name || '未命名项目'}”，尚未保存。`;
    byId('project-removed').hidden = false;
  } else {
    destination += button.dataset.action === 'up' ? -1 : 1;
    if (destination < 0 || destination >= projects.length) return;
    [projects[index], projects[destination]] = [projects[destination], projects[index]];
  }
  renderProjects(projects); changed();
  if (button.dataset.action === 'remove') byId('undo-remove').focus();
  else byId('project-cards').children[destination].querySelector('input').focus();
});
byId('undo-remove').addEventListener('click', () => {
  if (busy || !removed.length) return;
  const { projects } = values();
  if (projects.length >= 100) { notice('项目已达 100 项，请先移除一个项目再撤销。', true); return; }
  const item = removed.pop();
  projects.splice(item.index, 0, item.project);
  byId('project-removed').hidden = !removed.length;
  if (removed.length) byId('removed-label').textContent = `还可撤销移除“${removed.at(-1).project.name || '未命名项目'}”。`;
  renderProjects(projects); changed();
});
byId('discard-changes').addEventListener('click', () => { byId('discard-prompt').hidden = false; });
byId('cancel-discard').addEventListener('click', () => { byId('discard-prompt').hidden = true; });
byId('confirm-discard').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try { const { entry } = await api(`/api/site?section=${section}`); removeBackup(); display(entry); }
  catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
});
document.querySelectorAll('.section-nav a').forEach((link) => link.addEventListener('click', (event) => { if (!canLeave()) event.preventDefault(); }));
byId('logout').addEventListener('click', async () => {
  if (!canLeave()) return;
  setBusy(true);
  try { await api('/api/logout', {}); busy = false; window.location.replace(`/login?next=${encodeURIComponent(`/site?section=${section}`)}`); }
  catch (error) { notice(error.message, true); setBusy(false); }
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
});
window.addEventListener('beforeunload', (event) => { if (busy || dirty() && !backedUp) { event.preventDefault(); event.returnValue = ''; } });

async function start() {
  try {
    const session = await api('/api/session');
    ({ token, workspace } = session);
    byId('editor-mode').textContent = session.mode === 'lan' ? '局域网写作台' : '本地写作台';
    byId('logout').hidden = session.mode !== 'lan';
    const { entry } = await api(`/api/site?section=${section}`);
    display(entry, true);
    const { job } = await api('/api/status');
    if (job) showJob(job);
    if (job?.status === 'running') await watchJob();
  } catch (error) {
    byId('connection-error').textContent = `连接本地编辑器失败：${error.message}。请确认服务仍在运行，然后刷新页面。`;
    byId('connection-error').hidden = false;
  }
}
void start();
