import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { backupPost, EditorError, readPost, removePostFile, validateSlug } from './content.mjs';

export function run(command, args, { cwd, env = {}, log = () => {}, timeout = 120000, trim = true, maxOutput = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    const collect = (chunk) => { const text = chunk.toString(); output = (output + text).slice(-maxOutput); log(text); };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${command} 执行超时，请检查网络或终端环境后重试。`));
      else if (code !== 0) reject(new Error(output.trim() || `${command} 执行失败（${code}）。`));
      else resolve(trim ? output.trim() : output);
    });
  });
}

export async function buildSnapshot(directory, root, log) {
  await fs.symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  // Webpack can resolve the shared dependencies outside this temporary snapshot.
  await run(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], {
    cwd: directory, log, timeout: 300000, env: { NEXT_TELEMETRY_DISABLED: '1' },
  });
}

export function deletePost(root, slug, options = {}) {
  return publishPost(root, slug, { ...options, operation: 'delete' });
}

export async function publishPost(root, slug, { version, report = () => {}, build = buildSnapshot, operation = 'publish' } = {}) {
  validateSlug(slug);
  const deleting = operation === 'delete';
  const filename = `content/posts/${slug}.mdx`;
  const git = (args, options = {}) => run('git', args, { cwd: root, ...options });
  const log = (text) => report({ log: text });
  const stage = (text) => report({ stage: text, log: `\n${text}\n` });
  stage('检查文章和 Git 仓库');
  const post = await readPost(root, slug);
  if (post.version !== version) throw new EditorError(deleting ? '文章已被修改，请重新打开后再删除。' : '文章已被修改，请重新保存后发布。', 409);
  if (!deleting && post.draft) throw new EditorError('请先将文章保存为公开文章。');
  if (await git(['branch', '--show-current']) !== 'main') throw new EditorError('请在 main 分支使用发布功能，GitHub Pages 会从 main 部署。');
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const gitPath = await git(['rev-parse', '--git-path', marker]);
    if (await fs.stat(path.resolve(root, gitPath)).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) throw new EditorError('Git 正在合并或变基，请先在终端完成后再发布。');
  }
  await git(['remote', 'get-url', 'origin']);
  const head = await git(['rev-parse', 'HEAD']);
  stage('检查远程更新');
  await git(['fetch', 'origin', 'refs/heads/main'], { log });
  const remoteHead = await git(['rev-parse', 'FETCH_HEAD']);
  try { await git(['merge-base', '--is-ancestor', remoteHead, head]); }
  catch { throw new EditorError('远程 main 有新提交。请先在终端同步并解决冲突，再重试；本地文章已保留。'); }

  // A retry may push earlier editor commits for this article, never unrelated local commits.
  const pending = (await git(['rev-list', `${remoteHead}..${head}`])).split('\n').filter(Boolean);
  for (const commit of pending) {
    const subject = await git(['show', '-s', '--format=%s', commit]);
    const paths = await git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit]);
    const parents = (await git(['show', '-s', '--format=%P', commit])).split(' ');
    if (![`docs: publish ${slug}`, `docs: delete ${slug}`].includes(subject) || paths !== filename || parents.length !== 1) {
      throw new EditorError('main 上还有其他未推送的提交，请先在终端处理。编辑器只会推送当前文章及其上次失败的操作。');
    }
  }

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-publish-'));
  try {
    const indexEnv = { GIT_INDEX_FILE: path.join(temporary, 'index') };
    await git(['read-tree', head], { env: indexEnv });
    await git(deleting ? ['update-index', '--force-remove', '--', filename] : ['add', '--', filename], { env: indexEnv });
    const tree = await git(['write-tree'], { env: indexEnv });
    const headTree = await git(['rev-parse', `${head}^{tree}`]);
    const localOnly = deleting && tree === headTree && pending.length === 0;
    const directory = path.join(temporary, 'site');
    await fs.mkdir(directory);
    const archive = path.join(temporary, 'site.tar');
    await git(['archive', '--format=tar', `--output=${archive}`, tree]);
    await run('tar', ['-xf', archive, '-C', directory]);
    if (!localOnly) {
      stage(deleting ? '构建删除文章后的网站（通常需要几十秒）' : '构建待发布网站（通常需要几十秒）');
      // Only the selected article changes in this snapshot. Other edits stay local.
      await build(directory, root, log);
    }
    if (await git(['branch', '--show-current']) !== 'main' || await git(['rev-parse', 'HEAD']) !== head || (await readPost(root, slug)).version !== version) {
      throw new EditorError('构建期间文件或 Git 提交发生变化，请重新打开后再操作。尚未提交或推送。', 409);
    }
    let backup;
    if (deleting) {
      backup = await backupPost(root, slug, version);
      report({ backup });
      log(`\n删除前备份：${backup}\n`);
    }
    let commit = head;
    if (tree !== headTree) {
      stage(deleting ? '提交文章删除' : '提交当前文章');
      if (deleting) {
        // Commit the deletion from the isolated index. Keep the actual file until push succeeds,
        // so a failed push or interrupted process leaves an article that can be selected to retry.
        await git(['commit', '-m', `docs: delete ${slug}`], { env: indexEnv, log });
      } else {
        await git(['add', '--', filename]);
        await git(['commit', '--only', '-m', `docs: publish ${slug}`, '--', filename], { log });
      }
      commit = await git(['rev-parse', 'HEAD']);
      if (await git(['rev-parse', `${commit}^{tree}`]) !== tree) {
        throw new EditorError('提交内容与检查内容不一致，可能有 Git hook 或其他程序修改文件。已停止推送，请在终端检查。');
      }
    }
    if (deleting) await git(['update-index', '--force-remove', '--', filename]);
    if (!localOnly) {
      report({ commit: commit.slice(0, 7) });
      stage('推送到 GitHub');
      // Pin the checked commit rather than a moving HEAD; never force-push.
      await git(['push', 'origin', `${commit}:refs/heads/main`], { log });
      report({ pushed: true });
    }
    if (deleting) {
      const deleted = await removePostFile(root, slug, version);
      stage(deleted ? localOnly ? '本地文章已删除' : '删除已推送，等待网站下线文章' : '线上删除已处理，本地新修改已保留');
      return { commit: localOnly ? null : commit.slice(0, 7), backup, deleted, localOnly, localRetained: !deleted };
    }
    stage('已推送，等待 GitHub Pages 部署');
    return { commit: commit.slice(0, 7) };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
