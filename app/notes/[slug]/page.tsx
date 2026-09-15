import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { compileArticle } from '@/lib/mdx.mjs';
import { formatDate, getPost, getPosts } from '@/lib/posts';

export const dynamicParams = false;

export async function generateStaticParams() {
  const posts = await getPosts();
  // Keep the route exportable even before the first published article exists.
  return posts.length ? posts.map(({ slug }) => ({ slug })) : [{ slug: 'no-published-notes' }];
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return { title: '文章未找到', robots: { index: false } };
  return {
    title: post.title,
    description: post.description,
    alternates: { canonical: `/notes/${post.slug}/` },
  };
}

export default async function Note({ params }: Props) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();
  const { content } = await compileArticle(post.content);
  return (
    <>
      <Link className="back-link" href="/#notes">← 返回文章列表</Link>
      <article>
        <header className="article-heading">
          <p className="eyebrow">{post.category}</p>
          <h1>{post.title}</h1>
          <time className="article-date" dateTime={post.date}>{formatDate(post.date)}</time>
        </header>
        <div className="prose">{content}</div>
      </article>
      <div className="article-end"><Link href="/#notes">← 更多文章 / 笔记</Link></div>
    </>
  );
}
