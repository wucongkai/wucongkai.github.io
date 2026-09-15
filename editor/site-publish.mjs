import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EditorError } from './content.mjs';
import { buildSnapshot, run } from './publish.mjs';
import { readSiteSection, replaceSection, validateSection } from './site-content.mjs';

export async function publishSiteSection(root, section, { version, report = () => {}, build = buildSnapshot } = {}) {
  validateSection(section);
  const label = section === 'about' ? '关于我' : '项目';
  const filename = 'site.config.ts';
  const subject = `docs: update ${section}`;
  const git = (args, options = {}) => run('git', args, { cwd: root, ...options });
  const log = (text) => report({ log: text });
  const stage = (text) => report({ stage: text, log: `\n${text}\n` });
  stage(`检查${label}和 Git 仓库`);
  const current = await readSiteSection(root, section);
  if (current.version !== version) throw new EditorError('内容已被修改，请重新载入并保存后发布。', 409);
  if (await git(['branch', '--show-current']) !== 'main') throw new EditorError('请在 main 分支使用发布功能。');
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const gitPath = await git(['rev-parse', '--git-path', marker]);
    if (await fs.stat(path.resolve(root, gitPath)).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) throw new EditorError('Git 正在合并或变基，请先在终端完成后再发布。');
  }
  const head = await git(['rev-parse', 'HEAD']);
  stage('检查远程更新');
  await git(['fetch', 'origin', 'refs/heads/main'], { log });
  const remoteHead = await git(['rev-parse', 'FETCH_HEAD']);
  try { await git(['merge-base', '--is-ancestor', remoteHead, head]); }
  catch { throw new EditorError('远程 main 有新提交。请先在终端同步并解决冲突，再重试；本地内容已保留。'); }
  const pending = (await git(['rev-list', `${remoteHead}..${head}`])).split('\n').filter(Boolean);
  for (const commit of pending) {
    const parents = (await git(['show', '-s', '--format=%P', commit])).split(' ');
    if (await git(['show', '-s', '--format=%s', commit]) !== subject || parents.length !== 1
      || await git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit]) !== filename) {
      throw new EditorError(`main 上还有其他未推送的提交，请先在终端处理。此次只会推送“${label}”及其上次失败的发布。`);
    }
  }
  const sourceAt = (ref) => git(['show', `${ref}:${filename}`], { trim: false, maxOutput: 4000000 });
  const headEntry = await git(['ls-tree', head, '--', filename]);
  const indexEntry = await git(['ls-files', '--stage', '--', filename]);
  if (!/^100(?:644|755) blob [a-f0-9]+\tsite\.config\.ts$/.test(headEntry)
    || !/^100(?:644|755) [a-f0-9]+ 0\tsite\.config\.ts$/.test(indexEntry)) {
    throw new EditorError('网站配置必须已提交且暂存区中没有删除或冲突。请先在终端处理 site.config.ts。');
  }
  const committedSource = replaceSection(await sourceAt(head), section, current.data);
  // Preserve separately staged edits to the other section, including within this same file.
  const stagedSource = replaceSection(await sourceAt(''), section, current.data);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-site-publish-'));
  try {
    const hashSource = async (source, name) => {
      const file = path.join(temporary, name);
      await fs.writeFile(file, source);
      return git(['hash-object', '-w', '--', file]);
    };
    const blob = await hashSource(committedSource, filename);
    const stagedBlob = await hashSource(stagedSource, 'staged.ts');
    const indexEnv = { GIT_INDEX_FILE: path.join(temporary, 'index') };
    await git(['read-tree', head], { env: indexEnv });
    await git(['update-index', '--add', '--cacheinfo', headEntry.slice(0, 6), blob, filename], { env: indexEnv });
    const tree = await git(['write-tree'], { env: indexEnv });
    const directory = path.join(temporary, 'site');
    await fs.mkdir(directory);
    const archive = path.join(temporary, 'site.tar');
    await git(['archive', '--format=tar', `--output=${archive}`, tree]);
    await run('tar', ['-xf', archive, '-C', directory]);
    stage(`构建包含${label}更新的网站（通常需要几十秒）`);
    await build(directory, root, log);
    if (await git(['branch', '--show-current']) !== 'main' || await git(['rev-parse', 'HEAD']) !== head
      || (await readSiteSection(root, section)).version !== version || await git(['ls-files', '--stage', '--', filename]) !== indexEntry) {
      throw new EditorError('构建期间内容或 Git 状态发生变化，请重新载入后再发布。尚未提交或推送。', 409);
    }
    let commit = head;
    if (tree !== await git(['rev-parse', `${head}^{tree}`])) {
      stage(`提交${label}更新`);
      await git(['commit', '-m', subject], { env: indexEnv, log });
      commit = await git(['rev-parse', 'HEAD']);
      if (await git(['rev-parse', `${commit}^{tree}`]) !== tree) throw new EditorError('提交内容与构建结果不一致，已停止推送，请检查 Git hook。');
    }
    if (await git(['ls-files', '--stage', '--', filename]) !== indexEntry) throw new EditorError('暂存区在提交期间发生变化，已停止推送。请先在终端检查，再重试。');
    await git(['update-index', '--cacheinfo', indexEntry.slice(0, 6), stagedBlob, filename]);
    report({ commit: commit.slice(0, 7) });
    stage('推送到 GitHub');
    await git(['push', 'origin', `${commit}:refs/heads/main`], { log });
    stage('已推送，等待 GitHub Pages 部署');
    return { commit: commit.slice(0, 7), pushed: true };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
