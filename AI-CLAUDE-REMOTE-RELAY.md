# `ai-claude` 本地 Agent + Remote Claude 中转完整说明

> 核对日期：2026-07-30  
> 本地项目：`/Users/lteu/progetto/agent`  
> SSH 目标别名：`remote`

## 1. 最终目标和结论

`ai-claude` 启动的是本项目自己的 AI Agent，不是本机的 Claude Code。

- 普通模式下，Agent、工作目录以及 Read/Edit/Bash 等工具都在当前电脑运行。
- sandbox 模式下，Agent 和工具在本机 Docker 容器中运行，当前目录映射成
  `/workspace`。
- `remote` 只承担 SSH 隧道、协议转换和 Claude 模型调用。
- `remote` 不执行 Agent 请求的本地文件或 Bash 工具。
- 公网搜索和网页抓取可由 Remote Claude 的 `WebSearch`、`WebFetch` 执行。
- Claude 的登录状态只保留在 `remote` 的 `/root/.claude`。
- 本机不需要登录 Claude，也没有复制远端 OAuth 凭据。

普通模式的数据路径：

```text
当前终端
  │
  ├─ ai-claude 启动本地 ai Agent
  │    ├─ Read/Edit/Bash：当前电脑
  │    └─ 模型请求：http://127.0.0.1:<随机端口>/v1
  │
  └─ SSH 本地端口转发
       │
       ▼
remote:127.0.0.1:8791
  │
  └─ ai-claude-gateway
       │
       └─ /usr/local/bin/claude
            └─ 使用 remote:/root/.claude 的认证访问 Claude
```

## 2. Remote 上实际安装和使用的内容

### 2.1 本次部署新增的文件

| Remote 路径 | 用途 | 当前权限 |
|---|---|---|
| `/usr/local/lib/ai-claude-gateway/gateway.mjs` | HTTP/OpenAI 兼容协议到 Claude Code stream-json/MCP 的网关 | `0644 root:root` |
| `/etc/systemd/system/ai-claude-gateway.service` | 网关的 systemd unit | `0644 root:root` |

当前远端文件与本地仓库中的部署源文件哈希完全一致：

```text
8552e4f900fdf4e7cd3c00202413ba362361296f8d63c7882ffbe7e764fb54d5  gateway.mjs
e76d2dd9812cd2eade6760bdf0cf222de201f97451a441a9c705f4f518f58e0c  ai-claude-gateway.service
```

仓库对应源文件：

- [`deploy/ai-claude-gateway.mjs`](deploy/ai-claude-gateway.mjs)
- [`deploy/ai-claude-gateway.service`](deploy/ai-claude-gateway.service)

### 2.2 Remote 原有且被复用的内容

网关复用了远端已有的：

| Remote 路径 | 用途 |
|---|---|
| `/usr/local/bin/claude` | Claude Code CLI |
| `/root/.claude` | 远端 Claude Code 的设置、会话数据和登录凭据 |
| `/usr/bin/node` | 运行网关 |

Claude Code 二进制当前为：

```text
-rwxr-xr-x root:root /usr/local/bin/claude
```

网关没有读取凭据并转换成自己的 API Key，也没有把
`/root/.claude/.credentials.json` 复制到本机。它只是以 `HOME=/root` 启动远端
Claude Code，让 Claude Code 自己使用已有登录状态。

### 2.3 当前 systemd 状态

服务名：

```text
ai-claude-gateway.service
```

核对时状态：

```text
enabled
active
```

实际启动命令：

```bash
/usr/bin/node /usr/local/lib/ai-claude-gateway/gateway.mjs
```

监听地址：

```text
127.0.0.1:8791
```

端口只绑定远端 loopback，没有监听 `0.0.0.0`，因此不能直接从公网访问。正常
访问必须先登录 `remote` 并建立 SSH 端口转发。

systemd 还设置了：

- `Restart=on-failure`
- `NoNewPrivileges=true`
- `PrivateTmp=true`
- `ProtectSystem=strict`

服务以 `root` 运行，是因为当前 Claude 登录状态位于 `/root/.claude`。

### 2.4 当前没有保留的旧原型

设计校正前探索过的旧 relay/proxy 原型已经移除。核对时以下路径均不存在：

```text
/usr/local/bin/ai-claude-relay
/usr/local/lib/ai-claude-proxy
/etc/systemd/system/ai-claude-proxy.service
```

最终实现不需要公网 HTTP 代理，也没有把 8791 端口暴露到公网。

## 3. 本地增加的脚本和配置

| 本地文件 | 用途 |
|---|---|
| [`src/claude-remote.ts`](src/claude-remote.ts) | `ai-claude` 启动器源代码 |
| `dist/claude-remote.js` | 构建后的可执行入口 |
| [`deploy/ai-claude-sandbox.Dockerfile`](deploy/ai-claude-sandbox.Dockerfile) | sandbox 镜像定义 |
| [`.dockerignore`](.dockerignore) | 限制 Docker 构建上下文 |
| [`deploy/ai-claude-gateway.mjs`](deploy/ai-claude-gateway.mjs) | 部署到 remote 的网关源文件 |
| [`deploy/ai-claude-gateway.service`](deploy/ai-claude-gateway.service) | 部署到 remote 的 systemd 源文件 |

`package.json` 注册了三个命令：

```json
{
  "ai": "dist/cli.js",
  "ai-remote": "dist/remote.js",
  "ai-claude": "dist/claude-remote.js"
}
```

本机全局入口当前为：

```text
/opt/homebrew/bin/ai-claude
  -> ../lib/node_modules/ai-cli/dist/claude-remote.js
```

它由 `npm link` 链接到当前项目，并不是另一个单独下载的 Claude 客户端。

构建命令：

```bash
npm run build
npm link
```

## 4. 普通模式的完整执行逻辑

以下以这条命令为例：

```bash
cd /Users/lteu/progetto/agent
ai-claude ask "读取 package.json，只回复 name"
```

### 第 1 步：本地启动器选择临时端口

`ai-claude` 在本机 `127.0.0.1` 上申请一个空闲随机端口，并创建临时 SSH
ControlMaster socket 目录。

### 第 2 步：本机建立 SSH 隧道

启动器执行的核心逻辑等价于：

```bash
ssh \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ForwardAgent=no \
  -o ControlMaster=yes \
  -o ControlPath=<临时 socket> \
  -f -N \
  -L <本地随机端口>:127.0.0.1:8791 \
  remote
```

因此：

```text
本机 127.0.0.1:<随机端口>
    → SSH 加密连接
    → remote 127.0.0.1:8791
```

`ForwardAgent=no` 表示 SSH Agent 不会被转发到 remote。

### 第 3 步：启动本地 AI Agent

启动器在原始 `cwd` 中执行：

```text
node dist/cli.js <原始参数>
```

并设置：

```text
AI_API_KEY=ssh-local-only
AI_MODEL=sonnet
AI_BASE_URL=http://127.0.0.1:<随机端口>/v1
AI_PROVIDER=Claude via remote
```

`AI_API_KEY=ssh-local-only` 只是为了满足本地 OpenAI 兼容客户端的配置检查，不是
真实 Claude Key。

传给 Agent 前会删除这些环境变量：

```text
SSH_AUTH_SOCK
SSH_AGENT_PID
SSH_CLIENT
SSH_CONNECTION
SSH_TTY
```

这能防止模型通过普通的环境查看直接得到这些字段，但普通模式仍不是完整文件系统
隔离：Agent 本质上仍以本机用户身份运行。

### 第 4 步：本地 Agent 生成模型请求

本地 `ai` Agent：

1. 使用当前目录构造 system prompt。
2. 将对话历史和本地工具定义组织成 OpenAI 兼容请求。
3. POST 到 `/v1/chat/completions`。
4. 请求通过 SSH 隧道到达 remote 网关。

本地工具的名称、描述和 JSON 参数 schema 也会随模型请求发送给网关，这是模型
能够决定调用哪个本地工具的必要信息。

### 第 5 步：Remote 网关转换工具定义

远端网关接收 OpenAI 兼容请求后，将每个 OpenAI function tool 转换成 MCP tool：

```text
function.name        → MCP name
function.description → MCP description
function.parameters  → MCP inputSchema
```

然后为本次 Claude Code 子进程动态生成一个名为 `local_agent` 的 stdio MCP
server 配置。

### 第 6 步：Remote 启动 Claude Code

每次模型请求都会启动一个新的：

```text
/usr/local/bin/claude
```

主要参数包括：

```text
--print
--verbose
--output-format stream-json
--input-format stream-json
--include-partial-messages
--no-session-persistence
--disable-slash-commands
--model sonnet
--strict-mcp-config
```

Claude 子进程只收到最小环境：

```text
HOME=/root
USER=root
LOGNAME=root
PATH=/usr/local/bin:/usr/bin:/bin
LANG=C.UTF-8
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

这里没有继承网关进程或 SSH 会话中的 `SSH_CLIENT`、`SSH_CONNECTION`、
`SSH_TTY`、`SSH_AUTH_SOCK`。

### 第 7 步：精确开放 Remote Web 工具

只要请求中带有工具，网关就用 Claude Code 自带的：

```text
--tools WebSearch,WebFetch
--allowedTools WebSearch,WebFetch
--permission-mode dontAsk
```

这是允许列表，不是 `--disallowedTools` 黑名单。Claude Code 升级后即使增加新的
内置工具，也不会自动得到权限。Remote 只执行公网查询所需的 `WebSearch` 和
`WebFetch`；Read、Edit、Bash 等仍由动态 MCP 暴露并在本地 Agent 侧执行。

网关还会检查 stream-json 中的每个 `tool_use`：动态 MCP 工具转发给本地 Agent，
`WebSearch`/`WebFetch` 等待 Remote Claude Code 执行并继续当前会话，其他工具名
直接报错。因此 CLI 参数和协议处理有两层白名单约束。

### 第 8 步：MCP 握手

Claude Code 初始化 MCP 是异步的。网关先发送：

```text
MCP_GATEWAY_HANDSHAKE
```

Claude 回复 `READY` 后，说明同一个 Claude 会话已经有机会连接动态 MCP
server；网关这时才把真正的完整对话 JSON 发进去。

### 第 9 步：按工具类型路由

动态 MCP server 支持：

- `initialize`
- `tools/list`
- `ping`

它故意不响应 `tools/call`。

当 Claude 输出类似下面的 stream-json assistant block：

```json
{
  "type": "tool_use",
  "name": "mcp__local_agent__read_file",
  "input": {
    "path": "/path/to/file"
  }
}
```

对于动态 MCP 工具，父网关会在远端 MCP 真正执行前捕获这个 `tool_use`，终止本次 Claude
子进程，然后转换成 OpenAI 兼容的：

```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "arguments": "{\"path\":\"/path/to/file\"}"
  }
}
```

所以 Remote 只是传回“Claude 想调用什么本地工具和参数”，没有执行本地工具。

如果工具名是 `WebSearch` 或 `WebFetch`，网关不会提前终止子进程。Claude Code
在 Remote 内完成搜索或抓取，把结果作为内部 `tool_result` 回灌给同一个会话，
直到生成正文答案。`GET /health` 的 `remote_web_searches` 和
`remote_web_fetches` 计数器可用于确认实际采用了哪一种远端工具。

### 第 10 步：本地执行工具并继续循环

本地 Agent 收到 function call 后：

1. 在本机执行 `read_file`、`write_file`、`run_bash` 等工具。
2. 将工具结果加入本地对话历史。
3. 再发起下一次模型请求。
4. Remote 再启动一个短生命周期 Claude Code 子进程处理更新后的完整对话。

循环持续到 Claude 返回真正完成的普通文本、不再要求工具调用为止。网关不再把第一
个非空 `assistant` 事件直接当作成功，而是等待 `message_delta.stop_reason`。完整的
纯文本答案带有内部标记 `<LOCAL_AGENT_FINAL>`，网关在返回前移除；如果 Claude
只说“现在开始查”之类的进度声明而没有工具调用或完成标记，网关会在同一会话中自动
要求它继续落实，最多两次，仍不完成则明确报错而不是静默停止。

如果 Claude 返回合法的 `end_turn` 但该轮没有正文或工具调用，网关会透传为空的
completion，由本地 Agent 已有限次的空响应恢复逻辑重试；它不会再把这种可恢复状态
升级为 HTTP 502。

网关同时从 Claude Code 的 `message_delta.usage` 累计 `input_tokens`、
`output_tokens`、`cache_read_input_tokens` 和
`cache_creation_input_tokens`（包括内部 MCP 握手的真实开销），再通过 OpenAI
兼容响应的 `usage` 字段返回本地 Agent。流式请求会在 `[DONE]` 前发送独立 usage
事件，因此工具调用轮和纯文本轮都能进入本地会话的 Token 统计。

### 第 11 步：退出和清理

Agent 退出或收到 `SIGINT`、`SIGTERM`、`SIGHUP` 时，启动器会：

1. 将信号转发给本地 Agent。
2. 使用 SSH ControlMaster socket 执行 `ssh -O exit`。
3. 删除临时 control socket 目录。

远端 systemd 网关保持运行，供下次连接复用。

## 5. `--probe` 做什么

```bash
ai-claude --probe
```

它会：

1. 建立同样的临时 SSH 隧道。
2. 请求远端网关的 `GET /health`。
3. 显示网关状态和模型名。
4. 立即关闭隧道。

它不发送用户对话，也不运行本地 Agent 工具。

## 6. Sandbox 模式的完整逻辑

命令：

```bash
ai-claude --sandbox
ai-claude --sandbox ask "读取 package.json"
ai-claude --sandbox --probe
```

### 6.1 两个容器，而不是一个

```text
宿主机当前目录
    │ 作为读写 bind mount
    ▼
Agent 容器（用户 agent，UID/GID 10001）
    │
    │ Docker internal network
    ▼
SSH 隧道容器（别名 claude-gateway）
    │
    │ SSH
    ▼
remote:127.0.0.1:8791 → Claude
```

使用两个容器的原因是不能让负责执行 Claude 工具请求的 Agent 同时持有 SSH
私钥或 SSH Agent socket。

### 6.2 Agent 容器

Agent 容器具有以下约束：

- 当前宿主机目录映射为 `/workspace`。
- 工作目录固定为 `/workspace`。
- 使用中性用户 `agent`，UID/GID 为 `10001`。
- HOME 是临时的 `/home/agent`。
- 根文件系统只读。
- `/tmp` 和 `/home/agent` 是临时 tmpfs。
- `--cap-drop ALL`。
- `no-new-privileges`。
- 最多 256 个进程。
- 不挂载宿主机 HOME。
- 不挂载宿主机 `~/.ssh`。
- 不挂载 `SSH_AUTH_SOCK`。
- 只传入模型连接所需的少量环境变量。
- `AI_LOG_DIR` 固定为 `/workspace/log`，避免只读根文件系统令启动、对话和诊断
  日志写入 `/opt/ai/log` 失败，并使日志在容器退出后仍保留在项目目录。

路径映射示例：

```text
宿主机：/Users/lteu/progetto/agent/package.json
容器：  /workspace/package.json
```

模型看到和工具返回的路径是 `/workspace/...`，不会自然出现
`/Users/lteu/...`。但是项目文件内容本身如果含有姓名、邮箱、Git remote、
密钥或其他身份信息，模型仍然可能看到这些内容。

### 6.3 SSH 隧道容器

隧道容器：

- 不挂载项目目录。
- 以只读方式挂载宿主机 `~/.ssh` 到 `/root/.ssh`。
- 如果宿主机存在 `SSH_AUTH_SOCK`，只把它挂载给隧道容器。
- 使用 `ForwardAgent=no`，不会把 SSH Agent 转发到 remote。
- 根文件系统只读。
- drop 全部 Linux capabilities。
- 只运行前台 SSH 本地端口转发。

因此 SSH 容器能建立隧道，但看不到工作项目；Agent 容器能操作项目，但看不到
SSH 凭据。

### 6.4 网络模式

启动器为每次运行创建随机命名的 Docker 网络。默认
`AI_CLAUDE_SANDBOX_NETWORK=egress`，允许 Agent 访问互联网；设置为
`isolated` 时使用 Docker `--internal` 网络，禁止公网访问。

- Agent 容器只加入本次运行的 sandbox 网络。
- SSH 容器同时加入默认 `bridge` 网络和 sandbox 网络。
- sandbox 网络中的别名是 `claude-gateway`。
- Agent 的 `AI_BASE_URL` 是
  `http://claude-gateway:8791/v1`。
- 没有向宿主机 publish 任何容器端口。

`egress` 模式支持 `web_fetch`、curl、Wikipedia、USGS 和软件包下载等在线
研究任务，但第三方网站看到的是本机 Docker 的公网出口 IP；Agent 也可以把
`/workspace` 中读取到的内容发送到第三方，因此项目目录不应包含不希望外发的
密钥。`isolated` 模式适合不需要联网的高敏感任务，模型请求本身仍可通过专用
SSH 隧道到达 remote。

Sandbox 镜像预装 `curl`、Python 3/pip、jq、ripgrep、DNS 工具和 unzip。
`ai-claude --sandbox --probe` 会报告当前网络模式；在 `egress` 模式下还会实际
验证 Wikipedia 的 DNS 与 HTTPS。egress 默认为 Agent 容器指定 `1.1.1.1`，
避免受污染的宿主 DNS 把 Wikipedia 解析到错误地址；可用
`AI_CLAUDE_SANDBOX_DNS` 提供逗号分隔的 DNS 地址，或设为 `system` 跟随 Docker
默认 DNS。

### 6.5 Sandbox 清理

每次使用随机后缀创建：

```text
ai-claude-private-<PID>-<随机值>
ai-claude-tunnel-<PID>-<随机值>
ai-claude-agent-<PID>-<随机值>
```

正常退出或异常进入 `finally` 后，启动器强制清理 Agent 容器、隧道容器和
sandbox 网络。镜像 `ai-claude-sandbox:local` 保留，以便下次复用构建缓存。

### 6.6 当前本机状态

sandbox 代码、Dockerfile、构建产物和缺少 Docker 时的错误处理已经完成，并已
在 OrbStack 中完成真实容器启动、DNS、HTTPS、SSH 隧道和 Claude relay 测试。
可用以下命令复查：

```bash
ai-claude --sandbox --probe
```

首次执行需要构建镜像，时间会比后续执行长。

## 7. 谁能看到什么

| 观察方 | 能看到的内容 | 通常看不到的内容 |
|---|---|---|
| 本机 SSH 客户端 | SSH 配置、认证材料、remote 地址 | 远端 Claude OAuth 明文 |
| Remote 的 sshd/管理员 | 你的 SSH 来源公网 IP、SSH 用户、连接时间 | NAT 后的内网地址通常不可见 |
| Remote 网关 | 完整模型请求、工具 schema、工具结果、Claude 输出 | 本机未发送的文件 |
| Anthropic 后端 | Remote 的公网出口 IP、远端 Claude 账户身份、发送的请求内容 | 本机公网 IP 不会作为这条模型请求的网络源地址出现 |
| Claude 模型 | 对话、system prompt、被发送的工具定义和工具结果 | 没有读取或回传的其他本机文件 |
| Remote `WebSearch`/`WebFetch` 服务 | 搜索词、目标 URL、与查询相关的对话内容；请求归属于远端 Claude 账户 | 未被加入请求或工具参数的本机文件、SSH 凭据 |
| 普通模式本地工具访问的第三方网站 | 本机网络出口 IP | Remote 出口 IP |
| Sandbox 中的本地工具 | `/workspace`、容器临时环境；egress 模式下第三方网站还能看到本机公网出口 IP | 宿主机 HOME、SSH 凭据 |

需要区分两件事：

1. **Anthropic 接口看到的网络源 IP**：是 remote 的出口 IP。
2. **Remote SSH 服务器看到的登录源 IP**：是本机到 remote 的公网源 IP。

Remote 是中转站，所以 remote 必然知道是谁连接了它；中转不能同时向中转服务器
隐藏连接来源。这个设计的目标是让 Anthropic 的模型请求从 remote 发出，而不是
对 remote 隐藏 SSH 客户端。

使用 Remote `WebSearch`/`WebFetch` 不会把宿主机 HOME、SSH 身份或 Docker
容器身份自动提供给 Claude，但搜索词和目标 URL 属于模型请求的一部分。Claude
如果从对话或已回传的本地文件中提取姓名、邮箱、内部域名等内容作为搜索词，这些
内容也会随查询发送；因此它降低的是网络与文件系统身份暴露，并不等于内容脱敏。

## 8. Claude 仍可能如何推断身份

即使使用 sandbox，以下内容一旦被用户问题、本地工具结果或项目文件发送给模型，
Claude 仍可能推断身份：

- 项目源代码中的姓名、邮箱和公司名。
- `.git/config` 中的 remote URL。
- Git commit 作者信息。
- 日志、配置、文档里的用户名。
- 用户主动输入的账号、域名或业务信息。
- 文件内容中的 API Key、Cookie 或访问令牌。

Sandbox 隐藏的是宿主机环境和未挂载文件，不是对发送内容做自动脱敏。需要更强
隐私时，应额外实现出站内容检查或对工具结果做字段级脱敏。

## 9. 网关接口和限制

网关只提供：

```text
GET  /health
POST /v1/chat/completions
```

主要限制：

- 单个请求体默认最多 8 MiB。
- 默认最多 4 个并发 Claude 请求。
- Claude 无输出超时默认 900 秒，可用 `AI_CLAUDE_GATEWAY_IDLE_TIMEOUT_MS` 调整；
  每收到一个 stream-json 事件都会重新计时，不会因为握手和协议续答的累计耗时误杀
  仍在活动的请求。
- 网关无输出超时返回 HTTP 504；本地 Agent 将 502/504 网关故障视为瞬时错误，
  在不执行未完整工具调用的前提下最多自动重试三次。
- 支持普通 JSON completion 和 SSE streaming 响应。流式请求会立即返回响应头，
  并每 15 秒发送 SSE heartbeat，避免客户端等待响应头约 300 秒后主动断开。
- 客户端中断或断开流时，网关会终止对应 Claude 子进程，避免重试产生孤儿请求。
- 不保存 Claude Code session：使用 `--no-session-persistence`。
- 网关本身没有额外 bearer token；安全边界依赖
  `127.0.0.1:8791` 和 SSH 登录控制。
- 任何已经能在 remote 本机访问该 loopback 端口的进程，都可能调用该网关。

## 10. 常用运维命令

### 本地

```bash
# 构建并更新 npm link 所指向的产物
npm run build
npm link

# 检查普通模式链路
ai-claude --probe

# 普通模式
ai-claude
ai-claude ask "只回复 OK"

# Sandbox 模式
ai-claude --sandbox --probe
ai-claude --sandbox
```

可选环境变量：

```text
AI_CLAUDE_SSH_HOST
AI_CLAUDE_REMOTE_GATEWAY_PORT
AI_CLAUDE_MODEL
AI_CLAUDE_SANDBOX_IMAGE
AI_CLAUDE_SANDBOX_NETWORK
AI_CLAUDE_SANDBOX_DNS
```

### Remote

```bash
# 状态
systemctl status ai-claude-gateway.service

# 日志
journalctl -u ai-claude-gateway.service -n 100 --no-pager

# 重启
systemctl restart ai-claude-gateway.service

# 确认只监听 loopback
ss -ltnp 'sport = :8791'

# 本机健康检查
curl http://127.0.0.1:8791/health
```

## 11. 更新 Remote 网关

在本地修改并检查后：

```bash
npm run build
node --check deploy/ai-claude-gateway.mjs
```

然后将两个部署文件复制到 remote 的对应位置，执行：

```bash
systemctl daemon-reload
systemctl restart ai-claude-gateway.service
systemctl is-active ai-claude-gateway.service
```

更新后建议比较 SHA-256，并重新运行：

```bash
ai-claude --probe
```

## 12. 卸载本次 Remote 中转

如果以后明确决定移除，目标是：

```text
/etc/systemd/system/ai-claude-gateway.service
/usr/local/lib/ai-claude-gateway/gateway.mjs
```

操作顺序应为：

```bash
systemctl disable --now ai-claude-gateway.service
# 删除上述两个目标
systemctl daemon-reload
```

这不会删除 `/usr/local/bin/claude` 或 `/root/.claude`，因为它们是远端 Claude
Code 本身及其账户数据，不属于中转网关文件。

## 13. 已完成的验证

- 本地 `npm run build` 通过。
- 本地测试 22/22 通过。
- `git diff --check` 通过。
- 普通模式 `ai-claude --probe` 成功访问 remote 网关。
- 已验证本地文件工具实际在本地执行，而不是在 remote 执行。
- Remote 网关与仓库部署源文件 SHA-256 一致。
- Remote 服务为 `enabled`、`active`。
- Remote 监听地址确认为 `127.0.0.1:8791`。
- 网关 systemd 进程由 PID 1 启动，不是某个交互 SSH shell 的子进程。
- 网关及其 Claude 子进程使用显式最小环境，不继承 `SSH_*`。
- Sandbox 代码和镜像定义已构建；真实容器测试等待本机安装 Docker runtime。
