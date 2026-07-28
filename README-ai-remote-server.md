# ai-remote 服务器配置与运维

本文介绍如何在 Linux 服务器上部署 `ai-remote-server`。服务负责保管真实模型
API Key、绑定客户端设备、代理模型请求，并使用 SQLite 记录 Token 用量。

同一 HWID 再次绑定时视为同一台硬件重新安装：服务端保留原设备、额度和用量，
只轮换 Access Key；不同 HWID 才创建新设备。

当前客户端默认通过 SSH 隧道访问服务，因此服务只监听服务器本机
`127.0.0.1:8789`，不需要向公网开放 8789。

## 1. 架构与端口

```text
用户电脑 ai-remote
  └─ SSH（当前部署使用 TCP 443）
      └─ 服务器 127.0.0.1:8789
          └─ ai-remote-server
              ├─ 模型厂商 HTTPS API（出站 TCP 443）
              └─ /var/lib/ai-remote/ai-remote.sqlite
```

防火墙要求：

- 入站：允许客户端访问服务器的 SSH 端口，当前部署为 TCP `443`
- 出站：允许 TCP `443`，供服务端访问模型厂商 API
- 不要开放 TCP `8789`；它只供服务器本机和 SSH 隧道访问

## 2. 服务器要求

- Linux（当前部署为 Ubuntu）
- Node.js 22 或更高版本
- systemd
- 能够访问模型厂商 HTTPS API
- 具有部署 `/opt`、`/etc/systemd/system` 和 `/var/lib` 的权限

检查环境：

```bash
node --version
systemctl --version
```

服务端使用 Node 内置的 `node:sqlite`。Node.js 版本过低时无法启动。

## 3. 本地构建

在开发机的 Agent 项目中执行：

```bash
cd ~/progetto/agent
npm install
npm run build:remote
```

构建产物：

```text
dist/remote.js       客户端 ai-remote 启动器
dist/remote-cli.js   独立的托管版 Agent
dist/server.js       Linux 服务器运行文件
```

原来的 `npm run build` 和 `dist/cli.js` 不受影响。

## 4. 创建服务器目录

以下示例假设 SSH 主机别名为 `remote`：

```bash
ssh remote 'install -d -m 0755 /opt/ai-remote/dist'
ssh remote 'install -d -m 0700 /var/lib/ai-remote'
```

目录用途：

```text
/opt/ai-remote/dist/       服务程序
/var/lib/ai-remote/        SQLite 数据库
/etc/ai-remote.env         服务端密钥和运行参数
/etc/systemd/system/       systemd 单元
```

## 5. 上传服务程序

```bash
scp dist/server.js remote:/opt/ai-remote/dist/server.js
ssh remote 'chmod 0755 /opt/ai-remote/dist/server.js'
```

部署过程中不要把客户端配置文件或 `~/.ai-remote/config.json` 上传到服务器。

## 6. 配置服务环境变量

在服务器创建 `/etc/ai-remote.env`：

```bash
ssh remote
sudoedit /etc/ai-remote.env
```

示例内容：

```dotenv
AI_REMOTE_UPSTREAM_API_KEY="替换成真实模型API Key"
AI_REMOTE_UPSTREAM_BASE_URL="https://api.deepseek.com"
AI_REMOTE_UPSTREAM_MODEL="deepseek-v4-flash"
AI_REMOTE_INITIAL_QUOTA="100000"
AI_REMOTE_NOTICE_THRESHOLD="80000"
```

设置权限：

```bash
chmod 0600 /etc/ai-remote.env
chown root:root /etc/ai-remote.env
```

配置说明：

- `AI_REMOTE_UPSTREAM_API_KEY`：真实模型 Key，只能保存在服务器
- `AI_REMOTE_UPSTREAM_BASE_URL`：上游 OpenAI 兼容 API 地址
- `AI_REMOTE_UPSTREAM_MODEL`：服务端强制使用的模型，客户端不能覆盖
- `AI_REMOTE_INITIAL_QUOTA`：新设备初始 Token 余额
- `AI_REMOTE_NOTICE_THRESHOLD`：累计用量达到该值时显示提醒
- `AI_REMOTE_HOST`：监听地址，默认且建议保持 `127.0.0.1`
- `AI_REMOTE_PORT`：监听端口，默认 `8789`
- `AI_REMOTE_DB`：SQLite 路径，默认
  `/var/lib/ai-remote/ai-remote.sqlite`
- `AI_REMOTE_INVITE_CODE`：可选；设置后首次绑定必须提供相同邀请码

不要把 `/etc/ai-remote.env` 提交到 Git，也不要在聊天、日志或截图中展示真实 Key。

## 7. 安装 systemd 服务

项目提供的单元文件位于：

```text
deploy/ai-remote.service
```

上传并启动：

```bash
scp deploy/ai-remote.service remote:/etc/systemd/system/ai-remote.service
ssh remote 'systemctl daemon-reload'
ssh remote 'systemctl enable --now ai-remote.service'
```

服务使用以下安全限制：

- `NoNewPrivileges=true`
- `PrivateTmp=true`
- `ProtectSystem=strict`
- `ProtectHome=true`
- 只有 `/var/lib/ai-remote` 可写
- `UMask=0077`，数据库默认只有服务账号可读写

## 8. 验证部署

检查服务：

```bash
ssh remote 'systemctl status ai-remote.service --no-pager'
ssh remote 'systemctl is-enabled ai-remote.service'
ssh remote 'systemctl is-active ai-remote.service'
```

检查监听地址：

```bash
ssh remote "ss -lntp | grep 8789"
```

正确结果应只出现：

```text
127.0.0.1:8789
```

如果出现 `0.0.0.0:8789` 或 `[::]:8789`，说明服务暴露到了公网，应立即检查
`AI_REMOTE_HOST` 配置。

检查健康接口：

```bash
ssh remote 'curl -fsS http://127.0.0.1:8789/health'
```

示例响应：

```json
{"status":"ok","model":"deepseek-v4-flash"}
```

最后在客户端验证完整链路：

```bash
ai-remote usage
ai-remote ask "只回复 OK"
ai-remote usage
```

第二次查询的 `used_tokens` 应增加。

## 9. 日常运维

查看状态：

```bash
ssh remote 'systemctl status ai-remote.service --no-pager'
```

查看最近日志：

```bash
ssh remote 'journalctl -u ai-remote.service -n 100 --no-pager'
```

持续查看日志：

```bash
ssh remote 'journalctl -u ai-remote.service -f'
```

重启服务：

```bash
ssh remote 'systemctl restart ai-remote.service'
```

停止或启动：

```bash
ssh remote 'systemctl stop ai-remote.service'
ssh remote 'systemctl start ai-remote.service'
```

## 10. 更新服务器版本

先在本地构建：

```bash
cd ~/progetto/agent
npm run build:remote
```

上传到临时文件，验证后原子替换：

```bash
scp dist/server.js remote:/opt/ai-remote/dist/server.js.new
ssh remote 'node --check /opt/ai-remote/dist/server.js.new'
ssh remote 'install -m 0755 /opt/ai-remote/dist/server.js.new /opt/ai-remote/dist/server.js'
ssh remote 'systemctl restart ai-remote.service'
ssh remote 'systemctl is-active ai-remote.service'
ssh remote 'curl -fsS http://127.0.0.1:8789/health'
```

更新服务端程序不会删除 SQLite 数据库，也不会改变已经绑定的客户端凭证。

## 11. 数据备份

需要备份：

```text
/var/lib/ai-remote/ai-remote.sqlite
/etc/ai-remote.env
```

SQLite 使用 WAL 模式。不要在服务运行时只复制主 `.sqlite` 文件而忽略 WAL；
建议短暂停止服务后备份：

```bash
ssh remote 'systemctl stop ai-remote.service'
scp remote:/var/lib/ai-remote/ai-remote.sqlite ./ai-remote.sqlite.backup
ssh remote 'systemctl start ai-remote.service'
```

环境文件包含真实模型 Key，备份文件必须加密并限制访问权限。

## 12. 常见故障

### `ai-remote` 无法建立 SSH 隧道

先确认：

```bash
ssh remote
```

然后检查 SSH 配置中的主机、用户、端口和私钥。当前客户端默认使用 SSH 别名
`remote`，也可临时指定：

```bash
AI_REMOTE_SSH_HOST=my-server ai-remote usage
```

### 服务没有监听 8789

```bash
ssh remote 'systemctl status ai-remote.service --no-pager -l'
ssh remote 'journalctl -u ai-remote.service -n 100 --no-pager'
```

常见原因：

- Node.js 版本过低，不支持 `node:sqlite`
- `/etc/ai-remote.env` 不存在或权限错误
- `/var/lib/ai-remote` 不存在
- systemd 单元中的程序路径错误

### 返回“服务端尚未配置模型密钥”

检查 `/etc/ai-remote.env` 是否包含：

```text
AI_REMOTE_UPSTREAM_API_KEY
```

修改后重启：

```bash
ssh remote 'systemctl restart ai-remote.service'
```

### 返回 402 或额度不足

设备余额已经耗尽。可通过 SQLite 管理工具或后续充值/管理接口增加额度；
不要通过删除数据库绕过记账，否则会同时丢失所有设备绑定和用量记录。

## 13. 当前部署路径速查

```text
服务源码       src/server.ts
systemd 模板   deploy/ai-remote.service
远程程序       /opt/ai-remote/dist/server.js
环境配置       /etc/ai-remote.env
SQLite         /var/lib/ai-remote/ai-remote.sqlite
systemd 服务   ai-remote.service
监听地址       127.0.0.1:8789
客户端入口     ai-remote
```
