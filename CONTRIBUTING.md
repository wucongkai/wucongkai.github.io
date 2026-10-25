# Git 工作约定

仓库：[wucongkai/wucongkai.github.io](https://github.com/wucongkai/wucongkai.github.io)。
`main` 是发布分支，推送后通过 GitHub Actions 检查并部署到 Pages。

## 修改代码

从干净的工作区开始，每个功能或修复使用一个短期分支：

```bash
git switch main
git pull --ff-only
git switch -c codex/describe-your-change
nvm use
npm ci
```

完成修改后检查、按文件暂存并提交：

```bash
npm run test:editor
npm run typecheck
npm run build
git diff --check
git diff
git add path/to/changed-file
git diff --cached
git commit -m "feat: describe the change"
git push -u origin HEAD
```

在 GitHub 创建合入 `main` 的 Pull Request，检查差异并等待 `Check pull requests` 成功后合并。回到本地执行 `git switch main` 和 `git pull --ff-only` 同步。若拉取失败，先用 `git status`、`git log --oneline --graph --all -15` 查看本地修改和分叉，再处理；不要用强制推送覆盖远程历史。

每个提交只表达一个完整目的。消息使用 `feat:`（功能）、`fix:`（修复）、`docs:`（文档）、`chore:`（维护）或 `ci:`（自动检查），正文说明必要的原因。相关源码、测试与依赖锁文件一起提交。

## 发布内容

网站右上角的静态写作台通过 GitHub API 保存文章、云端草稿、排序和主页资料。内容提交到 `main`，由 Actions 检查并部署；无需本机启动编辑器。明文令牌仅保存在页面内存中；用户主动启用「记住此设备」时，用设备密码加密后保存在当前浏览器，密码不持久化或上传。

代码开发仍采用短期分支与 PR。修改发布逻辑时运行 `npm run check`；API 测试使用隔离模拟仓库，不能向正式 `main` 写入测试内容。网页测试不需要真实令牌，不要把令牌写入测试夹具或截图。

## 版本控制范围

- 提交源码、文章、公共资源、配置、`package-lock.json` 和工作流。
- 依赖、构建产物、日志、测试覆盖率、本地环境配置及 `.editor-trash/` 已忽略。
- `.env.example` 可提交，但只能包含示例值；密码、令牌和私钥不能写入其中。
- 文档中的设备地址使用 `<局域网IP>` 等占位符；测试中的地址使用文档专用地址段（如 `192.0.2.0/24`），不要提交真实设备地址。
- 提交前检查作者信息，使用 GitHub Settings → Emails 提供的 `noreply` 邮箱，并在当前仓库通过 `git config --local user.email "你的 GitHub noreply 邮箱"` 设置。此设置只影响新提交；已有提交中的作者姓名和邮箱仍会公开。
- `content/site/about.json` 的联系邮箱会公开在仓库和网站中，只填写明确愿意公开的联系方式；不希望公开时将 `email` 留空。
- `draft: true` 和 `content/drafts/` 只控制网站展示；提交到公开仓库的草稿仍可被阅读。暂存前检查文章内容。
- 已推送的错误用 `git revert <commit>` 创建撤销提交，然后运行检查并推送，保留历史。

本仓库的本地 Git 设置使用 `pull.ff=only`、`fetch.prune=true` 和 `push.default=simple`。这些设置不随克隆传播；新设备可在仓库目录执行：

```bash
git config --local pull.ff only
git config --local fetch.prune true
git config --local push.default simple
```

参考：[GitHub 仓库最佳实践](https://docs.github.com/en/repositories/creating-and-managing-repositories/best-practices-for-repositories)、[忽略文件](https://docs.github.com/en/get-started/git-basics/ignoring-files)。
