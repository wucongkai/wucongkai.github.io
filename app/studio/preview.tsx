'use client';
import { useEffect, useState } from 'react';
import type { Article } from '@/lib/content';
const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
export default function Preview({ article }: { article: Article }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const { renderArticle } = await import('@/lib/markdown');
        const content = await renderArticle(article.content);
        const styles = [
          ...document.querySelectorAll<HTMLLinkElement>(
            'link[rel="stylesheet"]',
          ),
        ]
          .map((link) => `<link rel="stylesheet" href="${escape(link.href)}">`)
          .join('');
        if (active) {
          setHtml(
            `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' https: data: blob:; base-uri 'none'; form-action 'none'">${styles}<style>body{background:white}main{padding:1.3rem}.prose{max-width:100%}</style></head><body><main><header class="article-heading"><p class="eyebrow">${escape(article.category)}</p><h1>${escape(article.title || '未命名文章')}</h1><time class="article-date">${escape(article.date)}</time></header><div class="prose">${content}</div></main></body></html>`,
          );
          setError('');
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : '预览失败');
      }
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [article]);
  return (
    <div className="studio-preview">
      <p className="studio-pane-label">阅读预览 · 与网站共用排版</p>
      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}
      <iframe title="文章阅读预览" sandbox="allow-same-origin" srcDoc={html} />
    </div>
  );
}
