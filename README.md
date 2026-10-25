# wucongkai 的个人 Wiki

Next.js 静态网站，文章和主页资料保存在 GitHub，GitHub Actions 检查通过后部署到 GitHub Pages。首页右上角的 **写作台** 打开 `/studio/`，换一台电脑也可以继续写作，无需本地 Node 服务或数据库。

## 日常写作

1. 打开网站右上角的「写作台」。
2. 输入仅授权此仓库的 GitHub 细粒度访问令牌。令牌只在当前页面内存中保存，刷新、关闭或断开连接后需重新输入。
3. 选择文章，或新建文章；右侧可以预览表格、公式、代码高亮和折叠内容。
4. **保存云端草稿**：保存到仓库 `content/drafts/`，不会改变公开文章。换设备连接后，列表会显示这些草稿。`⌘ / Ctrl + S` 也执行此操作。
5. **发布到网站**：一次提交更新当前文章并删除它的云端草稿，由 Actions 检查、构建并部署。写作台会区分“已提交”“部署中”“部署完成”。

**仓库是公开的：云端草稿虽然不生成网站页面，仍能在 GitHub 仓库中被阅读。私人内容应只暂存到浏览器或导出到本机。**

编辑中的文章自动暂存到当前浏览器，各标签页独立保存，不会互相清除。可从「本机暂存」恢复、导出或清除历史暂存。浏览器暂存不能跨设备，清除浏览器数据也会清除它；跨设备前请保存云端草稿。未连接 GitHub 时仍可新建、预览和导出文章。

### 第一次连接

到 [GitHub 细粒度令牌设置](https://github.com/settings/personal-access-tokens/new) 创建令牌：

- Resource owner 选择仓库所有者；设置有效期。
- Repository access 选择 **Only select repositories**，仅选 `wucongkai.github.io`。
- Contents：**Read and write**，用于保存文章、草稿和图片。
- Actions：**Read-only**，用于查看部署进度；没有此权限时仍可通过 Actions 链接查看。
- Metadata 为 GitHub 自动提供的读取权限。无需 Workflows 写入权限。

不要把令牌放入源码、构建环境的公开变量、文章或聊天。写作台不会把令牌存入 localStorage、sessionStorage、网址或仓库。断开连接会清除页面持有的令牌。入口公开不代表访客可以修改网站，写入必须通过 GitHub 权限检查。分支保护如果禁止直接更新 `main`，写作台会报告失败，不会绕过规则。

### 图片、排序、删除与主页资料

- **图片**：点击「上传图片」，支持 5 MB 以内 PNG、JPEG、WebP、GIF、AVIF。图片单独提交并插入正文引用，部署完成后预览可见；然后保存或发布文章。删除文章不会删除图片。
- **排序**：使用列表中的上移、下移，再点击「发布文章顺序」。只发布已存在的文章位置，首次发布新文章后可再次排序；搜索时不能移动。
- **删除**：确认后在一个提交中删除文章及云端草稿。已发布页面在部署成功后下线；可从 GitHub 提交历史恢复文件。本机暂存不会被自动清理。
- **项目 / 关于我**：在写作台切换栏目编辑，发布时只修改对应 JSON 文件。修改自动暂存到当前浏览器，可恢复最近一次暂存。科研成果暂时直接维护 `content/site/publications.json`。

## 冲突与发布失败

每次保存检查文章和草稿的文件 SHA。其他设备已经修改同一文件时，操作会停止并保留编辑内容。先导出或保留本机暂存，再载入云端最新版本并合并。写作台不提供强制覆盖。

发布使用 GitHub Git Database API：基于最新提交创建树和提交，再以 `force: false` 更新分支。文章发布与草稿清理是一个提交，其他文件保持原样；操作期间有新提交时可能需要刷新重试。

网络中断可能发生在 GitHub 已完成提交之后。看到“结果尚未确认”时，先刷新列表或检查 GitHub 提交历史，不要盲目重复发布。

**已提交不等于已上线。** 内容提交到 `main` 后由 Actions 运行检查和构建；失败时线上继续保留上次部署成功的网站，但失败的源文件提交仍在仓库中。根据 Actions 日志修正后再次发布，或在 GitHub 上 revert 对应提交。只有草稿目录变化时不触发部署。自动查询部署状态约 10 分钟后停止，可继续通过 Actions 查看。

## 本地开发

推荐使用 `.nvmrc` 指定的 Node.js 24；项目最低要求 Node.js 22.15。

```bash
nvm install
nvm use
npm ci
npm run dev
```

网站位于 `http://localhost:3000/`，写作台位于 `http://localhost:3000/studio/`。`npm run editor` 是同一开发服务器的快捷命令；原来的端口 4311 本地服务和 LAN 口令登录已移除。

```bash
npm run check       # 回归测试 + TypeScript + 完整静态导出
```

构建产物在 `out/`。可用 `python3 -m http.server --directory out` 验证静态托管；写作台不会调用本站 `/api/` 或依赖 Node 后端。

## 文件结构与维护边界

```text
app/                       网站页面与静态 /studio/ 写作台
editor/github.ts           唯一的 GitHub API 与原子提交流程
editor/workspace.ts        文章 / 云端草稿的数据操作
editor/backups.ts          每个页面独立的浏览器暂存
lib/content.ts             网站与写作台共用的数据解析和校验
lib/markdown.ts            网站与预览共用的安全 Markdown 渲染
lib/posts.ts               构建时读取公开文章
content/posts/*.mdx        文章（保持现有网址和文件扩展名）
content/drafts/*.json       云端草稿，不输出到网站
content/post-order.json    文章顺序
content/site/*.json        关于我、项目、科研成果
site.config.ts             正式域名、GitHub 仓库与发布分支
.github/workflows/         PR 检查与 Pages 部署
```

页面和编辑器不直接读写彼此的源码，不再通过字符串替换修改 `lib/posts.ts`。没有本机 Git 子进程、临时构建目录或需要维护的授权服务器。GitHub 令牌是个人使用的认证方式。

### 文章格式

```markdown
---
title: 我的笔记
date: 2026-10-25
description: 一两句话介绍文章。
category: 学习笔记
draft: false
---

## 一个小标题

这里开始写正文。
```

文件名使用小写英文、数字和连字符，对应 `/notes/文件名/`。`draft: true` 的文章不生成页面；新写作台的云端草稿使用独立目录，以便编辑已发布文章时保持线上内容不变。

正文支持 Markdown、GFM 表格、`<details>` 等安全 HTML、代码高亮与 `$...$` / `$$...$$` 数学公式。公式转换为原生 MathML。现有手写 `<h2 id="...">` 章节链接保留。**不执行 JavaScript、import/export 或自定义 MDX 组件**；扩展名仍使用 `.mdx` 以兼容现有内容路径。

图片引用 `/images/文件名.png`；文章内链 `/notes/文章网址/`。自定义域名修改 `site.config.ts`；当前按域名根路径部署，迁移到仓库子路径时需要同时处理链接和资源路径。

## 部署

仓库 Settings → Pages → Source 选择 **GitHub Actions**。合入 `main` 后工作流自动运行；首次设置或需要重试时，可在 Actions → Deploy personal homepage → Run workflow 手动运行。

本次迁移保留现有文章、顺序和展示内容；原有 `.editor-trash/` 删除备份不会被删除，仍可手动恢复。旧版浏览器的 `wiki-editor:` 暂存不会自动迁移，更新前应在旧写作台保存或导出未完成内容。

Git 工作约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
