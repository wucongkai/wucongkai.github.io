import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EditorError, listPosts, validateSlug } from './content.mjs';
import { orderFilename, parsePostOrder } from '../lib/post-order.mjs';

export async function orderPath(root) {
  const directory = path.join(root, 'content');
  const resolved = await fs.realpath(directory).catch((error) => {
    if (error.code === 'ENOENT') return directory;
    throw error;
  });
  if (resolved !== directory) throw new EditorError('文章目录不能是符号链接。');
  const filename = path.join(root, orderFilename);
  const stat = await fs.lstat(filename).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat && !stat.isFile()) throw new EditorError('排序文件必须是普通文件，不能是符号链接。');
  return filename;
}

export async function listOrderedPosts(root) {
  const filename = await orderPath(root);
  const source = await fs.readFile(filename, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  parsePostOrder(source);
  const posts = await listPosts(root);
  const orderVersion = createHash('sha256').update(JSON.stringify([source, posts.map((post) => post.slug)])).digest('hex');
  return { posts, orderVersion, orderSaved: source !== null };
}

export async function movePost(root, { slug, direction, version }) {
  validateSlug(slug);
  if (!['up', 'down'].includes(direction)) throw new EditorError('请选择上移或下移。');
  const current = await listOrderedPosts(root);
  if (current.orderVersion !== version) throw new EditorError('文章列表或顺序已在其他窗口发生变化，列表已刷新，请重新调整。', 409);
  const slugs = current.posts.map((post) => post.slug);
  const index = slugs.indexOf(slug);
  if (index < 0) throw new EditorError('文章不存在，请刷新列表。', 404);
  const target = index + (direction === 'up' ? -1 : 1);
  if (target < 0 || target >= slugs.length) throw new EditorError('文章已经在列表边界。');
  [slugs[index], slugs[target]] = [slugs[target], slugs[index]];
  const filename = await orderPath(root);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(slugs, null, 2) + '\n', { flag: 'wx' });
    if ((await listOrderedPosts(root)).orderVersion !== version) throw new EditorError('保存期间文章列表发生变化，请重试。', 409);
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); }
  return listOrderedPosts(root);
}
