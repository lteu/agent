# ai-cli

`ai` 是一个本地优先的终端 Agent：在终端里提供可编辑的交互界面，并让模型通过工具读取文件、修改代码、执行命令、查看图片和操作浏览器。

模型层支持任意 OpenAI 兼容 API，也可以通过已登录的 Codex CLI 使用订阅模型。终端、QQ、个人微信和企业微信共用同一套 Agent 引擎，但可以分别绑定模型。

## 主要能力

- 交互对话与 `ai ask` 单轮调用，支持流式输出、上下文压缩、任务队列、旁问和 Token 统计。
- 文件、Shell、图片、PDF、Excel、PowerPoint、网页抓取、浏览器自动化和子 Agent 等本地工具。
- 命名模型预设，可为终端和各消息渠道独立切换。
- QQ、个人微信、企业微信入口，以及邮件和美股/港股行情监控。
- Skills 渐进式加载：只在相关任务中把完整操作说明交给模型。

> `ai` 会在本机执行模型请求的文件和 Shell 操作，默认没有沙箱。只使用可信模型、提示词和 Skills，并在含敏感文件的目录中谨慎运行。

## 快速开始

需要 Node.js 20 或更高版本。

```bash
cd /path/to/agent
npm install
npm run build
npm link
```

构建后会注册 `ai`、`ai-claude`、`ai-cc` 和 `ai-remote` 四个命令；`ai-remote` 还需要单独运行一次 `npm run build:remote` 才会生成其客户端和服务端产物。

### 选择模型后端

项目内置 `5.6-sol` 预设。机器上已有已登录的 `codex` 命令时，可以直接使用：

```bash
ai --use 5.6-sol
```

使用 OpenAI 兼容 API 时，设置 API 根地址、模型和 Key。`baseURL` 不要包含最终的 `/chat/completions`：

```bash
ai --set-base-url <API 根地址>
ai --set-model <模型名>
ai --set-provider <显示名称>
ai --set-key <API Key>
```

未设置时仍以 DeepSeek 的 `deepseek-chat` 和 `https://api.deepseek.com` 作为默认值。通用环境变量为：

```bash
export AI_API_KEY=<API Key>
export AI_MODEL=<模型名>
export AI_BASE_URL=<API 根地址>
export AI_PROVIDER=<显示名称>
```

配置优先级是环境变量、`~/.ai/config.json`、代码默认值。旧的 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_BASE_URL` 仍作为兼容后备，但新配置应使用 `AI_*`。运行 `ai --config` 可查看生效配置，其中 Key 会被遮盖。

### 开始使用

```bash
ai
ai ask "概括一下这个项目的结构"
ai ask --file question.txt
```

`ai ask` 把最终回答写到 stdout，进度和 Token 用量写到 stderr，适合脚本或管道。

## 模型预设与渠道绑定

经常切换服务商时，可以保存命名预设：

```bash
ai --add-model deepseek model=deepseek-chat baseURL=https://api.deepseek.com apiKey=<key> provider=DeepSeek
ai --add-model internal model=<模型名> baseURL=<API 根地址> apiKey=<key> provider=<名称>

ai --list-models
ai --use-model internal
ai --rm-model internal
```

`model` 和 `baseURL` 必填；`apiKey` 和 `provider` 可省略。未提供 `apiKey` 时，切换预设会沿用当前全局 Key。

消息渠道可以独立绑定预设，长驻进程会在下一条消息时重新读取配置，无需重启：

```bash
ai --use-model deepseek --channel qq
ai --use-model internal --channel wx
ai --use-model 5.6-sol --channel wechat
ai --use-model deepseek --channel all
```

`qq`、`wx`、`wechat` 分别表示 QQ、个人微信和企业微信。未绑定的渠道继承默认模型。也可以用 `AI_QQ_*`、`AI_WX_*`、`AI_WECHAT_*` 环境变量单独覆盖 `API_KEY`、`MODEL`、`BASE_URL` 和 `PROVIDER`。

## 交互界面

运行中仍可提交下一条普通消息；它会进入可见队列，并在当前任务结束或被中断后按顺序执行。

| 输入或按键 | 作用 |
| --- | --- |
| `/models [序号或名字]` | 查看或切换模型预设 |
| `/btw <问题>` | 发起不打断主任务、无工具且不写入主历史的旁问 |
| `/usage` | 查看当前会话 Token 明细 |
| `/usage reset` | 清零当前会话计数 |
| `Ctrl+O` | 打开完整工具转录 |
| `Esc` | 生成中中断任务；编辑时清空输入 |
| `Ctrl+C` | 生成中中断；空闲时连续按两次退出 |
| 行尾 `\` 后按 Enter | 插入换行；也可直接粘贴多行文本 |

界面会自动检测浅色或深色终端背景。检测不正确时可用 `AI_THEME=light ai` 或 `AI_THEME=dark ai` 覆盖。

## 可选功能

### 浏览器自动化

浏览器工具是可选能力。首次使用前安装 Playwright 和 Chromium：

```bash
npm install --no-save playwright
npx playwright install chromium
```

随后直接描述任务即可，例如“打开这个页面并填写表单”。Agent 根据页面的文本快照选择元素，由 Playwright 完成导航、点击、填写、按键和截图。浏览器会话只存在于当前 `ai` 进程中。

### Skills

Skills 是带 frontmatter 的 Markdown 操作手册，按需加载以减少常驻上下文。支持两种位置：

| 位置 | 范围 |
| --- | --- |
| `~/.ai/skills/<name>/SKILL.md` | 当前用户的所有项目 |
| `<project>/.ai/skills/<name>/SKILL.md` | 当前项目；同名时覆盖用户级 Skill |

常用命令：

```bash
ai --skills
ai --skill-show <name>
ai --skill-new <name>
```

Skill 正文和附带脚本都会成为模型可执行的操作依据。安装第三方 Skill 前应完整审查其 `SKILL.md`、脚本、外部下载、密钥读取和持久化操作。

### 消息渠道

所有消息渠道都能调用本地工具，因此白名单是安全边界，不应向不受信任的用户开放。

QQ 官方机器人：

```bash
ai --set-qq-app <AppID> <AppSecret>
ai serve
ai --qq-allow <openid>
```

先在 [QQ 开放平台](https://q.qq.com) 创建机器人。未授权用户发消息时只会收到自己的 `openid`；加入白名单并重启服务后才可使用 Agent。

个人微信：

```bash
ai wx-login
ai wx
ai --wx-allow <ilink_user_id>
```

`wx-login` 扫码绑定后，绑定账号本人默认进入白名单。凭据保存在 `~/.ai/config.json`。

企业微信：

```bash
ai --set-wechat <CorpID> <AgentId> <Secret> <Token> <EncodingAESKey>
ai wechat
```

企业微信使用本地回调服务，默认监听 `8788`，需要通过反向隧道提供公网回调地址。白名单为空时会允许企业内所有成员；需要限制时设置逗号分隔的 `AI_WECHAT_WHITELIST`。

在 macOS 上让 `serve`、`wx`、`wechat` 或 `watch` 登录后常驻，参见[通用 LaunchAgent 指南](docs/macos-launch-agent.md)。

### 邮件与行情监控

```bash
ai --set-smtp <邮箱> <应用专用密码> [host] [port]
ai email <收件人> <主题> <正文>

ai stock AAPL,TSLA
ai watch add AAPL above=300 below=250 chg=5 email=you@example.com
ai watch list
ai watch
```

`chg` 表示相对昨收的当日涨跌幅绝对值。`ai watch` 默认每 60 秒轮询；可用 `AI_STOCK_POLL`、`AI_STOCK_EMAIL`、`--set-stocks-notify` 和 `--set-stocks-email` 调整。


## 开发

```bash
npm run dev          # 直接运行源码
npm test             # 全部测试
npm run build        # 构建 ai、ai-claude、ai-cc
npm run build:remote # 构建 ai-remote 客户端与服务端
npm run pkg          # 生成 macOS .pkg
npm run dmg          # 生成 macOS .dmg
```

核心目录：

```text
src/agent/        Agent 循环、会话、压缩、验证和子 Agent
src/channels/     QQ、个人微信、企业微信和行情监控
src/cli.tsx       ai 命令与终端界面
src/tools.ts      本地工具定义与执行
src/llm.ts        OpenAI 兼容、Remote Claude 与 Codex 后端适配
src/remote*.ts    ai-remote 客户端与服务端
deploy/           Docker、systemd 和远端网关配置
test/             自动化测试
```

运行 `ai --help` 查看完整命令清单；涉及独立运行入口时，以对应的专门文档和 `--help` 为准。全部正式文档见 [`docs/README.md`](docs/README.md)，历史材料与截图见 [`assets/`](assets/)。
