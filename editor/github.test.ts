import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GitHub, ConflictError, type Change } from './github.ts';
const sha = (value: string) => createHash('sha1').update(value).digest('hex');
const repo = { owner: 'example', name: 'wiki', branch: 'main' };
function fixture(initial: Record<string, string> = {}) {
  const blobs = new Map<string, string>();
  const trees = new Map<string, Record<string, string>>();
  const commits = new Map<
    string,
    { tree: { sha: string }; parents: string[] }
  >();
  const requests: { route: string; method: string; body: any }[] = [];
  function tree(files: Record<string, string>) {
    const id = sha(JSON.stringify(Object.entries(files).sort()));
    trees.set(id, { ...files });
    return id;
  }
  const files = Object.fromEntries(
    Object.entries(initial).map(([p, s]) => {
      blobs.set(sha(s), s);
      return [p, sha(s)];
    }),
  );
  let head = sha('initial');
  commits.set(head, { tree: { sha: tree(files) }, parents: [] });
  let failRef = false,
    interruptRef = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init?.redirect, 'error');
    const route = url.pathname.replace('/repos/example/wiki', '');
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      'Bearer test-token',
    );
    requests.push({ route, method, body });
    const reply = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status });
    if (route === '/git/ref/heads/main')
      return reply({ object: { sha: head } });
    if (route.startsWith('/git/commits/') && method === 'GET')
      return reply(commits.get(route.split('/').at(-1)!));
    if (route.startsWith('/git/trees/') && method === 'GET')
      return reply({
        truncated: false,
        tree: Object.entries(trees.get(route.split('/').at(-1)!)!).map(
          ([path, sha]) => ({ path, sha, mode: '100644', type: 'blob' }),
        ),
      });
    if (route.startsWith('/git/blobs/') && method === 'GET')
      return reply({
        encoding: 'base64',
        content: Buffer.from(blobs.get(route.split('/').at(-1)!)!).toString(
          'base64',
        ),
      });
    if (route === '/git/blobs' && method === 'POST') {
      const id = sha(body.content);
      blobs.set(id, body.content);
      return reply({ sha: id }, 201);
    }
    if (route === '/git/trees' && method === 'POST') {
      assert.ok(body.base_tree);
      const next = { ...trees.get(body.base_tree) };
      for (const entry of body.tree) {
        if (entry.sha === null) delete next[entry.path];
        else if ('content' in entry) {
          next[entry.path] = sha(entry.content);
          blobs.set(sha(entry.content), entry.content);
        } else next[entry.path] = entry.sha;
      }
      return reply({ sha: tree(next) }, 201);
    }
    if (route === '/git/commits' && method === 'POST') {
      const id = sha(JSON.stringify(body));
      commits.set(id, { tree: { sha: body.tree }, parents: body.parents });
      return reply({ sha: id }, 201);
    }
    if (route === '/git/refs/heads/main' && method === 'PATCH') {
      assert.equal(body.force, false);
      if (failRef) return reply({ message: 'not fast forward' }, 422);
      assert.equal(commits.get(body.sha)!.parents[0], head);
      head = body.sha;
      if (interruptRef) throw new Error('connection lost after update');
      return reply({ object: { sha: head } });
    }
    throw new Error(`Unexpected ${method} ${route}`);
  };
  const api = new GitHub(repo, 'test-token', fetcher);
  return {
    api,
    requests,
    failRef: () => {
      failRef = true;
    },
    interruptRef: () => {
      interruptRef = true;
    },
    head: () => head,
    files: () => trees.get(commits.get(head)!.tree.sha)!,
    text: (path: string) =>
      blobs.get(trees.get(commits.get(head)!.tree.sha)![path]),
  };
}
test('atomic publication includes only selected article and draft removal, preserving unrelated files', async () => {
  const f = fixture({
    'content/posts/hello.mdx': 'old',
    'content/drafts/hello.json': 'draft',
    'content/posts/other.mdx': 'unrelated',
    'app/page.tsx': 'code',
  });
  const changes: Change[] = [
    {
      path: 'content/posts/hello.mdx',
      expected: sha('old'),
      content: '中文 new',
    },
    {
      path: 'content/drafts/hello.json',
      expected: sha('draft'),
      content: null,
    },
  ];
  const result = await f.api.commit(changes, 'publish');
  assert.equal(f.text('content/posts/hello.mdx'), '中文 new');
  assert.equal(f.files()['content/drafts/hello.json'], undefined);
  assert.equal(f.text('app/page.tsx'), 'code');
  assert.equal(f.text('content/posts/other.mdx'), 'unrelated');
  assert.equal(f.head(), result.sha);
  assert.equal(
    f.requests.filter((r) => r.route === '/git/refs/heads/main').length,
    1,
  );
});
test('stale article or draft refuses publication before creating a tree', async () => {
  const f = fixture({ 'content/posts/hello.mdx': 'remote updated' });
  await assert.rejects(
    f.api.commit(
      [
        {
          path: 'content/posts/hello.mdx',
          expected: sha('old'),
          content: 'ours',
        },
      ],
      'publish',
    ),
    ConflictError,
  );
  assert.equal(
    f.requests.some((r) => r.method !== 'GET'),
    false,
  );
  assert.equal(f.text('content/posts/hello.mdx'), 'remote updated');
});
test('cloud draft save checks its original article version and never modifies the public article', async () => {
  const f = fixture({ 'content/posts/hello.mdx': 'public' });
  await f.api.commit(
    [{ path: 'content/drafts/hello.json', expected: null, content: 'draft' }],
    'save draft',
    [{ path: 'content/posts/hello.mdx', expected: sha('public') }],
  );
  assert.equal(f.text('content/posts/hello.mdx'), 'public');
  assert.equal(f.text('content/drafts/hello.json'), 'draft');
  await assert.rejects(
    f.api.commit(
      [
        {
          path: 'content/drafts/hello.json',
          expected: sha('draft'),
          content: 'new draft',
        },
      ],
      'save draft',
      [{ path: 'content/posts/hello.mdx', expected: sha('stale') }],
    ),
    ConflictError,
  );
});
test('concurrent branch changes reject the non-force update and never retry or replace remote history', async () => {
  const f = fixture({ 'content/posts/hello.mdx': 'old' });
  const before = f.head();
  f.failRef();
  await assert.rejects(
    f.api.commit(
      [
        {
          path: 'content/posts/hello.mdx',
          expected: sha('old'),
          content: 'new',
        },
      ],
      'publish',
    ),
    ConflictError,
  );
  assert.equal(f.head(), before);
  assert.equal(
    f.requests.filter((r) => r.route === '/git/refs/heads/main').length,
    1,
  );
});
test('ambiguous network result reports uncertainty without replaying a successful mutation', async () => {
  const f = fixture();
  f.interruptRef();
  await assert.rejects(
    f.api.commit(
      [{ path: 'content/posts/hello.mdx', expected: null, content: 'new' }],
      'publish',
    ),
    /结果尚未确认/,
  );
  assert.equal(f.text('content/posts/hello.mdx'), 'new');
  assert.equal(
    f.requests.filter((r) => r.route === '/git/refs/heads/main').length,
    1,
  );
});
test('read decodes UTF-8 and disconnect removes API authorization', async () => {
  const f = fixture({ 'content/posts/hello.mdx': '中文 😀' });
  const snap = await f.api.snapshot();
  assert.equal(await f.api.read(snap, 'content/posts/hello.mdx'), '中文 😀');
  f.api.disconnect();
  await assert.rejects(f.api.snapshot(), /重新连接/);
});
test('editor refuses code/workflow writes, traversal and new-file overwrite', async () => {
  const f = fixture({ 'content/posts/hello.mdx': 'already exists' });
  for (const path of [
    '.github/workflows/deploy.yml',
    'app/page.tsx',
    'content/posts/../../secret',
    'public/images/malicious.svg',
  ])
    await assert.rejects(
      f.api.commit([{ path, expected: null, content: 'bad' }], 'bad'),
      /仅能修改/,
    );
  await assert.rejects(
    f.api.commit(
      [{ path: 'content/posts/hello.mdx', expected: null, content: 'bad' }],
      'bad',
    ),
    ConflictError,
  );
});
test('no-op save does not create a duplicate commit', async () => {
  const f = fixture({ 'content/post-order.json': '[]\n' });
  const before = f.head();
  const result = await f.api.commit(
    [
      {
        path: 'content/post-order.json',
        expected: sha('[]\n'),
        content: '[]\n',
      },
    ],
    'sort',
  );
  assert.equal(result.unchanged, true);
  assert.equal(f.head(), before);
  assert.equal(
    f.requests.some((r) => r.route === '/git/commits'),
    false,
  );
});
