import fs from 'node:fs/promises';
import path from 'node:path';
import { cache } from 'react';
import {
  parseArticle,
  parseOrder,
  sortPosts,
  validateSlug,
  type Article,
} from './content';

export type Post = Article;
const directory = () => path.join(process.cwd(), 'content/posts');
export const getPost = cache(
  async (slug: string): Promise<Post | undefined> => {
    validateSlug(slug);
    const source = await fs
      .readFile(path.join(directory(), `${slug}.mdx`), 'utf8')
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (source === null) return undefined;
    const post = parseArticle(source, slug);
    return post.draft ? undefined : post;
  },
);
export const getPosts = cache(async (): Promise<Post[]> => {
  const names = await fs
    .readdir(directory())
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
  const posts = await Promise.all(
    names.filter((n) => n.endsWith('.mdx')).map((n) => getPost(n.slice(0, -4))),
  );
  const order = await fs
    .readFile(path.join(process.cwd(), 'content/post-order.json'), 'utf8')
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  return sortPosts(
    posts.filter((p): p is Post => Boolean(p)),
    parseOrder(order),
  );
});
export function formatDate(date: string): string {
  return date.replaceAll('-', '.');
}
