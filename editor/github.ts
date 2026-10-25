export type Repository = { owner: string; name: string; branch: string };
export type Entry = {
  path: string;
  sha: string;
  type: string;
  mode: string;
  size?: number;
};
export type Snapshot = {
  head: string;
  tree: string;
  files: Map<string, Entry>;
};
export type Change = {
  path: string;
  expected: string | null;
  content: string | null;
  encoding?: 'base64';
};
export class ConflictError extends Error {
  constructor(
    message = '仓库内容已在其他设备更新。当前编辑已保留，请先导出或暂存，再载入最新版本。',
  ) {
    super(message);
  }
}
export function editablePath(path: string) {
  return (
    /^content\/(posts\/[a-z0-9]+(?:-[a-z0-9]+)*\.mdx|drafts\/[a-z0-9]+(?:-[a-z0-9]+)*\.json|site\/(about|projects)\.json|post-order\.json)$/.test(
      path,
    ) || /^public\/images\/[a-z0-9-]+\.(png|jpg|jpeg|webp|gif|avif)$/.test(path)
  );
}
export function decodeBase64(value: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(atob(value.replace(/\s/g, '')), (c) => c.charCodeAt(0)),
  );
}
export class GitHub {
  #token: string;
  #fetch: typeof fetch;
  #blobs = new Map<string, string>();
  readonly repo: Repository;
  readonly base: string;
  constructor(repo: Repository, token: string, fetcher: typeof fetch = fetch) {
    if (
      !/^[a-zA-Z0-9-]+$/.test(repo.owner) ||
      !/^[a-zA-Z0-9_.-]+$/.test(repo.name) ||
      !/^[a-zA-Z0-9_./-]+$/.test(repo.branch)
    )
      throw new Error('仓库配置无效。');
    if (!token.trim()) throw new Error('请填写 GitHub 访问令牌。');
    this.repo = repo;
    this.#token = token.trim();
    this.#fetch = fetcher;
    this.base = `https://api.github.com/repos/${repo.owner}/${repo.name}`;
  }
  disconnect() {
    this.#token = '';
  }
  async request<T>(
    route: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.#token) throw new Error('会话已断开，请重新连接。');
    let response: Response;
    try {
      response = await this.#fetch(this.base + route, {
        method,
        redirect: 'error',
        cache: 'no-store',
        signal: signal || AbortSignal.timeout(30000),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.#token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(
        method === 'GET'
          ? '无法连接 GitHub，请检查网络后重试。'
          : '请求中断，结果尚未确认。请刷新仓库列表核对后再操作，当前编辑仍保留。',
      );
    }
    if (!response.ok) {
      if (response.status === 401)
        throw new Error('令牌无效或已过期，请断开后重新连接。');
      if (response.status === 403)
        throw new Error(
          'GitHub 拒绝访问：请检查令牌的仓库 Contents 读写权限、分支规则或 API 配额。',
        );
      if (response.status === 409 || response.status === 422)
        throw new ConflictError(
          'GitHub 拒绝了更新：分支可能已有新提交，或分支规则不允许直接写入。当前编辑已保留，请刷新核对。',
        );
      if (response.status === 404)
        throw new Error(
          '找不到仓库或分支，请确认令牌选择了此仓库且具备 Contents 权限。',
        );
      throw new Error(`GitHub 请求失败（${response.status}），请稍后重试。`);
    }
    return response.json() as Promise<T>;
  }
  async snapshot(): Promise<Snapshot> {
    const ref = await this.request<{ object: { sha: string } }>(
      `/git/ref/heads/${encodeURIComponent(this.repo.branch)}`,
    );
    const commit = await this.request<{ tree: { sha: string } }>(
      `/git/commits/${ref.object.sha}`,
    );
    const tree = await this.request<{ tree: Entry[]; truncated: boolean }>(
      `/git/trees/${commit.tree.sha}?recursive=1`,
    );
    if (tree.truncated)
      throw new Error('仓库文件列表过大，未能完整读取。请在 GitHub 中编辑。');
    return {
      head: ref.object.sha,
      tree: commit.tree.sha,
      files: new Map(
        tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e]),
      ),
    };
  }
  async read(snapshot: Snapshot, path: string): Promise<string | null> {
    const entry = snapshot.files.get(path);
    if (!entry) return null;
    if (!['100644', '100755'].includes(entry.mode))
      throw new Error(`${path} 必须是普通文件。`);
    if (entry.size && entry.size > 2000000)
      throw new Error(`${path} 超出编辑器支持的大小。`);
    if (this.#blobs.has(entry.sha)) return this.#blobs.get(entry.sha)!;
    const blob = await this.request<{ content: string; encoding: string }>(
      `/git/blobs/${entry.sha}`,
    );
    if (blob.encoding !== 'base64')
      throw new Error('GitHub 返回了不支持的文件编码。');
    const source = decodeBase64(blob.content);
    this.#blobs.set(entry.sha, source);
    return source;
  }
  // One commit for all related files; non-force ref update preserves concurrent commits.
  async commit(
    changes: Change[],
    message: string,
    guards: { path: string; expected: string | null }[] = [],
  ): Promise<{ sha: string; unchanged: boolean }> {
    if (
      !changes.length ||
      new Set(changes.map((c) => c.path)).size !== changes.length ||
      changes.some((c) => !editablePath(c.path))
    )
      throw new Error('写作台仅能修改文章、草稿、图片、排序和主页资料。');
    const snapshot = await this.snapshot();
    for (const change of [...changes, ...guards]) {
      const current = snapshot.files.get(change.path);
      if ((current?.sha ?? null) !== change.expected) throw new ConflictError();
      if (current && !['100644', '100755'].includes(current.mode))
        throw new Error('不能修改符号链接或特殊文件。');
    }
    const tree: {
      path: string;
      mode: string;
      type: 'blob';
      sha?: string | null;
      content?: string;
    }[] = [];
    for (const change of changes) {
      if (change.content === null && change.expected === null) continue;
      const entry = {
        path: change.path,
        mode: snapshot.files.get(change.path)?.mode || '100644',
        type: 'blob' as const,
      };
      if (change.encoding === 'base64' && change.content !== null) {
        const blob = await this.request<{ sha: string }>('/git/blobs', 'POST', {
          content: change.content,
          encoding: 'base64',
        });
        tree.push({ ...entry, sha: blob.sha });
      } else
        tree.push(
          change.content === null
            ? { ...entry, sha: null }
            : { ...entry, content: change.content },
        );
    }
    if (!tree.length) return { sha: snapshot.head, unchanged: true };
    const result = await this.request<{ sha: string }>('/git/trees', 'POST', {
      base_tree: snapshot.tree,
      tree,
    });
    if (result.sha === snapshot.tree)
      return { sha: snapshot.head, unchanged: true };
    const commit = await this.request<{ sha: string }>('/git/commits', 'POST', {
      message,
      tree: result.sha,
      parents: [snapshot.head],
    });
    await this.request(
      `/git/refs/heads/${encodeURIComponent(this.repo.branch)}`,
      'PATCH',
      { sha: commit.sha, force: false },
    );
    return { sha: commit.sha, unchanged: false };
  }
  async deployment(sha: string, signal?: AbortSignal) {
    const result = await this.request<{
      workflow_runs: {
        status: string;
        conclusion: string | null;
        html_url: string;
        head_sha: string;
      }[];
    }>(
      `/actions/workflows/deploy.yml/runs?head_sha=${encodeURIComponent(sha)}&per_page=5`,
      'GET',
      undefined,
      signal,
    );
    return result.workflow_runs.find((run) => run.head_sha === sha) || null;
  }
}
