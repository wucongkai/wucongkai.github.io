import { createElement } from 'react';
import { compileMDX } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

// Both the published page and the local editor use this renderer.
export function compileArticle(source) {
  return compileMDX({
    source,
    options: { mdxOptions: { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeHighlight] } },
    components: {
      table: (props) => createElement('div', {
        className: 'table-scroll', role: 'region', 'aria-label': '文章表格', tabIndex: 0,
      }, createElement('table', props)),
    },
  });
}
