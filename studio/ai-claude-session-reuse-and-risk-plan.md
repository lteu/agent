# ai-claude 会话复用、Token 优化与风险控制方案

日期：2026-08-03
状态：方案 A 已于 2026-08-04 实施并部署；方案 B/C 仍为备选

## 1. 背景与结论

`ai-claude --sandbox` 在大型项目读取过程中出现 Token 消耗异常：项目尚未读取完成，Claude Code 已触发 session limit。

最近一次实际运行数据：

| 时间 | 远端请求 | Cache write | Cache read | Output | 合计 |
|---|---:|---:|---:|---:|---:|
| 15:36:19–15:49:41 | 41 次 | 3,625,597 | 460,720 | 44,856 | 4,131,333 tokens |

13 分钟累计约 413 万 Token。主要消耗不是项目本身，而是每个本地工具步骤都重新启动 Claude Code，并将完整历史重新包装、重新写入 Prompt Cache。

核心结论：

1. `--sandbox` 不是根因，普通 `ai-claude` 也使用同一远端网关机制。
2. 当前网关显式使用 `--no-session-persistence`，每个模型步骤都创建新 Claude 会话。
3. 完整历史被 `JSON.stringify` 成一个不断变化的 user text block，破坏消息级前缀缓存。
4. 当前 autocompact 在单个长工具循环中找不到新的 `role=user` 边界，实际不会触发。
5. 旧工具结果始终保留，历史随文件读取次数增长；累计消耗接近 O(n²)。

## 2. 当前机制及问题

当前链路：

```text
本地 Agent
  → 请求远端 Gateway
  → 启动全新的 claude --print
  → 执行 MCP_GATEWAY_HANDSHAKE
  → 将完整 body.messages 序列化为单个 JSON 文本
  → Claude 返回 local tool call
  → Gateway 终止 Claude 进程
  → 本地执行工具
  → 下一步骤从头重复
```

### 2.1 完整历史重复 Cache Write

每一步输入分别近似为：

```text
H1
H1 + toolResult1
H1 + toolResult1 + toolResult2
H1 + toolResult1 + toolResult2 + toolResult3
...
```

因为这些内容被放进同一个 JSON text block，而不是稳定的原生 user/assistant/tool 消息序列，尾部新增内容会改变整个 block。服务端只能稳定复用约 11.5K Token 的固定前缀，其余不断增长的历史会被反复 Cache Write。

累计消耗近似：

```text
H1 + H2 + H3 + ... + Hn
```

而正确的前缀缓存应接近：

```text
首次完整前缀 + 每轮新增 delta
```

### 2.2 Autocompact 切分边界错误

当前压缩逻辑保留最近若干消息后，向后寻找下一条 `role=user`：

```ts
let cut = Math.max(base, history.length - keepRecent)
while (cut < history.length && history[cut].role !== 'user') cut++
if (cut >= history.length) return false
```

单个长任务的历史通常是：

```text
system
user
assistant(tool call)
tool result
assistant(tool call)
tool result
...
```

原始 user 后不再出现新的 user，因此扫描到数组末尾后直接返回 `false`。这次运行的远端 `messageCount` 从 2 一直增长到 83，中间没有 compact 请求，证明压缩未发生。

### 2.3 每次请求额外 Handshake

每个新 Claude 进程都先执行一次 `MCP_GATEWAY_HANDSHAKE`。在最近 40 个成功请求中，固定 Cache Read 累计约 46 万 Token，占总量约 11%。

### 2.4 工具结果缺少生命周期管理

虽然 `read_file` 单次最多返回约 20K 字符，但所有历史结果都会进入后续请求。当前没有：

- 旧工具结果清理；
- 大结果落盘并只保留 preview；
- 每轮工具结果累计预算；
- 基于真实 API usage 的上下文压力判断。

## 3. 方案 A：使用 `--session-id` / `--resume`

### 3.1 目标

每个本地 Agent run 对应一个稳定的远端 Claude session。第一次发送初始任务，后续只发送新增 user 消息或原生 `tool_result`，不再发送完整历史。

### 3.2 新链路

```text
第一次请求
  → 本地为本次 Agent run 生成 Claude session UUID
  → claude -p --session-id <UUID>
  → 只发送初始任务

Claude 返回 tool_use
  → Gateway 返回 tool_use + session UUID
  → 本地执行工具

后续请求
  → claude -p --resume <UUID>
  → 只发送对应本地工具结果增量
  → Claude 从已保存上下文继续
```

session 模式必须删除 `--no-session-persistence`，否则 Claude Code 不会保存会话，也无法
resume；不支持新协议的旧客户端兼容路径仍保留该参数。

### 3.3 会话状态

```ts
type RemoteSession = {
  localRunId: string
  claudeSessionId: string
  pendingToolUseIds: Set<string>
  lastActivityAt: number
  running: boolean
  completed: boolean
}
```

### 3.4 工具结果增量格式与 Claude Code 2.1.220 兼容处理

原设计准备在 resume stdin 中发送原生 `tool_result`：

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_xxx",
        "content": "本地工具输出"
      }
    ]
  }
}
```

实际验证发现，Claude Code 2.1.220 会在 gateway 捕获 MCP `tool_use` 后自行写入一条
`dontAsk mode` permission-denied 结果。如果预授权该 MCP 工具，让调用保持 pending，
下一次 `--resume` 又会先恢复 pending MCP RPC，尚未来得及读取 stdin 中的原生
`tool_result`，导致请求挂住。

因此当前实现采用兼容格式：仍然每步 `--resume`，但把 `tool_use_id`、工具名和真实本地
结果封装成 `LOCAL_AGENT_RESUME_UPDATE` user text block。system prompt 明确声明 Claude Code
自动写入的 permission denial 只是传输层副作用，本地增量结果才是权威结果。这样既不重发
完整历史，也不会触发 pending MCP 恢复死锁。

不能在 resume 后再次发送完整 `body.messages`，否则会把旧历史重复加入 Claude session。

真实两步验证（读取 `package.json` 后回答 `name`）只产生一次 `read_file`，远端事件严格为
`start step=0` 与 `resume step=1` 两个请求，总计约 20K tokens；旧实现同类长任务会随步骤数
反复全量 cache write。

### 3.5 必须解决的工程问题

- 确认 assistant `tool_use` 在 Claude 进程终止前已经持久化。
- Gateway 响应必须携带 session ID，本地 engine 需要保存它。
- 同一 session 同时只能有一个进行中的请求。
- 验证 `tool_result.tool_use_id` 属于当前 session 的 pending 集合。
- 网络重试必须幂等，不能重复提交同一个工具结果。
- compact、verify、subagent 使用独立 session，不能污染主 session。
- queued prompt 以新的 user message 追加，不能重发旧历史。
- session 完成或超时后做 TTL 清理。

### 3.6 优缺点

优点：

- 对当前 HTTP/SSE 架构改动相对较小。
- 删除完整历史重传和每步 Cache Write。
- 使用 Claude Code 官方支持的 session resume 能力。
- Claude Code 自身可以管理 Prompt Cache 和上下文压缩。

缺点：

- 依赖远端磁盘会话持久化。
- 存在进程退出与会话落盘之间的竞态。
- 重试、并发和 tool_use 配对需要严格状态机。

## 4. 方案 B：每个 Agent run 使用长驻 Claude 进程

### 4.1 目标

在整个本地 Agent run 生命周期中保持同一个远端 Claude 进程。远端 MCP 工具调用通过双向通道发送到本地，本地执行后将结果返回同一个 MCP call。

```text
本地 Agent run
      ↕ WebSocket / 双工通道
远端 Gateway
      ↕ IPC
长驻 Claude 进程
      ↕ MCP JSON-RPC
本地工具代理 MCP Server
```

### 4.2 流程

1. 本地创建 run，并建立双向连接。
2. Gateway 启动一次 Claude Code。
3. Claude 调用 MCP 工具。
4. MCP Server 将调用交给 Gateway。
5. Gateway 将工具请求实时发送给本地。
6. 本地执行后回传 result。
7. MCP Server 正常回复 `tools/call`。
8. Claude 在同一个进程和上下文中继续推理。

### 4.3 双向通信选择

可选实现：

1. WebSocket：最适合长生命周期双向事件。
2. HTTP SSE + result callback：保留现有下行 SSE，新增上传工具结果的 endpoint。
3. HTTP long polling：实现简单，但延迟和状态管理较差。
4. 单 SSH stdio 通道：适合单用户原型，但恢复能力较弱。

### 4.4 优缺点

优点：

- 完全消除每步新进程和 handshake。
- 没有 resume 落盘竞态。
- MCP tool_use/tool_result 保持原生协议。
- 最接近 Claude Code/`studio/cc` 的正常 agent loop。

缺点：

- 需要双向传输和连接恢复协议。
- Gateway 状态管理复杂度最高。
- 必须处理断线、重连、工具超时、进程回收和背压。

## 5. 方案 C：改用 Anthropic API / Agent SDK

### 5.1 目标

不再把个人订阅 Claude Code 包装成 OpenAI-compatible gateway，而是使用 Anthropic Console API Key，通过 Messages API 或官方 Agent SDK 构造自己的 Agent。

### 5.2 优缺点

优点：

- 最清晰的程序化集成与商业使用路径。
- 原生 structured messages、tool_use/tool_result 和 Prompt Caching。
- Usage、限流、成本和重试语义清晰。
- 不依赖远端 CLI 行为、session 文件格式或内部事件。

缺点：

- 按 API Token 计费。
- 需要自行实现或复用 Agent SDK 的工具循环、权限与会话管理。
- 无法直接消费个人 Pro/Max 套餐额度。

适用场景：

- 多用户服务；
- 对公网关；
- 长期稳定运行；
- 商业化或团队共享；
- 需要明确 SLA、成本审计和合规边界。

## 6. 无论采用哪种架构都应实施的上下文治理

### 6.1 修复 Autocompact 边界

压缩切分不能只寻找下一条 `role=user`。应该识别完整协议组：

```text
assistant(tool_calls)
tool result 1
tool result 2
...
```

安全切点可以是：

- 下一条不带未完成 tool call 的 assistant/user 边界；
- 一个完整 assistant tool-call batch 及其全部 tool results 之后；
- 或先把旧 batch 转成摘要事件，再保留最近若干完整 batch。

### 6.2 工具结果 Microcompact

对以下旧结果进行替换：

- `read_file`
- `run_bash`
- `grep`
- `glob`
- `web_fetch`
- browser snapshot

示例：

```text
[Old tool result content cleared]
```

保留：

- 最近若干个工具 batch；
- 修改操作的路径和摘要；
- 测试退出码与失败原因；
- 当前任务仍然依赖的证据。

### 6.3 大结果落盘

当单个工具结果超过阈值：

1. 完整输出写入 session 专属目录。
2. 模型上下文只保留路径、原始大小和约 2KB preview。
3. 模型需要更多内容时再按范围读取。

### 6.4 累计预算

需要同时限制：

- 单个工具结果大小；
- 单个并行 batch 的结果总大小；
- 整个活跃上下文中的工具结果总量；
- compact 后必须保留的最小工作集。

### 6.5 使用真实 Usage

上下文压力应优先使用最近一次 API 返回的：

```text
input_tokens
cache_read_input_tokens
cache_creation_input_tokens
output_tokens
```

再加上最后一次响应之后新增消息的估算值。字符数除以固定系数只能作为无 usage 数据时的 fallback。

### 6.6 工具 Schema 延迟加载

当前每一步固定提供约 32 个工具。应考虑：

- 核心工具始终加载；
- 浏览器、表格、邮件、渠道工具按任务启用；
- schema 超过阈值时引入 tool search；
- 工具排序和 schema 字节必须跨轮稳定，避免破坏 cache key。

## 7. 安全控制

### 7.1 Session 隔离

- Session ID 必须是随机 UUID。
- 本地 run 与远端 session 一对一。
- 不接受客户端任意指定其他 session ID。
- 同一 session 强制串行。
- Gateway 保存 owner、pending tool IDs 和状态。
- 不在普通 UI、URL、聊天日志中暴露 session ID。

### 7.2 远端数据

启用 resume 后，远端磁盘可能保存：

- 项目源码片段；
- 文件读取结果；
- shell 输出；
- 文件路径、错误信息与任务描述。

应使用 session 专属存储、限制权限，并在完成或 TTL 到期后清理。需要明确：即使本地不落盘，提交给模型的内容仍会发送给 Anthropic。

### 7.3 工具结果校验

- tool result 必须匹配当前 pending `tool_use_id`。
- 已完成 ID 不能再次提交。
- 限制结果字节数和内容类型。
- 拒绝跨 session tool result。
- 网络重试使用 request/result idempotency key。

### 7.4 Gateway 边界

- 只监听 `127.0.0.1`。
- 仅通过 SSH tunnel 暴露。
- 不开放公网。
- 不允许多用户共享个人 OAuth 会话。
- 记录安全审计，但不得记录 OAuth token、SSH key 或完整敏感工具输出。

## 8. Anthropic 账号与条款风险

现有日志只显示正常的 `CLAUDE_RATE_LIMIT`，没有看到账号暂停、认证撤销、policy violation 或 abuse warning。因此目前没有证据证明账号已被风控。

但 Anthropic 服务端能够观察：

- OAuth 账号；
- 调用时间、频率和模型；
- Token 和 Prompt Cache 使用；
- 大量连续短命 Claude Code 会话；
- MCP 工具和会话行为；
- rate-limit 状态。

官方 Claude Code 支持 `-p`、stream-json、`--session-id`、`--resume` 和 Agent SDK，因此私人单用户的脚本化 Claude Code 使用具有官方产品入口。

另一方面，消费者条款对非 API Key 的自动化访问有限制。将个人 Pro/Max Claude Code OAuth 包装成通用 API、开放给多人、公开部署或转售，风险高于个人自用。

边界建议：

- 私人、单用户、本人的编码任务：可使用 Claude Code session resume。
- 不要通过轮换账号、伪造会话等方式规避额度。
- 不要将个人 OAuth gateway 开放公网或共享给他人。
- 多用户、商业服务或长期自动化后端使用 Anthropic API Key/PAYG。
- Session reuse 是正常效率优化，不应被设计成绕过 rate limit。

## 9. 推荐实施顺序

### 阶段 0：立即止损

1. 修复 autocompact 安全切点。
2. 降低工具结果活跃预算。
3. 旧 read/bash/grep/glob 结果 microcompact。
4. 暂时限制单个 run 的远端请求次数与 Cache Write 总量。
5. UI 显示当前 run 的 request count、cache write 和预计额度压力。

### 阶段 1：实施方案 A

1. 为每个本地 Agent run 创建 remote session UUID。
2. 删除 `--no-session-persistence`。
3. 第一次使用 `--session-id`。
4. 后续使用 `--resume`。
5. 只发送新增 user/tool_result。
6. 增加 session 串行锁、pending tool ID 校验和幂等重试。
7. 增加 TTL 清理。
8. 做 50–100 步长任务压力测试并比较 Cache Write。

### 阶段 2：评估方案 B

当方案 A 仍存在明显的进程启动开销、resume 竞态或 session 文件问题时，再建设长驻 Claude 进程和双向工具通道。

### 阶段 3：产品化决策

如果 `ai-claude` 将供多人或作为长期服务运行，迁移到 Anthropic API/Agent SDK，不再依赖个人订阅 OAuth gateway。

## 10. 验收指标

### 功能正确性

- 连续 100 个工具步骤不丢失上下文。
- tool_use/tool_result 始终严格配对。
- 网络重试不重复执行有副作用工具。
- queued prompts、subagent、compact 和 verify 会话互不污染。
- session 结束后资源能够回收。

### Token 效率

- 第 N 步不再重写此前完整历史。
- 稳定前缀主要表现为 Cache Read，而不是不断增长的 Cache Write。
- 40 步同类任务的 Cache Write 相比当前基线降低至少 80%。
- Handshake 从“每请求一次”降为“每 session 最多一次”，或完全删除。
- 旧工具结果不再永久占据活跃上下文。

### 安全性

- 无法跨 session 注入 tool result。
- 无法并发 resume 同一个 session。
- Gateway 不对公网开放。
- Session 数据按 TTL 清理。
- 日志不包含认证凭据和完整敏感源码。

## 11. 最终建议

短期采用“阶段 0 + 方案 A”：先修复 compact 和工具结果治理，再通过 `--session-id/--resume` 消除完整历史重传。

中期如果需要更低延迟和更强协议一致性，实施方案 B 的长驻进程与双向 MCP 通道。

如果未来需要多用户、商业部署或公网服务，直接选择方案 C，通过 Anthropic API/Agent SDK 获得明确的程序化访问、计费与合规边界。
