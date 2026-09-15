import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compileArticle } from '../lib/mdx.mjs';
import { readPostOrder, sortPosts } from '../lib/post-order.mjs';

export class EditorError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function validateSlug(slug) {
  if (typeof slug !== 'string' || slug.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new EditorError('文章网址请使用小写英文字母、数字和连字符，最多 100 个字符。');
  }
  return slug;
}

export function validatePost(input) {
  validateSlug(input.slug);
  for (const [key, label, limit] of [['title', '标题', 200], ['description', '摘要', 2000], ['category', '分类', 100], ['content', '正文', 500000]]) {
    if (typeof input[key] !== 'string' || input[key].length > limit) throw new EditorError(`${label}格式不正确或过长。`);
  }
  if (!input.title.trim()) throw new EditorError('请填写文章标题。');
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
    || Number.isNaN(Date.parse(input.date)) || new Date(input.date).toISOString().slice(0, 10) !== input.date) {
    throw new EditorError('请填写有效的文章日期。');
  }
  if (typeof input.draft !== 'boolean') throw new EditorError('草稿状态不正确。');
  return {
    slug: input.slug, title: input.title.trim(), date: input.date,
    description: input.description, category: input.category.trim() || '笔记',
    draft: input.draft, content: input.content,
  };
}

const versionOf = (source) => createHash('sha256').update(source).digest('hex');

export async function postPath(root, slug) {
  validateSlug(slug);
  const directory = path.join(root, 'content/posts');
  if (await fs.realpath(directory) !== directory) throw new EditorError('文章目录不能是符号链接。');
  const filename = path.join(directory, `${slug}.mdx`);
  const stat = await fs.lstat(filename).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat && !stat.isFile()) throw new EditorError('文章必须是普通文件，不能是符号链接。');
  return filename;
}

export async function readPost(root, slug) {
  const filename = await postPath(root, slug);
  const source = await fs.readFile(filename, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') throw new EditorError('文章不存在。', 404);
    throw error;
  });
  const { data, content } = matter(source);
  return {
    slug, title: String(data.title || slug),
    date: data.date instanceof Date ? data.date.toISOString().slice(0, 10) : String(data.date || ''),
    description: String(data.description || ''), category: String(data.category || '笔记'),
    draft: data.draft === true, content, version: versionOf(source),
  };
}

export async function listPosts(root) {
  const filenames = await fs.readdir(path.join(root, 'content/posts')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return sortPosts(await Promise.all(filenames.filter((name) => name.endsWith('.mdx')).map((name) => readPost(root, name.slice(0, -4)))), await readPostOrder(root));
}

export async function savePost(root, input) {
  const post = validatePost(input);
  // Git does not retain empty directories after the last article has been deleted.
  for (const directory of [path.join(root, 'content'), path.join(root, 'content/posts')]) {
    await fs.mkdir(directory).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    if (await fs.realpath(directory) !== directory) throw new EditorError('文章目录不能是符号链接。');
  }
  const filename = await postPath(root, post.slug);
  const previous = await fs.readFile(filename, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (previous !== null && input.version !== versionOf(previous)) {
    throw new EditorError('这篇文章已在其他窗口或文件中修改，或网址已存在。请复制当前正文留存，再重新打开文章。', 409);
  }
  if (previous === null && input.version) throw new EditorError('文章文件已被移动或删除，请重新打开文章。', 409);
  const { slug, content, ...metadata } = post;
  const extra = previous === null ? {} : matter(previous).data;
  const source = matter.stringify(content, { ...extra, ...metadata });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, source, { flag: 'wx' });
    // A new slug must never overwrite an existing article, even if created concurrently.
    if (previous === null) await fs.link(temporary, filename);
    else await fs.rename(temporary, filename);
  } catch (error) {
    if (error.code === 'EEXIST') throw new EditorError('该文章网址已经存在，请换一个。', 409);
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return readPost(root, slug);
}

export async function backupPost(root, slug, version) {
  const filename = await postPath(root, slug);
  const source = await fs.readFile(filename, 'utf8');
  if (versionOf(source) !== version) throw new EditorError('文章已被修改，请重新打开后再删除。', 409);
  const directory = path.join(root, '.editor-trash');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (await fs.realpath(directory) !== directory) throw new EditorError('删除备份目录不能是符号链接。');
  const backup = path.join(directory, `${slug}-${version}.mdx`);
  try { await fs.writeFile(backup, source, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await fs.lstat(backup)).isFile() || versionOf(await fs.readFile(backup, 'utf8')) !== version) {
      throw new EditorError('已有删除备份异常，请检查 .editor-trash 目录。');
    }
  }
  return path.relative(root, backup);
}

export async function removePostFile(root, slug, version) {
  const filename = await postPath(root, slug);
  const source = await fs.readFile(filename, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (source === null) return true;
  // Never remove changes made in another window while the deletion was being pushed.
  if (versionOf(source) !== version) return false;
  await fs.unlink(filename);
  return true;
}

export async function previewPost(post) {
  const { content } = await compileArticle(post.content || '正文预览会显示在这里。');
  return '<!doctype html>' + renderToStaticMarkup(h('html', { lang: 'zh-CN' },
    h('head', null,
      h('meta', { charSet: 'utf-8' }),
      h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      h('meta', { httpEquiv: 'Content-Security-Policy', content: "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' https: data:; script-src 'none'; base-uri 'none'; form-action 'none'" }),
      h('link', { rel: 'stylesheet', href: '/site.css' }),
      h('link', { rel: 'stylesheet', href: '/editor.css' })),
    h('body', { className: 'preview-body' }, h('main', { className: 'paper preview-paper' },
      h('article', null,
        h('header', { className: 'article-heading' },
          h('p', { className: 'eyebrow' }, post.category || '笔记'),
          h('h1', null, post.title || '未命名文章'),
          h('time', { className: 'article-date', dateTime: post.date }, (post.date || '').replaceAll('-', '.'))),
        h('div', { className: 'prose' }, content))))));
}
