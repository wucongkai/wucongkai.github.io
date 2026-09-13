# wucongkai 的个人主页

一个适合部署到 `https://wucongkai.github.io/` 的个人 Wiki。
参考 jyywiki.cn 的阅读体验：简洁导航、纸张式正文、手写英文字体和蓝紫色链接。
页面代码与示例文章独立编写，没有复制原站文章、图片或个人信息。

## 实现方式

```text
site.config.ts              → 姓名、简介、项目、联系方式
content/posts/*.mdx         → 每一篇文章，构建时自动生成列表和页面
app/globals.css             → 页面配色、字号、宽度、留白
Next.js + MDX              → 生成 out/ 中的静态网站
GitHub Actions             → 每次推送 main 后自动构建
GitHub Pages               → 发布到 wucongkai.github.io
```

使用 Next.js App Router、MDX、普通 CSS。这个规模的页面用集中式 CSS 就可以保持一致的排版，不需要再引入组件库。所有英文字体随网站一起发布，访问时无需连接 Google Fonts。

## 1. 在本地运行

安装 Node.js 24 LTS。若已经使用 nvm，可执行 `nvm install` 和 `nvm use`，版本由 `.nvmrc` 指定。

在这个目录打开终端：

```bash
npm ci
npm run dev
```

打开终端显示的本地地址，通常是 `http://localhost:3000`。修改文件并保存后，页面会自动更新。

## 2. 替换个人资料

编辑 `site.config.ts`：

- `name`、`title`：姓名和网站标题。
- `bio`：个人介绍，数组中每一项是一段文字。
- `projects`：项目名称、简介、链接和简短状态。
- `github`：GitHub 主页地址。
- `email`：可公开的联系邮箱；留空就不显示。
- `url`：网站正式地址，当前为 `https://wucongkai.github.io`。

项目和文章都使用你填写的内容。首页的当前个人介绍是一段可直接替换的中性占位文字，没有虚构职业、学历、成果或项目经历。

## 3. 写文章

在 `content/posts/` 下新建一个 `.mdx` 文件，例如 `my-first-note.mdx`：

```md
---
title: "我的第一篇笔记"
date: "2026-09-13"
description: "用一两句话说明这篇笔记讲什么。"
category: "学习笔记"
draft: false
---

这里开始写正文。

## 一个小标题

- 支持列表和链接。
- 支持代码块、引用、表格。
```

文件名就是文章网址的一部分：`/notes/my-first-note/`。
首页会自动按日期由新到旧列出文章，无需手工修改导航。文章标题由模板显示，正文直接从二级标题开始即可。
设置 `draft: true` 后，该文章不会出现在列表中，也不会生成公开页面。
删除所有文章时，首页会显示空状态，构建仍然可以完成。

图片放入 `public/images/`，在文章中写 `![图片说明](/images/example.png)`。
文章内链写成 `/notes/文章文件名/`，不要直接链接 `.mdx` 源文件。

## 4. 部署到 GitHub Pages

### 创建仓库

登录 GitHub，创建公开仓库 **`wucongkai.github.io`**。这是个人主页仓库的固定命名方式。
如果已有同名仓库，先检查里面的内容，不要覆盖已有网站。

将项目源文件提交到仓库的 `main` 分支，必须包含 `package-lock.json` 和 `.github/workflows/deploy.yml`。
不要上传 `node_modules`、`.next` 或 `out`；它们已在 `.gitignore` 中排除。

如果从新下载的项目开始且还没有 Git 仓库，可执行：

```bash
git init -b main
git add .
git commit -m "Create personal homepage"
git remote add origin https://github.com/wucongkai/wucongkai.github.io.git
git push -u origin main
```

如果当前目录已有 Git 仓库，跳过 `git init`；如果已有 `origin`，先用 `git remote -v` 核对地址。GitHub 推送需使用你自己的正常登录方式，不要把密码或令牌写入项目文件。

### 开启 Pages

1. 打开仓库的 **Settings → Pages**。
2. 在 **Build and deployment → Source** 选择 **GitHub Actions**。
3. 打开仓库的 **Actions → Deploy personal homepage**。
4. 如果第一次推送发生在启用 Pages 之前，点击 **Run workflow** 重新运行。
5. `build` 和 `deploy` 都完成后，访问 **https://wucongkai.github.io/**。

以后每次向 `main` 推送修改，都会自动重新发布。Actions 页面会显示失败原因和日志。

## 5. 本地检查正式构建

```bash
npm run build
```

Next.js 会检查 TypeScript，并把首页、文章页、404 页面、字体等输出到 `out/`。
`out/` 可以由任何静态 HTTP 服务器提供访问；不要通过双击 HTML 文件来检查网站。

## 配置要点

- `output: 'export'`：输出静态文件；GitHub Pages 不需要也不运行 Node.js 应用服务器。
- `trailingSlash: true`：文章输出为 `/notes/slug/index.html`，便于直接打开子页面。
- `images.unoptimized: true`：不依赖服务器端图片优化。
- 当前以 `wucongkai.github.io` 根路径部署，无需 `basePath`。如果改成普通项目仓库或自定义域名下的子路径，需要相应调整配置与资源链接。
- 联系方式使用普通 GitHub 链接和可选邮箱；没有后台、数据库或表单收件服务。

## 官方参考

- [Next.js 静态导出](https://nextjs.org/docs/app/guides/static-exports)
- [Next.js MDX](https://nextjs.org/docs/app/guides/mdx)
- [创建 GitHub Pages 网站](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
- [GitHub Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
