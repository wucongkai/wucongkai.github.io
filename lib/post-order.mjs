import fs from 'node:fs/promises';
import path from 'node:path';

export const orderFilename = 'content/post-order.json';

export function parsePostOrder(source) {
  const order = source === null ? [] : JSON.parse(source);
  if (!Array.isArray(order) || order.length > 100000 || new Set(order).size !== order.length
    || !order.every((slug) => typeof slug === 'string' && slug.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))) {
    throw new Error('文章排序文件必须是不重复的文章网址列表。');
  }
  return order;
}

export async function readPostOrder(root) {
  const filename = path.join(root, orderFilename);
  const source = await fs.readFile(filename, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return parsePostOrder(source);
}

/**
 * @template {{slug: string, date: string}} T
 * @param {T[]} posts
 * @param {string[]} order
 * @returns {T[]}
 */
export function sortPosts(posts, order) {
  const positions = new Map(order.map((slug, index) => [slug, index]));
  // New entries appear first. Existing entries retain their explicitly chosen order.
  return [...posts].sort((a, b) => (positions.get(a.slug) ?? -1) - (positions.get(b.slug) ?? -1)
    || b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}
