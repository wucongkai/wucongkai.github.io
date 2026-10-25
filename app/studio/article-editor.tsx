'use client';
import { useEffect, useRef, useState } from 'react';
import type { Article } from '@/lib/content';
import type { Document } from '@/editor/workspace';
import Preview from './preview';
type Props = {
  doc: Document;
  connected: boolean;
  busy: boolean;
  dirty: boolean;
  update: (key: keyof Article, value: string) => void;
  onExport: () => void;
  onSave: (publish: boolean) => Promise<void>;
  onUpload: (file: File | undefined) => Promise<void>;
  onReload: () => void;
  onDelete: () => Promise<void>;
};
export default function ArticleEditor({
  doc,
  connected,
  busy,
  dirty,
  update,
  onExport,
  onSave,
  onUpload,
  onReload,
  onDelete,
}: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setConfirmDelete(false);
  }, [doc.article, busy]);
  function format(kind: string) {
    if (!textarea.current) return;
    const { selectionStart: start, selectionEnd: end } = textarea.current;
    const selected = doc.article.content.slice(start, end);
    const snippets: Record<string, string> = {
      heading: `\n## ${selected || '小标题'}\n`,
      bold: `**${selected || '加粗文字'}**`,
      link: `[${selected || '链接文字'}](https://example.com)`,
      code: `\n\`\`\`javascript\n${selected || '// 代码'}\n\`\`\`\n`,
      image: `![${selected || '图片说明'}](/images/example.png)`,
    };
    update(
      'content',
      doc.article.content.slice(0, start) +
        snippets[kind] +
        doc.article.content.slice(end),
    );
    textarea.current.focus();
  }
  return (
    <section className="studio-workspace">
      <div className="studio-toolbar">
        <span>
          {dirty
            ? '有未保存到云端的修改'
            : doc.cloud
              ? '已保存云端草稿'
              : doc.baseSha
                ? '已读取仓库版本'
                : '新文章'}
        </span>
        <div className="studio-actions">
          <button disabled={busy} onClick={onExport}>
            导出文件
          </button>
          <button
            disabled={!connected || busy}
            onClick={() => void onSave(false)}
          >
            保存云端草稿
          </button>
          <button
            className="primary"
            disabled={!connected || busy}
            onClick={() => void onSave(true)}
          >
            {busy ? '正在处理…' : '发布到网站'}
          </button>
        </div>
      </div>
      <p className="studio-draft-note">
        云端草稿不会出现在网站上，但会提交到公开仓库。私人内容请只保存在本机或导出。
      </p>
      <fieldset disabled={busy} className="studio-fields">
        <label>
          文章标题
          <input
            className="studio-title"
            value={doc.article.title}
            maxLength={200}
            onChange={(e) => update('title', e.target.value)}
            placeholder="给这篇文章起个名字…"
          />
        </label>
        <div className="studio-metadata">
          <label>
            文章网址
            <input
              value={doc.article.slug}
              readOnly={!!doc.baseSha || !!doc.draftSha}
              maxLength={100}
              onChange={(e) => update('slug', e.target.value)}
            />
          </label>
          <label>
            日期
            <input
              type="date"
              value={doc.article.date}
              onChange={(e) => update('date', e.target.value)}
            />
          </label>
          <label>
            分类
            <input
              value={doc.article.category}
              maxLength={100}
              onChange={(e) => update('category', e.target.value)}
            />
          </label>
        </div>
        <label>
          摘要
          <textarea
            rows={2}
            value={doc.article.description}
            maxLength={2000}
            onChange={(e) => update('description', e.target.value)}
          />
        </label>
        <div className="studio-actions studio-format">
          {[
            ['heading', 'H₂'],
            ['bold', '加粗'],
            ['link', '链接'],
            ['code', '代码'],
            ['image', '图片引用'],
          ].map(([key, label]) => (
            <button key={key} onClick={() => format(key)}>
              {label}
            </button>
          ))}
          <label className="studio-upload">
            上传图片
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
              disabled={!connected}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                void onUpload(file);
              }}
            />
          </label>
        </div>
        <div className="studio-panes">
          <label className="studio-source">
            正文 · Markdown
            <textarea
              ref={textarea}
              value={doc.article.content}
              maxLength={500000}
              spellCheck={false}
              onChange={(e) => update('content', e.target.value)}
              placeholder="从一小段记录开始。"
            />
            <small>
              {doc.article.content.replace(/\s/g, '').length.toLocaleString()}{' '}
              字符 · ⌘ / Ctrl + S 保存云端草稿
            </small>
          </label>
          <Preview article={doc.article} />
        </div>
      </fieldset>
      <div className="studio-actions studio-bottom">
        <button
          disabled={!connected || busy || !doc.baseSha}
          onClick={() => {
            if (
              !dirty ||
              window.confirm('当前修改已尝试暂存，载入已发布版本？')
            )
              onReload();
          }}
        >
          载入已发布版本
        </button>
        <button
          className="danger"
          disabled={!connected || busy || (!doc.baseSha && !doc.draftSha)}
          onClick={() => setConfirmDelete(true)}
        >
          删除文章
        </button>
      </div>
      {confirmDelete && (
        <div className="studio-delete" role="alert">
          <p>
            删除“{doc.article.title}
            ”及其云端草稿？已发布文章会在部署完成后下线，Git 历史仍可恢复。
          </p>
          <button
            disabled={busy}
            className="danger"
            onClick={() => void onDelete()}
          >
            确认删除
          </button>
          <button onClick={() => setConfirmDelete(false)}>取消</button>
        </div>
      )}
    </section>
  );
}
