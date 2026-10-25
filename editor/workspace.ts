import {
  parseArticle,
  parseOrder,
  serializeArticle,
  sortPosts,
  validateArticle,
  validateSlug,
  type Article,
} from '../lib/content.ts';
import { GitHub, type Change, type Snapshot } from './github.ts';
export type Draft = {
  schema: 1;
  article: Article;
  baseSha: string | null;
  updatedAt: string;
};
export type Document = {
  article: Article;
  baseSha: string | null;
  draftSha: string | null;
  cloud: boolean;
  conflict: boolean;
};
export type Listing = {
  snapshot: Snapshot;
  slugs: string[];
  drafts: Set<string>;
  order: string[];
  orderSha: string | null;
};
export const postPath = (slug: string) =>
  `content/posts/${validateSlug(slug)}.mdx`;
export const draftPath = (slug: string) =>
  `content/drafts/${validateSlug(slug)}.json`;
export async function listWorkspace(api: GitHub): Promise<Listing> {
  const snapshot = await api.snapshot();
  const slugs = new Set<string>(),
    drafts = new Set<string>();
  for (const path of snapshot.files.keys()) {
    const match =
      /^content\/(posts|drafts)\/([a-z0-9]+(?:-[a-z0-9]+)*)\.(mdx|json)$/.exec(
        path,
      );
    if (
      !match ||
      (match[1] === 'posts' ? match[3] !== 'mdx' : match[3] !== 'json')
    )
      continue;
    slugs.add(match[2]);
    if (match[1] === 'drafts') drafts.add(match[2]);
  }
  const order = parseOrder(await api.read(snapshot, 'content/post-order.json'));
  return {
    snapshot,
    slugs: [...slugs],
    drafts,
    order,
    orderSha: snapshot.files.get('content/post-order.json')?.sha ?? null,
  };
}
export function parseDraft(source: string, slug: string): Draft {
  const data = JSON.parse(source) as Draft;
  if (
    data.schema !== 1 ||
    data.article?.slug !== slug ||
    (data.baseSha !== null && !/^[a-f0-9]{40,64}$/.test(data.baseSha))
  )
    throw new Error('云端草稿格式无效。');
  return { ...data, article: validateArticle(data.article) };
}
export async function loadDocument(
  api: GitHub,
  list: Listing,
  slug: string,
  useDraft = true,
): Promise<Document> {
  const baseSha = list.snapshot.files.get(postPath(slug))?.sha ?? null;
  const draftSha = list.snapshot.files.get(draftPath(slug))?.sha ?? null;
  if (useDraft && draftSha) {
    const draft = parseDraft(
      (await api.read(list.snapshot, draftPath(slug)))!,
      slug,
    );
    return {
      article: draft.article,
      baseSha: draft.baseSha,
      draftSha,
      cloud: true,
      conflict: draft.baseSha !== baseSha,
    };
  }
  const source = await api.read(list.snapshot, postPath(slug));
  if (source === null) throw new Error('这篇文章尚未发布，请打开云端草稿。');
  return {
    article: parseArticle(source, slug),
    baseSha,
    draftSha,
    cloud: false,
    conflict: false,
  };
}
export function articleChanges(doc: Document, publish: boolean): Change[] {
  const article = validateArticle(doc.article);
  if (!publish)
    return [
      {
        path: draftPath(article.slug),
        expected: doc.draftSha,
        content:
          JSON.stringify(
            {
              schema: 1,
              article,
              baseSha: doc.baseSha,
              updatedAt: new Date().toISOString(),
            } satisfies Draft,
            null,
            2,
          ) + '\n',
      },
    ];
  return [
    {
      path: postPath(article.slug),
      expected: doc.baseSha,
      content: serializeArticle({ ...article, draft: false }),
    },
    { path: draftPath(article.slug), expected: doc.draftSha, content: null },
  ];
}
export function orderedArticles(articles: Article[], list: Listing) {
  return sortPosts(articles, list.order);
}
