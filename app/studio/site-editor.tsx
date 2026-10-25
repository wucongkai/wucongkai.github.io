'use client';
import { useEffect, useState } from 'react';
import {
  validateAbout,
  validateProjects,
  type About,
  type Project,
  type SiteSection,
} from '@/lib/content';
import type { GitHub } from '@/editor/github';

type Props = {
  api: GitHub;
  section: SiteSection;
  onCommit: (sha: string) => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
};
export default function SiteEditor({
  api,
  section,
  onCommit,
  onDirty,
  onBusy,
}: Props) {
  const [data, setData] = useState<About | Project[] | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [clean, setClean] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [backupId] = useState(() => crypto.randomUUID());
  const path = `content/site/${section}.json`;
  const prefix = `wiki-studio-site:${api.repo.owner}/${api.repo.name}/${api.repo.branch}:${section}:`;
  const dirty = data !== null && JSON.stringify(data) !== clean;
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  async function load() {
    setBusy(true);
    try {
      const snapshot = await api.snapshot();
      const source = await api.read(snapshot, path);
      if (source === null)
        throw new Error('未找到主页数据，请先合入本次改造代码。');
      const value = JSON.parse(source);
      section === 'about' ? validateAbout(value) : validateProjects(value);
      setData(value);
      setClean(JSON.stringify(value));
      setVersion(snapshot.files.get(path)!.sha);
      setMessage('已读取云端内容。');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load(); /* A section has its own mounted form. */
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    onDirty(dirty);
    if (dirty) {
      try {
        localStorage.setItem(
          prefix + backupId,
          JSON.stringify({ data, version, saved: Date.now() }),
        );
      } catch {
        setMessage('浏览器暂存不可用，请及时发布或复制内容。');
      }
    }
  }, [data, dirty, version, backupId, prefix, onDirty]);
  function restore() {
    try {
      const items = Object.keys(localStorage)
        .filter((k) => k.startsWith(prefix))
        .map((k) => JSON.parse(localStorage.getItem(k)!))
        .sort((a, b) => b.saved - a.saved);
      if (!items.length) {
        setMessage('此浏览器没有暂存内容。');
        return;
      }
      const latest = items[0];
      section === 'about'
        ? validateAbout(latest.data)
        : validateProjects(latest.data);
      setData(latest.data);
      setVersion(latest.version);
      setMessage('已恢复本机暂存；发布时会检查云端版本。');
    } catch {
      setMessage('暂存内容无法恢复。');
    }
  }
  async function publish() {
    if (!data || busy) return;
    setBusy(true);
    try {
      section === 'about'
        ? validateAbout(data as About)
        : validateProjects(data as Project[]);
      const result = await api.commit(
        [
          {
            path,
            expected: version,
            content: JSON.stringify(data, null, 2) + '\n',
          },
        ],
        `docs: update ${section}`,
      );
      if (!result.unchanged) onCommit(result.sha);
      try {
        localStorage.removeItem(prefix + backupId);
      } catch {
        /* Remote commit succeeded. */
      }
      setClean(JSON.stringify(data));
      onDirty(false);
      await load();
      setMessage(
        result.unchanged
          ? '内容与云端一致，无需重复发布。'
          : '已提交，等待 Actions 构建部署。',
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '发布失败');
    } finally {
      setBusy(false);
    }
  }
  const about = data as About;
  const projects = data as Project[];
  return (
    <section className="studio-site">
      <div className="studio-actions">
        <button onClick={restore} disabled={busy}>
          恢复本机暂存
        </button>
        <button
          onClick={() => {
            if (
              !dirty ||
              window.confirm('当前修改已尝试暂存到此浏览器，载入云端版本？')
            )
              void load();
          }}
          disabled={busy}
        >
          载入云端版本
        </button>
        <button
          className="primary"
          disabled={!data || busy}
          onClick={() => void publish()}
        >
          {busy ? '正在处理…' : '发布更新'}
        </button>
      </div>
      <p role="status" className="studio-message">
        {message}
      </p>
      <p className="muted">
        编辑会暂存在当前浏览器；发布后可在其他设备读取。科研成果仍通过仓库中的
        publications.json 维护。
      </p>
      {data && (
        <fieldset disabled={busy}>
          {section === 'about' ? (
            <div className="studio-about">
              {(
                [
                  ['name', '姓名 / 昵称'],
                  ['title', '网站标题'],
                  ['description', '网站摘要'],
                  ['github', 'GitHub 主页'],
                  ['email', '联系邮箱'],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    value={about[key]}
                    onChange={(e) =>
                      setData({ ...about, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
              <label>
                个人介绍（空一行分段）
                <textarea
                  rows={9}
                  value={about.bio.join('\n\n')}
                  onChange={(e) =>
                    setData({ ...about, bio: e.target.value.split('\n\n') })
                  }
                />
              </label>
            </div>
          ) : (
            <div>
              {projects.map((project, index) => (
                <div className="studio-project" key={index}>
                  <div className="studio-actions">
                    <strong>项目 {index + 1}</strong>
                    <button
                      disabled={index === 0}
                      onClick={() => {
                        const next = [...projects];
                        [next[index - 1], next[index]] = [
                          next[index],
                          next[index - 1],
                        ];
                        setData(next);
                      }}
                    >
                      上移
                    </button>
                    <button
                      disabled={index === projects.length - 1}
                      onClick={() => {
                        const next = [...projects];
                        [next[index + 1], next[index]] = [
                          next[index],
                          next[index + 1],
                        ];
                        setData(next);
                      }}
                    >
                      下移
                    </button>
                    <button
                      onClick={() => {
                        if (
                          window.confirm(
                            `移除项目“${project.name || '未命名'}”？发布前可载入云端版本恢复。`,
                          )
                        )
                          setData(projects.filter((_, i) => i !== index));
                      }}
                    >
                      移除
                    </button>
                  </div>
                  {(
                    [
                      ['name', '项目名称'],
                      ['description', '简介'],
                      ['href', '链接'],
                      ['label', '状态'],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        value={project[key]}
                        onChange={(e) =>
                          setData(
                            projects.map((p, i) =>
                              i === index ? { ...p, [key]: e.target.value } : p,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
              ))}
              <button
                onClick={() =>
                  setData([
                    ...projects,
                    { name: '', description: '', href: 'https://', label: '' },
                  ])
                }
              >
                ＋ 添加项目
              </button>
            </div>
          )}
        </fieldset>
      )}
    </section>
  );
}
