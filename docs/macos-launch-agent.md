# 使用 LaunchAgent 常驻运行 ai 服务

这份模板适用于 macOS 上需要长驻的四个入口：

| 服务 | `ai` 参数 | 建议标签 |
| --- | --- | --- |
| QQ 机器人 | `serve` | `com.example.ai-qq` |
| 个人微信 | `wx` | `com.example.ai-wx` |
| 企业微信 | `wechat` | `com.example.ai-wechat` |
| 行情监控 | `watch` | `com.example.ai-watch` |

LaunchAgent 会在当前用户登录后启动进程，并在异常退出后重新拉起。它不会在注销状态下运行，也不能让程序在机器睡眠时继续处理消息或轮询。

## 1. 确认命令路径

```bash
command -v ai
```

记下输出的绝对路径。LaunchAgent 不会读取 `~/.zshrc` 等交互式 Shell 配置；不要依赖其中设置的 `PATH` 或环境变量。模型和渠道凭据优先使用 `ai --set-*` 写入 `~/.ai/config.json`。必须使用环境变量覆盖时，应显式写入下方的 `EnvironmentVariables`。

## 2. 创建 plist

以下以 QQ 服务为例。把标签、`ai` 路径、子命令、用户名和日志名替换为目标服务的实际值，然后保存为 `~/Library/LaunchAgents/com.example.ai-qq.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.ai-qq</string>

  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/from/command-v-ai</string>
    <string>serve</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/absolute/path/to/agent-workspace</string>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>15</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>/Users/your-name/Library/Logs/ai-qq.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/your-name/Library/Logs/ai-qq.err.log</string>
</dict>
</plist>
```

`WorkingDirectory` 决定 Agent 默认能看到和操作的项目，也决定默认日志所在的仓库。应选择范围尽可能小、且不含无关密钥的目录。

如果必须添加环境变量，在 `EnvironmentVariables` 中逐项增加。例如：

```xml
<key>AI_WECHAT_WHITELIST</key>
<string>alice,bob</string>
```

plist 会以明文保存这些值，不适合放 API Key 或长期密钥。

## 3. 校验并启动

以下命令中的文件名和标签必须与 plist 内容一致：

```bash
plutil -lint ~/Library/LaunchAgents/com.example.ai-qq.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.ai-qq.plist
launchctl enable gui/$(id -u)/com.example.ai-qq
launchctl kickstart -p gui/$(id -u)/com.example.ai-qq
```

## 4. 日常管理

```bash
launchctl print gui/$(id -u)/com.example.ai-qq
tail -f ~/Library/Logs/ai-qq.err.log
launchctl kickstart -k gui/$(id -u)/com.example.ai-qq
launchctl bootout gui/$(id -u)/com.example.ai-qq
```

更新代码并重新运行 `npm run build`、修改配置或更换工作目录后，使用 `kickstart -k` 重启服务。

QQ 和个人微信进程会在 macOS 上调用 `caffeinate -i`，避免空闲休眠；合上笔记本盖子通常仍会强制休眠。企业微信和行情监控也会随系统睡眠暂停。需要真正的 7×24 服务时，应使用不会休眠的主机。
