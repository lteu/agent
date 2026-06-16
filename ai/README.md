# ai

在终端输入 `ai`，弹出一个**可编辑的对话框**（类似 `claude`），接入 **DeepSeek**。

它不只是聊天：内置 `write_file / read_file / list_dir / run_bash` 工具，能在你本机**真正建文件、跑命令**——通过 function calling 让模型直接动手，而不是回答"我没有权限操作你的设备"。

技术栈：Node + [Ink](https://github.com/vadimdemedes/ink)（终端里的 React），参考自 `../claudecode`。

## 安装

```bash
cd ai
npm install
npm run build      # 产出 dist/cli.js
npm link           # 让全局可用 `ai`（或见下方“免 link”）
```

> 不想 `npm link`，可加别名：`alias ai="node /Users/lteu/progetto/claude/ai/dist/cli.js"`

## 配置 API key

二选一：

```bash
ai --set-key sk-xxxxxxxx          # 存到 ~/.ai/config.json（仅自己可读）
# 或
export DEEPSEEK_API_KEY=sk-xxxx   # 写进 ~/.zshrc 持久化
```

到 https://platform.deepseek.com 获取 key。

可选环境变量：
- `AI_MODEL`：默认 `deepseek-chat`，可设 `deepseek-reasoner`
- `DEEPSEEK_BASE_URL`：默认 `https://api.deepseek.com`

## 使用

```bash
ai
```

对话框内快捷键：

| 按键 | 作用 |
| --- | --- |
| `Enter` | 发送 |
| 行尾 `\` + `Enter` | 换行（也可直接粘贴多行） |
| `← → ↑ ↓` | 移动光标 |
| `Ctrl+A` / `Ctrl+E` | 行首 / 行尾 |
| `Ctrl+U` | 删到行首 |
| `Esc` | 清空输入 |
| `Ctrl+C` | 生成中按一次中断；空闲时连按两次退出 |

## 开发

```bash
npm run dev        # 用 tsx 直接跑源码，免编译
```

## 打包分发（macOS）

两种产物都**内置了官方 Node 运行时**（默认 `v24.16.0`），收到的人无需另装任何环境。
按机器 `uname -m` 自动选内置 Node，`universal` 同时适配 Apple Silicon 和 Intel。

### ① .pkg 安装包（推荐：双击即装好，自动带 `ai` 命令）

```bash
npm run pkg                    # arm64 → dist/ai-<version>-arm64.pkg
ARCH=x64 npm run pkg           # Intel
ARCH=universal npm run pkg     # 两者通吃
```

双击 `.pkg` 走系统安装向导（首次右键→打开绕过未签名提示），它会：

1. 把 `Ai.app` 装到 `/Applications`；
2. 用 root 把 `ai` 命令写到 `/usr/local/bin`（各机型默认都在 PATH 里）。

装完**新开一个终端，直接输入 `ai` 即可**——不需要任何手动步骤。
首次没填过 key 时，会在界面引导你粘贴 DeepSeek key（sk- 开头），回车保存后进入对话。

### ② .dmg 磁盘镜像（拖拽安装；`ai` 命令需多点一下）

```bash
npm run dmg                    # arm64 → dist/ai-<version>-arm64.dmg
ARCH=x64 npm run dmg           # Intel
ARCH=universal npm run dmg     # 两者通吃（约 97MB）
```

DMG 里是 `Ai.app` + 一个「① 安装 ai 命令.command」。把 `Ai.app` 拖进「应用程序」后，
**还要**双击那个 `.command` 才会把 `ai` 装成终端命令。想要「装好就有命令」请用上面的 `.pkg`。

### 可调参数（环境变量）

- `ARCH`：`arm64`（默认）/ `x64` / `universal`
- `NODE_VERSION`：内置的 Node 版本，默认 `v24.16.0`

> 仅做了 ad-hoc 签名（非 Apple 开发者证书），所以接收方首次需「右键→打开」。
> 下载过的 Node 会缓存在 `dist/.node-cache`，再次打包更快。

## 结构

```
src/
  cli.tsx           入口 + 界面 + agent 循环（模型↔工具反复调用直到完成）
  tools.ts          本地工具：write_file / read_file / list_dir / run_bash
  MultilineInput.tsx 可编辑的多行输入框（光标、删除、快捷键）
  deepseek.ts       DeepSeek 客户端：流式聊天 + 带工具的非流式补全
  config.ts         API key / 模型 的读取与保存
scripts/
  build-app.sh      组装内置 Node 的 Ai.app（被下面两个共用）
  make-pkg.sh       生成 .pkg 安装包（装好自动带 ai 命令）
  make-dmg.sh       生成 .dmg 磁盘镜像
```
