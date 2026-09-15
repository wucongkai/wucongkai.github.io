import { EditorError } from './content.mjs';

const oldReturn = '  return posts.filter((post) => !post.draft).sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));';
const newReturn = '  return sortPosts(posts.filter((post) => !post.draft), await readPostOrder(process.cwd()));';
const importLine = "import { readPostOrder, sortPosts } from './post-order.mjs';";

// The first order publication also enables its reader on the already deployed website.
// Patch only the known date-sort expression, preserving all unrelated committed/staged code.
export function enablePostOrder(source) {
  if (source.includes(importLine) && source.includes(newReturn)) return source;
  if (source.split(oldReturn).length !== 2 || source.includes('post-order.mjs') || !source.includes("import matter from 'gray-matter';")) {
    throw new EditorError('网站文章列表代码已有其他调整，无法自动接入排序。请先在终端合并 lib/posts.ts 的排序支持后重试。');
  }
  return source.replace("import matter from 'gray-matter';", `import matter from 'gray-matter';\n${importLine}`).replace(oldReturn, newReturn);
}
