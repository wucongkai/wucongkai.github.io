import { createElement } from 'react';
import { compileMDX } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';

// Both the published page and the local editor use this renderer.
export function compileArticle(source) {
  return compileMDX({
    source,
    options: {
      mdxOptions: {
        remarkPlugins: [remarkGfm, remarkMath],
        // Native MathML keeps formulas readable in the site and the offline editor
        // without loading a browser script, external stylesheet, or font service.
        rehypePlugins: [[rehypeKatex, { output: 'mathml' }], rehypeHighlight],
      },
    },
    components: {
      table: (props) => createElement('div', {
        className: 'table-scroll', role: 'region', 'aria-label': '文章表格', tabIndex: 0,
      }, createElement('table', props)),
    },
  });
}
