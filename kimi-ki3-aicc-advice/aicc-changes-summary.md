# ai-cc 网络优化改动总结

## 背景

ai-cc 运行时频繁出现官方 Claude Code CLI 的提示：

```text
Waiting for API response · will retry in 2m 28s · check your network
```

该提示来自 Claude Code 自身，触发条件是 SSE 流 20 秒没有收到数据，随后进入指数退避重试。

已执行的优化均属于**低风险、无性能恶化隐患**的改动，分别针对 SSH 隧道健康检测、代理缓冲区、以及 Claude Code 内部重试/监控行为。

---

## 改动清单

### 1. 收紧 SSH 客户端 keepalive（deploy/ai-cc-proxy.sh）

**原配置：**

```sh
-o ServerAliveInterval=30 \
-o ServerAliveCountMax=3 \
```

最长需要 90 秒才能发现隧道已死。

**新配置：**

```sh
-o TCPKeepAlive=yes \
-o ServerAliveInterval=15 \
-o ServerAliveCountMax=2 \
-o ConnectTimeout=15 \
```

30 秒内即可发现断线，减少请求在死隧道上挂死的时间。

**备份：** `deploy/ai-cc-proxy.sh.bak.20260817`

---

### 2. 配置 SSH 服务端 keepalive（远程 /etc/ssh/sshd_config）

**新增配置：**

```sshd_config
ClientAliveInterval 15
ClientAliveCountMax 2
TCPKeepAlive yes
```

服务端也会每隔 15 秒探测客户端，连续 2 次无响应即断开。

**执行操作：**

- 备份 `/etc/ssh/sshd_config.bak.20260817`
- `sshd -t` 校验配置
- `systemctl reload sshd` 重载服务

**备份：** `/etc/ssh/sshd_config.bak.20260817`

---

### 3. 增大 Privoxy 缓冲区（deploy/ai-cc-privoxy.conf）

**原配置：**

```privoxy
buffer-limit  4096
```

**新配置：**

```privoxy
buffer-limit  8192
```

减少大响应被截断或慢传的概率。内存多占几 MB，对单 Claude Code 会话可忽略。

**备份：** `deploy/ai-cc-privoxy.conf.bak.20260817`

---

### 4. 限制 Claude Code 重试次数（src/claude-code-container.ts）

**新增环境变量：**

```ts
'--env', 'CLAUDE_CODE_MAX_RETRIES=3',
```

限制内置重试次数，避免指数退避拖到 2 分钟以上。

---

### 5. 显式启用 Claude Code stream watchdog（src/claude-code-container.ts）

**新增环境变量：**

```ts
'--env', 'CLAUDE_ENABLE_STREAM_WATCHDOG=1',
```

Claude Code 新版默认已开启 stream watchdog，显式设置是为了锁定行为，防止版本更新后变化。

**备份：** `src/claude-code-container.ts.bak.20260817`

---

## 未执行的优化

以下优化未执行，因为存在一定风险或需要更多观察：

| 优化项 | 未执行原因 |
|---|---|
| Privoxy `keep-alive-timeout` / `socket-timeout` / `default-server-timeout` | 值设得太短会导致连接频繁重建，反而增加延迟；建议先观察现有改动效果 |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS=90000` | 时间阈值过短可能误杀真正思考时间较长的请求，建议从更宽松值开始 |
| `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=60000` | 同上，模型流式输出中间停顿可能被误判为死流 |
| 更换 Privoxy 为 dante/redsocks 等 | 改动较大，可能引入新的配置和兼容问题 |

---

## 生效步骤

修改源码和配置后，需要重新构建 ai-cc 镜像才能生效：

```bash
cd /Users/lteu/progetto/agent
npm run build
AI_CC_REBUILD=1 ai-cc --probe
```

`--probe` 会验证：

- 容器直接 egress 被阻断
- 代理出口 IP 正常
- 浏览器渲染正常

---

## 回滚方法

如需回滚任意改动，可用对应备份恢复：

```bash
# 回滚 SSH 客户端配置
cp deploy/ai-cc-proxy.sh.bak.20260817 deploy/ai-cc-proxy.sh

# 回滚 Privoxy 配置
cp deploy/ai-cc-privoxy.conf.bak.20260817 deploy/ai-cc-privoxy.conf

# 回滚 Claude Code 容器启动参数
cp src/claude-code-container.ts.bak.20260817 src/claude-code-container.ts
```

远程 SSH 服务端回滚：

```bash
ssh remote
sudo cp /etc/ssh/sshd_config.bak.20260817 /etc/ssh/sshd_config
sudo sshd -t
sudo systemctl reload sshd
```

回滚后同样需要 `npm run build && AI_CC_REBUILD=1 ai-cc --probe`。

---

## 预期效果

- SSH 隧道两端 30 秒内发现断线，减少请求在死连接上挂死。
- Privoxy 缓冲区翻倍，降低大响应截断风险。
- Claude Code 内置重试受限，避免指数退避拖到过久。
- Stream watchdog 显式锁定，确保流健康监控稳定开启。

如果上述改动后仍频繁出现 banner，建议进一步排查：

1. Anthropic API 后端状态
2. `ai-cc --probe` 的 `time_namelookup` / `time_connect` / `time_total`
3. 代理容器日志 `docker logs ai-cc-proxy-xxx`
