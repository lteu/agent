# `ai-claude` 使用与部署

`ai-claude` 运行本项目的 Agent，并通过临时 SSH 隧道把模型请求交给远端 Claude
网关。普通模式下，工作目录和文件、Shell 等工具都在本机；远端只使用自己的
Claude 登录状态完成模型推理。

## 前置条件

- 本机已完成项目安装和 `npm run build`。
- 本机能够以非交互方式执行 `ssh remote`，或通过 `AI_CLAUDE_SSH_HOST` 指定其他主机。
- 远端已安装 Node.js 和 Claude Code，并已完成登录。
- 远端网关监听 `127.0.0.1:8791`；不应把该端口直接暴露到公网。
- 使用 `--sandbox` 时，本机还需要正在运行的 Docker 环境。

## 基本用法

```bash
ai-claude --probe
ai-claude
ai-claude ask "只回复 OK"
ai-claude ask --file question.txt
```

`--probe` 会建立 SSH 隧道并检查网关健康状态。普通调用结束后，启动器会关闭临时
隧道。

## Sandbox 模式

```bash
ai-claude --sandbox --probe
ai-claude --sandbox
ai-claude --sandbox ask "读取 package.json，只回复 name"
```

Sandbox 使用两个相互隔离的容器：

- Agent 容器只把当前目录挂载为 `/workspace`，看不到宿主机 HOME、SSH 配置或
  SSH Agent。
- 隧道容器负责读取 SSH 配置并连接远端，但不挂载项目目录。

默认 `egress` 网络允许 Agent 容器访问公网。设置
`AI_CLAUDE_SANDBOX_NETWORK=isolated` 可关闭公网访问，只保留 Claude 网关链路。
允许公网时，Agent 也可能把工作区内容发送给第三方网站，因此仍应限制挂载范围。

## 远端部署

仓库提供网关程序和 systemd 单元：

- [`deploy/ai-claude-gateway.mjs`](../deploy/ai-claude-gateway.mjs)
- [`deploy/ai-claude-gateway.service`](../deploy/ai-claude-gateway.service)

默认单元假设网关安装在 `/usr/local/lib/ai-claude-gateway/gateway.mjs`：

```bash
ssh remote 'install -d /usr/local/lib/ai-claude-gateway'
scp deploy/ai-claude-gateway.mjs remote:/usr/local/lib/ai-claude-gateway/gateway.mjs
scp deploy/ai-claude-gateway.service remote:/etc/systemd/system/ai-claude-gateway.service
ssh remote 'systemctl daemon-reload && systemctl enable --now ai-claude-gateway.service'
```

部署后检查服务和监听地址：

```bash
ssh remote 'systemctl status ai-claude-gateway.service --no-pager'
ssh remote 'ss -lntp | grep 8791'
```

正确配置应只监听 `127.0.0.1:8791`。

## 配置与日志

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `AI_CLAUDE_SSH_HOST` | `remote` | SSH 主机或别名 |
| `AI_CLAUDE_REMOTE_GATEWAY_PORT` | `8791` | 远端网关端口 |
| `AI_CLAUDE_MODEL` | `sonnet` | Claude 模型 |
| `AI_CLAUDE_SANDBOX_IMAGE` | `ai-claude-sandbox:local` | Sandbox 镜像名 |
| `AI_CLAUDE_SANDBOX_NETWORK` | `egress` | `egress` 或 `isolated` |
| `AI_CLAUDE_SANDBOX_DNS` | `1.1.1.1` | Egress DNS；`system` 表示使用 Docker 默认值 |

本地轻量日志位于 `log/agent-events.jsonl`；远端请求日志默认位于
`/var/log/ai-claude-gateway/events.jsonl`。设置 `TRACE=1` 会记录完整请求与网关通信，
其中可能包含密钥、上下文和文件内容，应按敏感数据处理。

2026-07-30 的完整部署快照已归档到
[`assets/archive/ai-claude-remote-relay-2026-07-30.md`](../assets/archive/ai-claude-remote-relay-2026-07-30.md)。
