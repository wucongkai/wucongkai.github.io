import { site } from '@/site.config';
import Link from 'next/link';
import { formatDate, getPosts } from '@/lib/posts';

export default async function Home() {
  const posts = await getPosts();
  return (
    <>
      <header className="page-heading">
        <h1>{site.title}</h1>
      </header>
      <section id="about">
        <h2>关于我</h2>
        {site.bio.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      </section>
      <section id="projects">
        <h2>项目</h2>
        <ul className="project-list">
          {site.projects.map((project) => (
            <li key={project.name}>
              <div className="project-title"><a href={project.href}>{project.name}</a><span className="tag">{project.label}</span></div>
              <p>{project.description}</p>
            </li>
          ))}
        </ul>
      </section>
      <section id="notes">
        <h2>文章 / 笔记</h2>
        {posts.length ? (
          <ul className="note-list">
            {posts.map((post) => (
              <li key={post.slug}>
                <div className="note-line">
                  <Link href={`/notes/${post.slug}/`}>{post.title}</Link>
                  <time dateTime={post.date}>{formatDate(post.date)}</time>
                </div>
                {post.description && <p>{post.description}</p>}
              </li>
            ))}
          </ul>
        ) : <p className="muted">第一篇笔记正在整理中。</p>}
      </section>
      <section id="contact">
        <h2>联系方式</h2>
        <ul className="contact-list">
          <li>GitHub：<a href={site.github}>{site.name}</a></li>
          {site.email && <li>邮箱：<a href={`mailto:${site.email}`}>{site.email}</a></li>}
        </ul>
      </section>
    </>
  );
}
