import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import type { Root, Element } from 'hast';

// Markdown + safe HTML only: no MDX evaluation, imports, or browser-executed JS.
// Both the public pages and the browser preview use this exact pipeline.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, {
    ...defaultSchema,
    // Keep existing article anchors. HTML is rendered in an isolated preview frame.
    clobberPrefix: '',
    attributes: {
      ...defaultSchema.attributes,
      code: [['className', /^language-./, 'math-inline', 'math-display']],
      '*': [...(defaultSchema.attributes?.['*'] || []), 'id'],
    },
  })
  .use(rehypeKatex, { output: 'mathml', trust: false, strict: 'ignore' })
  .use(rehypeHighlight, { detect: false, ignoreMissing: true })
  .use(function tables() {
    return (tree: Root) => {
      visit(tree, 'element', (node: Element, index, parent) => {
        if (
          node.tagName !== 'table' ||
          index === undefined ||
          !parent ||
          (parent.type === 'element' &&
            parent.properties.className?.includes('table-scroll'))
        )
          return;
        parent.children[index] = {
          type: 'element',
          tagName: 'div',
          properties: {
            className: ['table-scroll'],
            role: 'region',
            ariaLabel: '文章表格',
            tabIndex: 0,
          },
          children: [node],
        };
        return index + 1;
      });
    };
  })
  .use(rehypeStringify);

export async function renderArticle(content: string): Promise<string> {
  if (content.length > 500000) throw new Error('正文最多 500000 字符。');
  return String(await processor.process(content));
}
