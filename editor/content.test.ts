import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  parseArticle,
  serializeArticle,
  validateArticle,
  parseOrder,
  sortPosts,
  validateAbout,
  validateProjects,
  type Article,
} from '../lib/content.ts';
import { renderArticle } from '../lib/markdown.ts';
import { articleChanges, parseDraft, type Document } from './workspace.ts';
import { saveBackup, readBackups, removeBackup } from './backups.ts';
const article: Article = {
  slug: 'hello-world',
  title: '中文标题',
  date: '2026-10-25',
  category: '笔记',
  description: '摘要',
  content: '## 正文\n\n你好。\n',
  draft: false,
  extra: { tags: ['test'], custom: 'keep' },
};

test('article parsing preserves metadata, Chinese text, valid dates and safe slugs', () => {
  assert.deepEqual(
    parseArticle(serializeArticle(article), article.slug),
    article,
  );
  assert.throws(() => validateArticle({ ...article, date: '2026-02-30' }));
  assert.throws(() => validateArticle({ ...article, slug: '../secret' }));
  assert.throws(() =>
    parseArticle(
      '---\ntitle: title\ndate: 2026-10-25\ndraft: "true"\n---\ntext',
      'hello',
    ),
  );
  assert.throws(() => parseOrder('["hello","hello"]'));
  assert.deepEqual(
    sortPosts(
      [
        { slug: 'old', date: '2020-01-01' },
        { slug: 'new', date: '2026-01-01' },
      ],
      [],
    ).map((x) => x.slug),
    ['new', 'old'],
  );
});
test('all existing articles render with headings, formulas and working manual anchors', async () => {
  for (const name of await fs.readdir('content/posts')) {
    const post = parseArticle(
      await fs.readFile(`content/posts/${name}`, 'utf8'),
      name.slice(0, -4),
    );
    const html = await renderArticle(post.content);
    assert.equal(typeof html, 'string');
    for (const [, anchor] of post.content.matchAll(/\]\(#([\w-]+)\)/g))
      assert.ok(html.includes(`id="${anchor}"`), `${name} missing ${anchor}`);
  }
});
test('shared renderer supports safe HTML, GFM, code and MathML without executing content', async () => {
  const html = await renderArticle(
    '<h2 id="topic">标题</h2>\n\n<details><summary>更多</summary>说明</details>\n\n| A | B |\n|---|---|\n| 一 | 二 |\n\n```js\nconst answer = 42;\n```\n\n$x^2$\n\n$$\nx+y\n$$\n\n<script>alert(1)</script><img src="x" onerror="alert(1)" /><iframe src="https://example.com"></iframe>\n\n[bad](javascript:alert)\n\n{process.exit()}',
  );
  assert.match(html, /<details>/);
  assert.match(html, /id="topic"/);
  assert.match(html, /class="table-scroll"/);
  assert.match(html, /hljs-keyword/);
  assert.match(html, /<math/);
  assert.doesNotMatch(html, /<script|onerror|<iframe|href="javascript:/);
  assert.match(html, /\{process.exit\(\)\}/);
});
test('draft saves preserve published content; publishing and draft removal form one change set', () => {
  const doc: Document = {
    article,
    baseSha: 'a'.repeat(40),
    draftSha: 'b'.repeat(40),
    cloud: true,
    conflict: false,
  };
  const draft = articleChanges(doc, false);
  assert.equal(draft.length, 1);
  assert.equal(draft[0].path, 'content/drafts/hello-world.json');
  assert.equal(
    parseDraft(draft[0].content!, article.slug).baseSha,
    doc.baseSha,
  );
  const publish = articleChanges(doc, true);
  assert.equal(publish[0].path, 'content/posts/hello-world.mdx');
  assert.equal(publish[1].content, null);
  assert.equal(publish[1].expected, doc.draftSha);
  assert.equal(parseArticle(publish[0].content!, article.slug).draft, false);
});
test('one tab cannot delete another tab recovery entry when saving its own work', () => {
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
    clear: () => data.clear(),
  } satisfies Storage;
  const document: Document = {
    article,
    baseSha: null,
    draftSha: null,
    cloud: false,
    conflict: false,
  };
  saveBackup(storage, 'a/b', {
    id: 'tab-a',
    updatedAt: '2026-10-25T01:00:00Z',
    document,
  });
  saveBackup(storage, 'a/b', {
    id: 'tab-b',
    updatedAt: '2026-10-25T02:00:00Z',
    document: { ...document, article: { ...article, content: 'B' } },
  });
  removeBackup(storage, 'a/b', 'tab-b');
  assert.equal(
    readBackups(storage, 'a/b')[0].document.article.content,
    article.content,
  );
  assert.equal(readBackups(storage, 'other/repo').length, 0);
});
test('site data rejects unsafe links and accepts empty projects and email', () => {
  const about = {
    name: 'Test',
    title: 'Wiki',
    description: '',
    bio: ['你好'],
    github: 'https://github.com/example',
    email: '',
  };
  assert.deepEqual(validateAbout(about), about);
  assert.deepEqual(validateProjects([]), []);
  assert.throws(() =>
    validateProjects([
      { name: 'bad', description: '', href: 'javascript:alert(1)', label: '' },
    ]),
  );
  assert.throws(() =>
    validateProjects([
      { name: 'bad', description: '', href: '//example.com', label: '' },
    ]),
  );
});
