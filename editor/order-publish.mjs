import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EditorError } from './content.mjs';
import { listOrderedPosts } from './post-order.mjs';
import { orderFilename } from '../lib/post-order.mjs';
import { enablePostOrder } from './order-support.mjs';
import { buildSnapshot, run } from './publish.mjs';

export async function publishPostOrder(root, { version, report = () => {}, build = buildSnapshot } = {}) {
  const git = (args, options = {}) => run('git', args, { cwd: root, ...options });
  const log = (text) => report({ log: text });
  const stage = (text) => report({ stage: text, log: `\n${text}\n` });
  const subject = 'docs: reorder notes';
  const readerPath = 'lib/posts.ts';
  const helperPath = 'lib/post-order.mjs';
  const allowedPaths = [orderFilename, readerPath, helperPath];
  stage('检查文章顺序和 Git 仓库');
  const current = await listOrderedPosts(root);
  if (current.orderVersion !== version) throw new EditorError('文章列表或顺序已发生变化，请刷新后重新发布排序。', 409);
  if (!current.orderSaved) throw new EditorError('请先调整文章顺序。');
  if (await git(['branch', '--show-current']) !== 'main') throw new EditorError('请在 main 分支使用发布功能。');
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const gitPath = await git(['rev-parse', '--git-path', marker]);
    if (await fs.stat(path.resolve(root, gitPath)).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) throw new EditorError('Git 正在合并或变基，请先在终端完成。');
  }
  const head = await git(['rev-parse', 'HEAD']);
  stage('检查远程更新');
  await git(['fetch', 'origin', 'refs/heads/main'], { log });
  const remoteHead = await git(['rev-parse', 'FETCH_HEAD']);
  try { await git(['merge-base', '--is-ancestor', remoteHead, head]); }
  catch { throw new EditorError('远程 main 有新提交，请先在终端同步并解决冲突；本地顺序已保留。'); }
  const pending = (await git(['rev-list', `${remoteHead}..${head}`])).split('\n').filter(Boolean);
  for (const commit of pending) {
    const paths = (await git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit])).split('\n').filter(Boolean);
    if (await git(['show', '-s', '--format=%s', commit]) !== subject || !paths.length || paths.some((filename) => !allowedPaths.includes(filename))
      || (await git(['show', '-s', '--format=%P', commit])).split(' ').length !== 1) {
      throw new EditorError('main 上还有其他未推送的提交，请先在终端处理。此次只会推送文章排序及其上次失败的发布。');
    }
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-order-publish-'));
  try {
    const sourceAt = (ref, filename) => git(['show', `${ref}:${filename}`], { trim: false, maxOutput: 16000000 });
    const tracked = new Set((await git(['ls-tree', '-r', '--name-only', head, '--', 'content/posts'], { maxOutput: 16000000 })).split('\n')
      .map((filename) => /^content\/posts\/([a-z0-9]+(?:-[a-z0-9]+)*)\.mdx$/.exec(filename)?.[1]).filter(Boolean));
    const orderedSlugs = current.posts.map((post) => post.slug).filter((slug) => tracked.has(slug));
    // Uncommitted drafts never enter this publication, including their filenames.
    const orderSource = JSON.stringify(orderedSlugs, null, 2) + '\n';
    const helperSource = await fs.readFile(new URL('../lib/post-order.mjs', import.meta.url), 'utf8');
    const prepared = [];
    for (const filename of allowedPaths) {
      const headEntry = await git(['ls-tree', head, '--', filename]);
      const indexEntry = await git(['ls-files', '--stage', '--', filename]);
      if (headEntry && !/^100(?:644|755) blob [a-f0-9]+\t/.test(headEntry)
        || indexEntry && !/^100(?:644|755) [a-f0-9]+ 0\t[^\n]+$/.test(indexEntry)
        || headEntry && !indexEntry) throw new EditorError(`${filename} 有删除、冲突或不是普通文件，请先在终端检查。`);
      let source = orderSource;
      let stagedSource = source;
      if (filename === readerPath) {
        if (!headEntry) throw new EditorError('网站缺少 lib/posts.ts，请先提交网站代码。');
        source = enablePostOrder(await sourceAt(head, filename));
        stagedSource = enablePostOrder(await sourceAt('', filename));
      }
      if (filename === helperPath) {
        source = stagedSource = helperSource;
        if (headEntry && await sourceAt(head, filename) !== source || indexEntry && await sourceAt('', filename) !== source) {
          throw new EditorError('排序辅助文件有其他修改，请先在终端合并 lib/post-order.mjs 再重试。');
        }
      }
      const hash = async (text, suffix) => {
        const file = path.join(temporary, path.basename(filename) + suffix);
        await fs.writeFile(file, text);
        return git(['hash-object', '-w', '--', file]);
      };
      prepared.push({ filename, indexEntry, mode: headEntry.slice(0, 6) || '100644', indexMode: indexEntry.slice(0, 6) || '100644', blob: await hash(source, '.publish'), stagedBlob: await hash(stagedSource, '.staged') });
    }
    const indexEnv = { GIT_INDEX_FILE: path.join(temporary, 'index') };
    await git(['read-tree', head], { env: indexEnv });
    for (const file of prepared) await git(['update-index', '--add', '--cacheinfo', file.mode, file.blob, file.filename], { env: indexEnv });
    const tree = await git(['write-tree'], { env: indexEnv });
    const directory = path.join(temporary, 'site');
    await fs.mkdir(directory);
    const archive = path.join(temporary, 'site.tar');
    await git(['archive', '--format=tar', `--output=${archive}`, tree]);
    await run('tar', ['-xf', archive, '-C', directory]);
    stage('构建调整顺序后的网站（通常需要几十秒）');
    await build(directory, root, log);
    const unchangedIndex = async () => {
      for (const file of prepared) if (await git(['ls-files', '--stage', '--', file.filename]) !== file.indexEntry) return false;
      return true;
    };
    if (await git(['branch', '--show-current']) !== 'main' || await git(['rev-parse', 'HEAD']) !== head
      || (await listOrderedPosts(root)).orderVersion !== version || !await unchangedIndex()) {
      throw new EditorError('构建期间文章顺序或 Git 状态发生变化，请刷新后重试。尚未提交或推送。', 409);
    }
    let commit = head;
    if (tree !== await git(['rev-parse', `${head}^{tree}`])) {
      stage('提交文章排序');
      await git(['commit', '-m', subject], { env: indexEnv, log });
      commit = await git(['rev-parse', 'HEAD']);
      if (await git(['rev-parse', `${commit}^{tree}`]) !== tree) throw new EditorError('提交内容与构建结果不一致，已停止推送，请检查 Git hook。');
    }
    if (!await unchangedIndex()) throw new EditorError('暂存区在提交期间发生变化，已停止推送。请先在终端检查。');
    for (const file of prepared) await git(['update-index', '--add', '--cacheinfo', file.indexMode, file.stagedBlob, file.filename]);
    report({ commit: commit.slice(0, 7) });
    stage('推送文章排序到 GitHub');
    await git(['push', 'origin', `${commit}:refs/heads/main`], { log });
    stage('排序已推送，等待 GitHub Pages 部署');
    return { commit: commit.slice(0, 7), pushed: true };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
