import { parse, stringify } from 'yaml';

export type Article = {
  slug: string;
  title: string;
  date: string;
  description: string;
  category: string;
  draft: boolean;
  content: string;
  extra?: Record<string, unknown>;
};
export type About = {
  name: string;
  title: string;
  description: string;
  bio: string[];
  github: string;
  email: string;
};
export type Project = {
  name: string;
  description: string;
  href: string;
  label: string;
};
export type SiteSection = 'about' | 'projects';

export function validateSlug(slug: string) {
  if (
    typeof slug !== 'string' ||
    slug.length > 100 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
  )
    throw new Error(
      '文章网址请使用小写英文字母、数字和连字符，最多 100 字符。',
    );
  return slug;
}
function text(
  value: unknown,
  label: string,
  max: number,
  required = false,
): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new Error(`${label}不能为空或超出长度限制。`);
  return value;
}
export function validateArticle(input: Article): Article {
  validateSlug(input.slug);
  text(input.title, '标题', 200, true);
  text(input.description, '摘要', 2000);
  text(input.category, '分类', 100);
  text(input.content, '正文', 500000);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
    Number.isNaN(Date.parse(input.date)) ||
    new Date(input.date).toISOString().slice(0, 10) !== input.date
  )
    throw new Error('请填写有效的 YYYY-MM-DD 日期。');
  if (typeof input.draft !== 'boolean') throw new Error('草稿状态无效。');
  return {
    ...input,
    title: input.title.trim(),
    category: input.category.trim() || '笔记',
  };
}
export function parseArticle(source: string, slug: string): Article {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) throw new Error(`${slug}: 缺少文章开头的 YAML 信息。`);
  const data = parse(match[1], { maxAliasCount: 20, uniqueKeys: true });
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error(`${slug}: 文章信息格式无效。`);
  if (data.draft !== undefined && typeof data.draft !== 'boolean')
    throw new Error(`${slug}: draft 必须是 true 或 false。`);
  const {
    title,
    date,
    description = '',
    category = '笔记',
    draft = false,
    ...extra
  } = data;
  return validateArticle({
    slug,
    title,
    date,
    description,
    category,
    draft,
    extra,
    content: source.slice(match[0].length).replace(/^\r?\n/, ''),
  });
}
export function serializeArticle(input: Article): string {
  const { slug, content, extra = {}, ...metadata } = validateArticle(input);
  void slug;
  return `---\n${stringify({ ...extra, ...metadata }, { lineWidth: 0 })}---\n\n${content.replace(/^\n/, '')}${content.endsWith('\n') ? '' : '\n'}`;
}
export function parseOrder(source: string | null): string[] {
  const order: unknown = source === null ? [] : JSON.parse(source);
  if (
    !Array.isArray(order) ||
    order.length > 100000 ||
    new Set(order).size !== order.length
  )
    throw new Error('文章排序必须是不重复的网址列表。');
  order.forEach(validateSlug);
  return order;
}
export function sortPosts<T extends { slug: string; date: string }>(
  posts: T[],
  order: string[],
): T[] {
  const positions = new Map(order.map((slug, index) => [slug, index]));
  return [...posts].sort(
    (a, b) =>
      (positions.get(a.slug) ?? -1) - (positions.get(b.slug) ?? -1) ||
      b.date.localeCompare(a.date) ||
      a.slug.localeCompare(b.slug),
  );
}
export function safeLink(value: string, local = false): string {
  text(value, '链接', 2000, true);
  if (/[\u0000-\u0020\u007f\\]/.test(value))
    throw new Error('链接不能含有空格或反斜杠。');
  if (local && (/^\/(?!\/)/.test(value) || value.startsWith('#'))) return value;
  try {
    const url = new URL(value);
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return value;
  } catch {
    /* Show one useful error. */
  }
  throw new Error('请填写有效的 http(s) 链接。');
}
export function validateAbout(data: About): About {
  text(data.name, '姓名', 200, true);
  text(data.title, '网站标题', 200, true);
  text(data.description, '网站摘要', 2000);
  safeLink(data.github);
  text(data.email, '邮箱', 254);
  if (data.email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(data.email))
    throw new Error('联系邮箱格式不正确。');
  if (!Array.isArray(data.bio) || data.bio.length > 100)
    throw new Error('个人介绍最多 100 段。');
  data.bio.forEach((p) => text(p, '介绍段落', 20000));
  return data;
}
export function validateProjects(data: Project[]): Project[] {
  if (!Array.isArray(data) || data.length > 100)
    throw new Error('项目最多 100 个。');
  const names = new Set<string>();
  for (const p of data) {
    text(p.name, '项目名称', 200, true);
    text(p.description, '项目介绍', 5000);
    text(p.label, '项目状态', 100);
    safeLink(p.href, true);
    if (names.has(p.name.trim())) throw new Error('项目名称不能重复。');
    names.add(p.name.trim());
  }
  return data;
}
