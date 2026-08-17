# 为 ai-cc 镜像安装 Playwright

> 历史方案归档：当前实现已经改用 `deploy/ai-cc-*-packages.txt` 清单维护依赖，
> 请以 [`docs/ai-cc.md`](../../docs/ai-cc.md#镜像软件包清单与更新) 为准。

这份说明把 Playwright 和 Chromium 预装进 `ai-cc` 镜像。这样容器内的 Claude
Code 可以直接调用 `playwright`，不必在每个临时容器启动后重新下载浏览器。

## 修改 Dockerfile

编辑 [`deploy/ai-cc.Dockerfile`](../../deploy/ai-cc.Dockerfile)。在现有的
`ARG CLAUDE_CODE_VERSION=latest` 下一行加入：

```dockerfile
ARG PLAYWRIGHT_VERSION=1.49.0
```

将原来的 Claude Code 安装行：

```dockerfile
&& npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
```

替换为：

```dockerfile
&& npm install --global \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "playwright@${PLAYWRIGHT_VERSION}" \
&& PLAYWRIGHT_BROWSERS_PATH=/ms-playwright playwright install --with-deps chromium \
```

并在 Dockerfile 的 `ENV` 区块中加入：

```dockerfile
PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
```

`--with-deps` 会同时安装 Chromium 在 Debian 中需要的系统库；将浏览器放在
`/ms-playwright`，可让运行时的 `agent` 用户读取，不会落在构建时 root 用户的
私有目录中。

## 重建镜像

在项目根目录执行：

```bash
npm run build
AI_CC_REBUILD=1 ai-cc --probe
```

首次构建会下载 Chromium，所以时间和镜像体积都会明显增加。`AI_CC_REBUILD=1`
只强制重建 `ai-cc:local` 镜像；不会删除 `ai-cc-home` volume 中已有的登录凭据。

## 验证

先运行 `ai-cc`，进入 Claude Code 后让它执行：

```bash
playwright --version
playwright install --dry-run chromium
```

第一个命令应输出 Playwright 版本；第二个命令应只显示已解析的 Chromium 安装
信息，而不需要下载。若你的项目依赖的 Playwright 版本已升级，请同步更新
`PLAYWRIGHT_VERSION`，使其与 `package.json` 保持一致。
