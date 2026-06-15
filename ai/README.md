# ai

在终端输入 `ai`，弹出一个**可编辑的对话框**（类似 `claude`），接入 **DeepSeek**。

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

## 打包成 .dmg 分发（macOS）

```bash
npm run dmg        # 产出 dist/ai-<version>.dmg
```

生成的 DMG **内置了官方 Node 运行时**（默认 `v24.16.0` darwin-arm64），
收到的人无需安装任何环境：

1. 把 `Ai.app` 拖进「应用程序」；
2. 右键 → 打开（首次绕过未签名提示）；
3. 弹出终端进入对话。**没填过 key 时会在启动界面引导粘贴 key**，回车保存后无缝进入对话。

DMG 里还附带「安装命令行 ai.command」，双击即可把 `ai` 装成终端命令。

可调参数（环境变量）：
- `ARCH`：默认 `arm64`（Apple Silicon）。Intel 机器用 `ARCH=x64 npm run dmg`
- `NODE_VERSION`：内置的 Node 版本，默认 `v24.16.0`

> 仅做了 ad-hoc 签名（非 Apple 开发者证书），所以接收方首次需「右键→打开」。
> 下载过的 Node 会缓存在 `dist/.node-cache`，再次打包更快。

## 结构

```
src/
  cli.tsx           入口 + 界面（消息历史、流式输出、缺 key 时的引导）
  MultilineInput.tsx 可编辑的多行输入框（光标、删除、快捷键）
  deepseek.ts       DeepSeek 流式 API 客户端
  config.ts         API key / 模型 的读取与保存
scripts/
  make-dmg.sh       打包内置 Node 的 Ai.app 并生成 .dmg
```
