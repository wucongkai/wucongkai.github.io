import type { Metadata } from 'next';
import Link from 'next/link';
import '@fontsource/merienda-one/latin-400.css';
import '@fontsource/kalam/latin-400.css';
import '@fontsource/kalam/latin-700.css';
import '@fontsource/fira-mono/latin-400.css';
import { site } from '@/site.config';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.title, template: `%s · ${site.name}` },
  description: site.description,
  icons: { icon: '/favicon.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main">跳到正文</a>
        <header className="site-header">
          <div className="header-inner">
            <Link className="wordmark" href="/">{site.title}</Link>
            <nav aria-label="主导航">
              <Link href="/#about">关于</Link>
              <Link href="/#projects">项目</Link>
              <Link href="/#notes">笔记</Link>
              <Link href="/#contact">联系</Link>
            </nav>
          </div>
        </header>
        <div className="page-shell"><main className="paper" id="main">{children}</main></div>
        <footer className="site-footer">
          <span>© {new Date().getFullYear()} {site.name}</span>
          <a href={site.github}>GitHub</a>
        </footer>
      </body>
    </html>
  );
}
