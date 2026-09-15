import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { readPostOrder, sortPosts } from './post-order.mjs';

export type Post = {
  slug: string;
  title: string;
  date: string;
  description: string;
  category: string;
  draft: boolean;
  content: string;
};

export async function getPosts(): Promise<Post[]> {
  const directory = path.join(process.cwd(), 'content/posts');
  const filenames = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const posts = await Promise.all(filenames.filter((name) => name.endsWith('.mdx')).map(async (filename) => {
    const { data, content } = matter(await fs.readFile(path.join(directory, filename), 'utf8'));
    const slug = filename.slice(0, -4);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error(`${filename}: 文件名请使用小写英文字母、数字和连字符。`);
    }
    if (typeof data.title !== 'string' || !data.title.trim()) {
      throw new Error(`${filename}: 请填写 title。`);
    }
    const date = data.date instanceof Date ? data.date.toISOString().slice(0, 10) : data.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
      throw new Error(`${filename}: date 应为有效的 YYYY-MM-DD 日期。`);
    }
    return {
      slug,
      title: data.title.trim(),
      date,
      description: typeof data.description === 'string' ? data.description : '',
      category: typeof data.category === 'string' ? data.category : '笔记',
      draft: data.draft === true,
      content,
    };
  }));
  return sortPosts(posts.filter((post) => !post.draft), await readPostOrder(process.cwd()));
}

export async function getPost(slug: string): Promise<Post | undefined> {
  return (await getPosts()).find((post) => post.slug === slug);
}

export function formatDate(date: string): string {
  return date.replaceAll('-', '.');
}
