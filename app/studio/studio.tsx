'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { serializeArticle, type Article } from '@/lib/content';
import { GitHub, type Repository } from '@/editor/github';
import {
  articleChanges,
  draftPath,
  listWorkspace,
  loadDocument,
  orderedArticles,
  postPath,
  type Document,
  type Listing,
} from '@/editor/workspace';
import {
  readBackups,
  removeBackup,
  saveBackup,
  type Backup,
} from '@/editor/backups';
import ArticleEditor from './article-editor';
import SiteEditor from './site-editor';
import Connection from './connection';

type Row = { article: Article; published: boolean; cloud: boolean };
type Section = 'articles' | 'projects' | 'about';
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : '操作失败，请重试。';
function newArticle(): Document {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return {
    article: {
      slug: `note-${date}-${crypto.randomUUID().slice(0, 6)}`,
      title: '',
      date,
      category: '学习笔记',
      description: '',
      content: '',
      draft: true,
    },
    baseSha: null,
    draftSha: null,
    cloud: false,
    conflict: false,
  };
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'text/plain;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function Studio({ repository }: { repository: Repository }) {
  const [api, setApi] = useState<GitHub | null>(null);
  const [list, setList] = useState<Listing | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [doc, setDoc] = useState<Document | null>(null);
  const [clean, setClean] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [section, setSection] = useState<Section>('articles');
  const [siteDirty, setSiteDirty] = useState(false);
  const [siteBusy, setSiteBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [backups, setBackups] = useState<Backup[]>([]);
  const [commit, setCommit] = useState('');
  const [deployment, setDeployment] = useState('');
  const [orderDirty, setOrderDirty] = useState(false);
  const ownBackup = useRef('');
  const working = useRef(false);
  const repoKey = `${repository.owner}/${repository.name}/${repository.branch}`;
  const githubUrl = `https://github.com/${repository.owner}/${repository.name}`;
  const actionsUrl = `${githubUrl}/actions/workflows/deploy.yml`;
  const dirty = doc !== null && JSON.stringify(doc.article) !== clean;

  const listBackups = useCallback(() => {
    try {
      setBackups(readBackups(localStorage, repoKey));
    } catch {
      /* Recoverable storage may be unavailable. */
    }
  }, [repoKey]);
  useEffect(() => {
    listBackups();
    window.addEventListener('storage', listBackups);
    return () => window.removeEventListener('storage', listBackups);
  }, [listBackups]);
  const backup = useCallback(() => {
    if (!doc || !dirty) return true;
    try {
      if (!ownBackup.current) ownBackup.current = crypto.randomUUID();
      saveBackup(localStorage, repoKey, {
        id: ownBackup.current,
        updatedAt: new Date().toISOString(),
        document: doc,
      });
      return true;
    } catch {
      return false;
    }
  }, [doc, dirty, repoKey]);
  useEffect(() => {
    if (!backup())
      setMessage('浏览器暂存不可用，请及时保存云端草稿或导出文件。');
    listBackups();
  }, [backup, listBackups]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      backup();
      if (dirty || siteDirty || busy || siteBusy) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [backup, dirty, siteDirty, busy, siteBusy]);
  useEffect(() => {
    if (!api || !commit) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const controller = new AbortController();
    async function poll() {
      try {
        const run = await api!.deployment(commit, controller.signal);
        if (!active) return;
        if (!run) setDeployment('已提交，等待 GitHub Actions 开始部署。');
        else if (run.status !== 'completed')
          setDeployment('Actions 正在检查和部署，线上仍显示上次成功版本。');
        else {
          setDeployment(
            run.conclusion === 'success'
              ? '部署完成，网站已更新。'
              : `部署未完成（${run.conclusion}）。请查看 Actions；线上仍保留上次成功版本。`,
          );
          return;
        }
        if (++attempts < 60) timer = setTimeout(poll, 10000);
        else setDeployment('已停止自动查询，请到 Actions 查看最终结果。');
      } catch {
        if (active)
          setDeployment(
            '提交已完成，暂时无法读取部署进度。请到 Actions 查看；令牌可额外授予 Actions 读取权限。',
          );
      }
    }
    void poll();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, commit]);

  function choose(value: Document) {
    setDoc(value);
    setClean(JSON.stringify(value.article));
    ownBackup.current = '';
    setMessage(
      value.conflict
        ? '云端草稿基于旧文章版本。当前内容可导出保留，请载入已发布版本后合并修改。'
        : value.cloud
          ? '已载入云端草稿，公开文章保持原样。'
          : '已载入文章。',
    );
  }
  function canLeave() {
    if (working.current || siteBusy) return false;
    if (!backup()) {
      setMessage('无法暂存，请先导出或保存云端草稿。');
      return false;
    }
    if (
      siteDirty &&
      !window.confirm('主页修改尚未发布，已尝试暂存在当前浏览器。确定切换？')
    )
      return false;
    return true;
  }
  async function refresh(client = api, preserveOrder = true): Promise<Listing> {
    if (!client) throw new Error('请先连接 GitHub。');
    const result = await listWorkspace(client);
    const documents = await Promise.all(
      result.slugs.map((slug) => loadDocument(client, result, slug)),
    );
    const keepOrder = orderDirty && preserveOrder;
    const ordered = orderedArticles(
      documents.map((d) => d.article),
      keepOrder
        ? { ...result, order: rows.map((row) => row.article.slug) }
        : result,
    );
    setList(result);
    setRows(
      ordered.map((article) => ({
        article,
        cloud: result.drafts.has(article.slug),
        published: result.snapshot.files.has(postPath(article.slug)),
      })),
    );
    setOrderDirty(keepOrder);
    return result;
  }
  async function act(task: () => Promise<void>) {
    if (working.current) return false;
    working.current = true;
    setBusy(true);
    setMessage('');
    try {
      await task();
      return true;
    } catch (e) {
      setMessage(errorText(e));
      return false;
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function connect(token: string) {
    return act(async () => {
      const client = new GitHub(repository, token);
      try {
        const next = await refresh(client);
        setApi(client);
        if (!doc)
          choose(
            next.slugs.length
              ? await loadDocument(client, next, next.slugs[0])
              : newArticle(),
          );
        setMessage('已连接 GitHub，可以继续写作。');
      } catch (e) {
        client.disconnect();
        throw e;
      }
    });
  }
  function disconnect() {
    if (working.current || siteBusy) return false;
    if (
      siteDirty &&
      !window.confirm(
        '主页修改尚未发布，已尝试暂存在当前浏览器。确定断开连接？',
      )
    )
      return false;
    // A failed browser backup must not prevent clearing the live credential.
    const backedUp = backup();
    api?.disconnect();
    setApi(null);
    setList(null);
    setRows([]);
    setCommit('');
    setDeployment('');
    setSection('articles');
    setSiteDirty(false);
    setMessage(
      backedUp
        ? '已断开连接。当前文章和本机暂存仍保留。'
        : '已断开连接，但浏览器暂存失败。当前文章仍在页面中，请导出后再关闭。',
    );
    return true;
  }
  async function open(slug: string, useDraft = true) {
    if (!canLeave() || !api) return;
    await act(async () => {
      const next = await refresh();
      choose(await loadDocument(api, next, slug, useDraft));
    });
  }
  async function save(publish: boolean) {
    if (!api || !doc) return;
    backup();
    await act(async () => {
      if (publish) {
        const { renderArticle } = await import('@/lib/markdown');
        await renderArticle(doc.article.content);
      }
      const changes = articleChanges(doc, publish);
      const publicChanged =
        publish &&
        (!list ||
          (await api.read(list.snapshot, postPath(doc.article.slug))) !==
            changes[0].content);
      const result = await api.commit(
        changes,
        `docs: ${publish ? 'publish' : 'save draft'} ${doc.article.slug}`,
        [{ path: postPath(doc.article.slug), expected: doc.baseSha }],
      );
      if (publicChanged && !result.unchanged) {
        setCommit(result.sha);
        setDeployment('已提交，等待部署。');
      }
      // Keep this page's recovery copy until the new repository state is readable.
      const next = await refresh();
      const updated = await loadDocument(api, next, doc.article.slug);
      try {
        if (ownBackup.current)
          removeBackup(localStorage, repoKey, ownBackup.current);
      } catch {
        /* Keep the copy if storage is unavailable. */
      }
      choose(updated);
      listBackups();
      setMessage(
        publish
          ? publicChanged && !result.unchanged
            ? '文章已提交，等待 Actions 部署完成。'
            : '公开文章没有变化，云端草稿已清理，无需重新部署。'
          : '云端草稿已保存，换台电脑连接后即可继续写；公开文章保持原样。',
      );
    });
  }
  async function removeArticle() {
    if (!api || !doc) return;
    await act(async () => {
      const result = await api.commit(
        [
          {
            path: postPath(doc.article.slug),
            expected: doc.baseSha,
            content: null,
          },
          {
            path: draftPath(doc.article.slug),
            expected: doc.draftSha,
            content: null,
          },
        ],
        `docs: delete ${doc.article.slug}`,
      );
      if (doc.baseSha) {
        setCommit(result.sha);
        setDeployment('删除已提交，等待部署。');
      }
      await refresh();
      choose(newArticle());
      setMessage(
        '文章与云端草稿已删除，可从 GitHub 提交历史恢复。图片仍保留。',
      );
    });
  }
  function update(key: keyof Article, value: string) {
    setDoc(
      (current) =>
        current && {
          ...current,
          article: { ...current.article, [key]: value },
        },
    );
  }

  function exportArticle() {
    if (!doc) return;
    // Export remains available even for incomplete metadata or a network conflict.
    try {
      download(
        `${doc.article.slug || 'note'}.mdx`,
        serializeArticle(doc.article),
      );
    } catch {
      download(
        `${doc.article.slug || 'note'}.json`,
        JSON.stringify(doc, null, 2),
      );
    }
  }
  async function upload(file: File | undefined) {
    if (!api || !doc || !file) return;
    const extensions: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/avif': 'avif',
    };
    if (!extensions[file.type] || file.size > 5 * 1024 * 1024) {
      setMessage('请选择 5 MB 以内的 PNG、JPEG、WebP、GIF 或 AVIF 图片。');
      return;
    }
    await act(async () => {
      const path = `public/images/image-${crypto.randomUUID()}.${extensions[file.type]}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const result = await api.commit(
        [{ path, expected: null, content: btoa(binary), encoding: 'base64' }],
        'docs: upload article image',
      );
      setCommit(result.sha);
      setDeployment('图片已提交，等待部署。');
      update(
        'content',
        doc.article.content +
          `\n\n![图片说明](/${path.slice('public/'.length)})\n`,
      );
      setMessage(
        '图片已上传，引用已插入正文。部署完成后预览可见；请继续保存文章。',
      );
    });
  }
  function move(index: number, delta: number) {
    const next = [...rows];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    setRows(next);
    setOrderDirty(true);
  }
  async function publishOrder() {
    if (!api || !list) return;
    await act(async () => {
      const order = rows.filter((r) => r.published).map((r) => r.article.slug);
      const result = await api.commit(
        [
          {
            path: 'content/post-order.json',
            expected: list.orderSha,
            content: JSON.stringify(order, null, 2) + '\n',
          },
        ],
        'docs: reorder notes',
      );
      if (!result.unchanged) setCommit(result.sha);
      await refresh(api, false);
      setMessage('已保存公开文章顺序。云端草稿在首次发布后可再调整排序。');
    });
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 's' &&
        section === 'articles'
      ) {
        e.preventDefault();
        if (api) void save(false);
        else {
          backup();
          setMessage('已尝试暂存到当前浏览器。连接 GitHub 后可保存云端草稿。');
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  });

  return (
    <div className="studio">
      <div className="studio-heading">
        <div>
          <p className="eyebrow">A SPACE FOR YOUR IDEAS</p>
          <h1>让想法，慢慢成篇。</h1>
          <p className="muted">随时写作，保存在自己的 GitHub 仓库。</p>
        </div>
      </div>
      <Connection
        repository={repository}
        connected={api !== null}
        busy={busy || siteBusy}
        onConnect={connect}
        onDisconnect={disconnect}
      />
      <p role="status" className="studio-message">
        {message}
      </p>
      {api && (
        <nav className="studio-tabs" aria-label="编辑内容">
          {(
            [
              ['articles', '文章 / 笔记'],
              ['projects', '项目'],
              ['about', '关于我'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              aria-current={section === key ? 'page' : undefined}
              disabled={busy}
              onClick={() => {
                if (canLeave()) {
                  setSection(key);
                  setSiteDirty(false);
                }
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
      {section === 'articles' && (
        <>
          {backups.length > 0 && (
            <details className="studio-recovery">
              <summary>本机暂存（{backups.length}）</summary>
              <p className="muted">
                仅此浏览器可见。每个标签页保留独立版本；恢复后仍会检查云端版本。
              </p>
              {backups.map((b) => (
                <div key={b.id}>
                  <span>
                    {b.document.article.title || '未命名文章'} ·{' '}
                    {new Date(b.updatedAt).toLocaleString()}
                  </span>
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (canLeave()) {
                        choose(b.document);
                        setClean('');
                        setMessage('已恢复本机暂存，尚未保存到云端。');
                      }
                    }}
                  >
                    恢复
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      download(
                        `${b.document.article.slug}.json`,
                        JSON.stringify(b.document, null, 2),
                      )
                    }
                  >
                    导出
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          '清除此条本机暂存？请先确认已保存或导出。',
                        )
                      ) {
                        removeBackup(localStorage, repoKey, b.id);
                        listBackups();
                      }
                    }}
                  >
                    清除
                  </button>
                </div>
              ))}
            </details>
          )}
          <div className="studio-layout">
            <aside className="studio-library">
              <div className="studio-actions">
                <button
                  disabled={busy}
                  onClick={() => {
                    if (canLeave()) choose(newArticle());
                  }}
                >
                  ＋ 新建文章
                </button>
                <button
                  disabled={!api || busy}
                  onClick={() => {
                    if (
                      orderDirty &&
                      !window.confirm('刷新会放弃未发布的排序，继续？')
                    )
                      return;
                    void act(async () => {
                      await refresh(api, false);
                      setMessage('列表已刷新，正在编辑的内容保持原样。');
                    });
                  }}
                >
                  刷新列表
                </button>
              </div>
              <label className="sr-only" htmlFor="article-search">
                搜索文章
              </label>
              <input
                id="article-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索标题、分类…"
              />
              <div className="studio-post-list">
                {rows.map(
                  (row, index) =>
                    `${row.article.title} ${row.article.category} ${row.article.slug}`
                      .toLowerCase()
                      .includes(query.toLowerCase()) && (
                      <div key={row.article.slug} className="studio-post-row">
                        <button
                          className={`studio-post ${doc?.article.slug === row.article.slug ? 'active' : ''}`}
                          disabled={busy}
                          onClick={() => void open(row.article.slug)}
                        >
                          <strong>{row.article.title}</strong>
                          <small>
                            {row.cloud
                              ? '云端草稿'
                              : row.article.draft
                                ? '草稿'
                                : row.article.category}{' '}
                            · {row.article.date}
                          </small>
                        </button>
                        <div className="studio-order">
                          <button
                            disabled={busy || !!query || index === 0}
                            onClick={() => move(index, -1)}
                            aria-label={`上移 ${row.article.title}`}
                          >
                            上移
                          </button>
                          <button
                            disabled={
                              busy || !!query || index === rows.length - 1
                            }
                            onClick={() => move(index, 1)}
                            aria-label={`下移 ${row.article.title}`}
                          >
                            下移
                          </button>
                        </div>
                      </div>
                    ),
                )}
              </div>
              {!rows.length && (
                <p className="muted">
                  {api ? '还没有文章，写下第一篇吧。' : '连接后显示云端文章。'}
                </p>
              )}
              <button
                disabled={!api || busy || !orderDirty}
                onClick={() => void publishOrder()}
              >
                发布文章顺序
              </button>
            </aside>
            {doc ? (
              <ArticleEditor
                doc={doc}
                connected={!!api}
                busy={busy}
                dirty={dirty}
                update={update}
                onExport={exportArticle}
                onSave={save}
                onUpload={upload}
                onReload={() => void open(doc.article.slug, false)}
                onDelete={removeArticle}
              />
            ) : (
              <div className="studio-empty">
                <h2>把今天的想法留下来。</h2>
                <p>连接 GitHub 后打开文章，或先新建一篇在浏览器里写作。</p>
              </div>
            )}
          </div>
        </>
      )}
      {api && section !== 'articles' && (
        <SiteEditor
          key={section}
          api={api}
          section={section}
          onCommit={setCommit}
          onDirty={setSiteDirty}
          onBusy={setSiteBusy}
        />
      )}
      {commit && (
        <section className="studio-deployment">
          <strong>{deployment || '已提交，等待部署。'}</strong>
          <p>
            <a
              href={`${githubUrl}/commit/${commit}`}
              target="_blank"
              rel="noreferrer"
            >
              查看提交 {commit.slice(0, 7)}
            </a>{' '}
            ·{' '}
            <a href={actionsUrl} target="_blank" rel="noreferrer">
              查看 Actions 部署进度 ↗
            </a>
          </p>
        </section>
      )}
      <p className="studio-footnote">
        文章使用 Markdown 与安全
        HTML，支持表格、公式、代码高亮和折叠内容。JavaScript 表达式和自定义 MDX
        组件不执行。
      </p>
    </div>
  );
}
