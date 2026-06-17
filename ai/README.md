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

## 通过 QQ 远程操控（`ai serve`）

让 `ai` 跑成一个 **QQ 官方机器人**：在 QQ 里给它发消息，就能远程让它在你这台机器上建文件、读写、跑命令。
走的是腾讯 [QQ 开放平台](https://q.qq.com) 的官方 v2 API（合规、不登录个人号、不会封号），**不依赖 NapCat 等第三方**。
架构借鉴 openclaw 的 channel 解耦——终端和 QQ 共用同一个 agent 引擎（`src/agent/`），QQ 只是另一个「入口」。

### 1. 在 QQ 开放平台创建机器人

1. 到 [q.qq.com](https://q.qq.com) 用手机 QQ 扫码登录，创建一个机器人应用；
2. 在「开发设置」里拿到 **AppID** 和 **AppSecret**；
3. 按平台要求开通「群消息 / 单聊消息」能力（可能需要审核/沙箱调试）。

### 2. 配置 `ai`

```bash
ai --set-qq-app <AppID> <AppSecret>   # 保存官方机器人凭据
```

也可用环境变量：`AI_QQ_APPID` / `AI_QQ_SECRET` / `AI_QQ_WHITELIST`（逗号分隔的 openid）/ `AI_QQ_SANDBOX=1`。

### 3. 启动并授权

```bash
ai serve
```

官方机器人**不暴露 QQ 号，只给 openid**（同一个人在单聊和每个群里的 openid 还不一样）。所以首次：

1. 先 `ai serve`（白名单可为空）；
2. 在 QQ 里给机器人发任意消息 → 它会**回显你的 openid**；
3. 把它加进白名单：`ai --qq-allow <openid>`，重启 `ai serve` 即可正常操控。

之后在 QQ 里：
- **单聊**：直接发消息；
- **群聊**：需要 **@机器人**（官方群消息本就只推送 @ 事件）；同群共享一份上下文；
- `/clear` 清空当前会话上下文，`/help` 看用法。

### ⚠️ 安全须知

`ai` 自带 `run_bash` / `write_file`，**等于把你机器的 shell 暴露给能操控 bot 的人**。
因此 QQ 入口做了**强制 openid 白名单**：只有 `--qq-allow` 加过的 openid 能操控，未授权者只会收到「回显 openid」的提示，**不触发任何 agent 动作**。
请只把**你自己的 openid** 加进白名单，并妥善保管 AppSecret。

## 开发

```bash
npm run dev        # 用 tsx 直接跑源码，免编译
npm run dev serve  # 本地调试 QQ 机器人
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
  cli.tsx           入口 + 终端界面（消费 agent 引擎的事件流）；也分发 `ai serve`
  agent/
    engine.ts       共享 agent 引擎：模型↔工具反复调用，产出文字/工具事件流
    session.ts      多会话存储（QQ 多人/多群各持一份历史）+ system prompt 构建
  channels/
    qq.ts           QQ channel：对接 QQ 官方机器人 v2 API（鉴权/网关 WS/收发），openid 白名单
  tools.ts          本地工具：write_file / read_file / list_dir / run_bash
  MultilineInput.tsx 可编辑的多行输入框（光标、删除、快捷键）
  deepseek.ts       DeepSeek 客户端：流式聊天 + 带工具的非流式补全
  config.ts         API key / 模型 / QQ（AppID、AppSecret、openid 白名单）的读取与保存
scripts/
  build-app.sh      组装内置 Node 的 Ai.app（被下面两个共用）
  make-pkg.sh       生成 .pkg 安装包（装好自动带 ai 命令）
  make-dmg.sh       生成 .dmg 磁盘镜像
```
