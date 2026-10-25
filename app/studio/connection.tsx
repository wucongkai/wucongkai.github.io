import { useEffect, useRef, useState } from 'react';
import {
  credentialKey,
  decryptToken,
  encryptToken,
} from '@/editor/credentials';
import type { Repository } from '@/editor/github';

export default function Connection({
  repository,
  connected,
  busy,
  onConnect,
  onDisconnect,
}: {
  repository: Repository;
  connected: boolean;
  busy: boolean;
  onConnect: (token: string) => Promise<boolean>;
  onDisconnect: () => boolean;
}) {
  const repoKey = `${repository.owner}/${repository.name}/${repository.branch}`;
  const key = credentialKey(repoKey);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(false);
  const [useToken, setUseToken] = useState(false);
  const [remember, setRemember] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const working = useRef(false);
  const disabled = busy || pending || !ready;
  const unlocking = saved && !useToken;

  useEffect(() => {
    function sync() {
      try {
        setSaved(localStorage.getItem(key) !== null);
      } catch {
        setNotice('浏览器不允许读取本机设置，仍可使用 GitHub 令牌连接。');
      }
      setReady(true);
    }
    sync();
    function changed(event: StorageEvent) {
      if (event.key === key || event.key === null) sync();
    }
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [key]);

  async function submit(form: HTMLFormElement) {
    if (disabled || working.current) return;
    const data = new FormData(form);
    const password = String(data.get('password') || '');
    const confirm = String(data.get('confirm') || '');
    let token = String(data.get('token') || '');
    const shouldRemember = remember && !unlocking;
    // Clear secret inputs before awaiting crypto/network; nothing goes into React state.
    form.reset();
    working.current = true;
    setPending(true);
    setNotice('');
    try {
      let encrypted: string | null = null;
      if (unlocking) {
        const record = localStorage.getItem(key);
        if (!record) {
          setSaved(false);
          throw new Error('本机凭据已被清除，请重新输入 GitHub 令牌。');
        }
        token = await decryptToken(record, password, repoKey);
      } else if (shouldRemember) {
        if (password !== confirm) throw new Error('两次输入的设备密码不一致。');
        encrypted = await encryptToken(token, password, repoKey);
      }
      if (!(await onConnect(token))) return;
      if (!unlocking) {
        try {
          if (encrypted) localStorage.setItem(key, encrypted);
          else if (saved) localStorage.removeItem(key);
          setSaved(encrypted !== null);
          setUseToken(false);
          setRemember(false);
        } catch {
          setNotice(
            '已连接，但浏览器未能更新本机凭据设置。请检查浏览器存储权限；本次连接仍可使用。',
          );
        }
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '连接失败，请重试。');
    } finally {
      token = '';
      working.current = false;
      setPending(false);
    }
  }

  function forget() {
    if (disabled || !onDisconnect()) return;
    setNotice('');
    try {
      localStorage.removeItem(key);
      setSaved(false);
      setUseToken(false);
      setRemember(false);
      setNotice('已忘记此设备。文章和本机暂存仍保留。');
    } catch {
      setNotice(
        '已断开连接，但浏览器未能删除凭据。请在浏览器设置中清除此网站的存储数据。',
      );
    }
  }

  return (
    <section className="studio-connect" aria-label="GitHub 连接">
      <h2>
        {connected
          ? '已连接 GitHub'
          : unlocking
            ? '解锁你的写作台'
            : '连接你的 GitHub 仓库'}
      </h2>
      <p>
        <a
          href={`https://github.com/${repository.owner}/${repository.name}`}
          target="_blank"
          rel="noreferrer"
        >
          {repository.owner}/{repository.name}
        </a>
      </p>
      {connected ? (
        <>
          <p className="muted">
            {saved
              ? '此设备已记住令牌。刷新或重新打开后，使用设备密码解锁。'
              : '本次连接仅在当前页面有效。下次连接时可勾选「记住此设备」。'}
          </p>
          <div className="studio-actions">
            <button
              disabled={disabled}
              onClick={() => {
                if (onDisconnect()) {
                  setNotice('');
                  setUseToken(false);
                }
              }}
            >
              {saved ? '锁定写作台' : '断开连接'}
            </button>
            {saved && (
              <button disabled={disabled} onClick={forget}>
                忘记此设备
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <form
            key={unlocking ? 'unlock' : 'token'}
            onSubmit={(event) => {
              event.preventDefault();
              void submit(event.currentTarget);
            }}
          >
            <fieldset disabled={disabled}>
              {unlocking ? (
                <>
                  <label htmlFor="device-password">设备密码</label>
                  <div className="studio-connect-row">
                    <input
                      id="device-password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                      maxLength={256}
                      placeholder="输入你为此设备设置的密码"
                    />
                    <button className="primary">
                      {pending ? '解锁中…' : '解锁并连接'}
                    </button>
                  </div>
                  <p className="muted">
                    令牌已加密保存在当前浏览器。忘记密码或令牌过期时，可改用
                    GitHub 令牌重新设置。
                  </p>
                </>
              ) : (
                <>
                  <label htmlFor="github-token">GitHub 细粒度访问令牌</label>
                  <input
                    id="github-token"
                    name="token"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    maxLength={4096}
                    placeholder="github_pat_…"
                  />
                  <label className="studio-remember">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(event) => setRemember(event.target.checked)}
                    />
                    记住此设备（密码保护）
                  </label>
                  {remember && (
                    <div className="studio-passwords">
                      <label>
                        设置设备密码
                        <input
                          name="password"
                          type="password"
                          autoComplete="new-password"
                          required
                          minLength={10}
                          maxLength={256}
                          placeholder="至少 10 个字符，建议使用长句"
                        />
                      </label>
                      <label>
                        确认设备密码
                        <input
                          name="confirm"
                          type="password"
                          autoComplete="new-password"
                          required
                          minLength={10}
                          maxLength={256}
                        />
                      </label>
                      <p className="muted">
                        密码只用于在此浏览器解锁令牌，不会上传。新电脑需首次配置令牌；请只在自己的设备上勾选。
                      </p>
                    </div>
                  )}
                  <button className="primary" type="submit">
                    {pending ? '连接中…' : '连接写作台'}
                  </button>
                  <p className="muted">
                    {remember
                      ? '连接成功后保存加密凭据，刷新后输入设备密码即可。'
                      : saved
                        ? '连接成功后清除此设备的旧凭据，仅保留当前页面的连接。'
                        : '不记住设备时，令牌只在当前页面内存中保存。'}
                  </p>
                </>
              )}
            </fieldset>
          </form>
          {saved && (
            <div className="studio-actions">
              <button
                disabled={disabled}
                onClick={() => {
                  setUseToken(!useToken);
                  setNotice('');
                }}
              >
                {unlocking ? '改用 GitHub 令牌' : '返回密码解锁'}
              </button>
              <button disabled={disabled} onClick={forget}>
                忘记此设备
              </button>
            </div>
          )}
          {!unlocking && (
            <details>
              <summary>第一次使用：如何创建令牌</summary>
              <ol>
                <li>
                  打开{' '}
                  <a
                    href="https://github.com/settings/personal-access-tokens/new"
                    target="_blank"
                    rel="noreferrer"
                  >
                    GitHub 令牌设置
                  </a>
                  ，选择仓库所有者和有效期。
                </li>
                <li>
                  Repository access 选择 Only select repositories，仅选此 Wiki
                  仓库。
                </li>
                <li>
                  Repository permissions 将 Contents 设为 Read and
                  write；Actions 设为 Read-only 可显示部署进度。
                </li>
                <li>生成后粘贴到上方。不要把令牌写入文章、代码或聊天。</li>
              </ol>
            </details>
          )}
        </>
      )}
      <p role="status" className="studio-message">
        {notice}
      </p>
    </section>
  );
}
