import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="not-found">
      <p className="eyebrow">404</p>
      <h1>这一页还没有写好</h1>
      <p>地址可能有误，或者这篇文章已经移走了。</p>
      <p><Link href="/">← 返回首页</Link></p>
    </div>
  );
}
