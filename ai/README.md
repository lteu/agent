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

#### 换台 Mac 装时报 `EEXIST: file already exists /usr/local/bin/ai`

说明 `/usr/local/bin/ai` 已被占用——多半是之前 `npm link` / `.pkg` 装过留下的旧链接（或别的程序也叫 `ai`）。`npm link` 不肯覆盖已存在的文件，于是报错。先看一眼那个文件是什么：

```bash
ls -la /usr/local/bin/ai
readlink /usr/local/bin/ai     # 指向本项目旧路径 = 旧链接，可放心删
```

确认是旧链接后删掉重链（权限不够就加 `sudo`）：

```bash
rm /usr/local/bin/ai           # 或 sudo rm ...
npm link
```

> 偷懒版：`npm link --force` 直接覆盖。仅在确认 `ai` 这名字没被别的程序占用时用，否则会覆盖掉人家的命令。

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

### 非交互单轮问答（`ai ask`）

脚本 / 管道场景不想进交互对话框，直接问一句拿到答案：

```bash
ai ask "帮我看看这个项目用的什么包管理器"     # 问题从命令行参数传入
ai ask --file question.txt                  # 问题从文件读取（文件内容整体作为一条消息）
```

- 答案（模型最终文本）打印到 **stdout**，工具调用进度打印到 **stderr**，两者互不干扰，方便 `ai ask ... > answer.txt` 或接管道；
- 和交互模式共用同一个 agent 引擎与本地工具（读写文件、跑命令等），单轮问答内可以多步调用工具；
- 未配置 API key 时会提示先跑 `ai --set-key`，不会像交互模式那样弹出引导界面。

## 技能（Skills）

技能 = 一段**可复用的操作手册**，存成带 frontmatter 的 markdown。对标 Claude Code 的「渐进式披露」(progressive disclosure)：

- 启动时只把每个技能的**名字 + 一句话描述**塞进系统提示（几乎不占 token）；
- 模型判断某个技能与当下需求相关时，才用 `skill` 工具把**完整正文**拉进上下文，按其步骤执行。

技能从两处加载（项目本地覆盖用户全局的同名技能）：

| 位置 | 用途 |
| --- | --- |
| `~/.ai/skills/<名字>/SKILL.md` | 用户全局，所有项目通用 |
| `<项目>/.ai/skills/<名字>/SKILL.md` | 项目本地，随仓库走、团队共享 |

也支持单文件形式 `<dir>/<名字>.md`。一个 `SKILL.md` 形如：

```markdown
---
name: release-notes
description: 根据 git 提交历史生成发布说明
---

# 生成发布说明
在这里写给模型看的操作步骤（分阶段、可执行）……
```

正文里可以引用同目录下的脚本/资源（用相对路径）。命令：

```bash
ai --skills                 # 列出已安装技能（名字 / 来源 / 路径）
ai --skill-show <名字>       # 打印模型实际会读到的完整正文（审查 / 测试用）
ai --skill-new <名字>        # 在 ~/.ai/skills/<名字>/SKILL.md 生成一个模板
```

本仓库自带一个示例技能 `.ai/skills/release-notes/`，可直接照搬改写。技能改完下次对话即生效，QQ / 企业微信 channel 同样适用。

### 安装网上下载的技能

一个技能要么是「目录 + `SKILL.md`」，要么是单个 `.md` 文件。安装 = **把它放进技能目录**即可，没有注册步骤：

```bash
# 全局安装（所有项目可用）：解压 / 克隆 / 拷贝到 ~/.ai/skills/ 下
mkdir -p ~/.ai/skills
unzip some-skill.zip -d ~/.ai/skills/            # 压缩包
git clone https://example.com/foo-skill ~/.ai/skills/foo-skill   # git 仓库
cp -r ./download/bar-skill ~/.ai/skills/         # 本地拷贝

# 只给当前项目用、并随仓库提交：放到项目里
cp -r ./download/bar-skill <项目>/.ai/skills/
```

要点：

- **目录名不重要，frontmatter 里的 `name` 才是技能名**（决定模型怎么称呼它、`skill` 工具用哪个名字调用）。`name` 缺省时才回退用目录/文件名。
- 目录式技能只认其**顶层的 `SKILL.md`**；多嵌一层（如 `foo/foo/SKILL.md`）会扫不到——装完务必 `ai --skills` 确认能列出来。
- 同名技能**项目本地覆盖用户全局**，可借此在某个项目里临时改写一个全局技能。

### ⚠️ 注意事项（安全）

技能正文是**模型会直接照做的指令**，且本 agent 的 `run_bash` 在你本机**无沙箱**执行。一个恶意技能可以诱导模型删文件、把 `~/.ai/config.json` 里的 **API key / QQ token 外传**、或 `curl xxx | sh`。所以**装之前一定先读**：

- 技能就是纯文本，安装前 `cat ~/.ai/skills/<名>/SKILL.md` 通读一遍，警惕这类内容：
  - 让你 / 让模型 `curl ... | sh`、`eval`、下载并执行二进制；
  - 读取或发送 `~/.ssh`、`~/.ai/config.json`、`.env`、各种 token / 密钥；
  - `rm -rf`、改 `~/.zshrc` / `crontab` 之类的持久化动作；
  - 往陌生地址 `web_fetch` / 发邮件（外带数据）。
- **连同附带的脚本一起看**：`grep -rIn "curl\|wget\|eval\|rm -rf\|config.json\|token\|secret" ~/.ai/skills/<名>/`。
- 只装可信来源的技能；不确定就先放**项目本地**目录、在不含敏感配置的环境里试。
- 技能没有自动更新；`git clone` 来的技能 `git pull` 后**重新审一遍 diff** 再用。

### 测试方法

装好后按这三步验证：

1. **能被发现**——`ai --skills` 里出现它，且 `name` / 描述 / 路径都对（列不出 = frontmatter 没解析到，多半是目录层级或 `---` 分隔符写错）。
2. **正文如预期**——`ai --skill-show <名字>` 打印模型实际会收到的整段内容；确认没有上面那些可疑指令，描述能让模型在「该用时」想起它。
3. **真能被调用**——`ai` 进对话，说一句**贴着该技能描述**的需求，观察进度行是否出现 `技能 <名字>`（即模型调了 `skill` 工具），再看它是否按正文步骤执行。没被触发通常是 `description` 写得太泛或与需求对不上，回去把描述写具体。

## 稳定性与崩溃日志

输入框过去在**快速打字、粘贴、或方向键/退格和字符混在一起**时偶发「卡住/字符错乱」。
原因是 `useInput` 回调直接读 React 闭包里的 `value/cursor`：Ink 在一个 stdin 数据块里可能连续触发多次回调，
React 18 的批处理让这几次都基于同一份「旧」状态计算，后写覆盖前写 → 丢字符、光标错位。
现已改为用 **ref 承载状态**（同步真相源），每次按键都能拿到上一次的结果，从根上消除这个竞态。

此外加了**崩溃兜底**：任何未捕获的异常/拒绝，都会先

1. 把现场写进 **`~/.ai/crash.log`**（含错误堆栈、运行环境、终端尺寸，以及**最近 60 次按键序列**——排查「是哪种输入触发的」最关键的线索）；
2. 恢复终端（退出 raw mode、显示光标），避免崩溃后把终端搞坏；
3. 打印日志路径再退出。

> 万一又崩了，把 `~/.ai/crash.log` 里最新那段（尤其「最近 N 次按键」）发出来，就能定位是哪条输入序列触发的。

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

### 让 QQ 机器人常驻后台（macOS LaunchAgent）

`ai serve` 是前台进程，关掉终端就停了。要让它**登录即启动、崩溃自动拉起**，用 LaunchAgent。

> ⚠️ LaunchAgent 只保证「进程不死、登录自启」。`serve` 运行时会自动 `caffeinate -i` 阻止系统**空闲**休眠，但**合上笔记本盖子的强制休眠不受约束**（除非接电源 + 外接显示器）。想真正 7×24 常驻，请保持开盖或外接电源+显示器。

新建 `~/Library/LaunchAgents/com.<你的名字>.ai-qq.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>            <string>com.lteu.ai-qq</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>  <!-- which node -->
        <string>/opt/homebrew/bin/ai</string>     <!-- which ai -->
        <string>serve</string>
    </array>
    <key>RunAtLoad</key>        <true/>           <!-- 登录即启动 -->
    <key>KeepAlive</key>        <true/>           <!-- 崩溃/退出自动拉起 -->
    <key>ThrottleInterval</key> <integer>15</integer> <!-- 防止配置错误时疯狂重启 -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key> <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StandardOutPath</key> <string>/Users/你/Library/Logs/ai-qq.out.log</string>
    <key>StandardErrorPath</key> <string>/Users/你/Library/Logs/ai-qq.err.log</string>
</dict>
</plist>
```

> 路径按 `which node` / `which ai` 的实际结果填。Intel 机型 homebrew 通常在 `/usr/local/bin`。
> 环境变量（`DEEPSEEK_API_KEY`、`AI_QQ_APPID` 等）如果没写进 `~/.zshrc`，需要加到 `EnvironmentVariables` 字典里。

加载并启动：

```bash
plutil -lint ~/Library/LaunchAgents/com.lteu.ai-qq.plist        # 校验格式
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lteu.ai-qq.plist
launchctl enable    gui/$(id -u)/com.lteu.ai-qq
launchctl kickstart -p gui/$(id -u)/com.lteu.ai-qq              # 立即跑一次
```

常用管理命令：

```bash
# 查看状态 / PID / 最近一次退出码
launchctl print gui/$(id -u)/com.lteu.ai-qq | grep -E 'state|pid|last exit'
# 看日志
tail -f ~/Library/Logs/ai-qq.out.log
# 重启（改了配置、白名单或代码后）
launchctl kickstart -k gui/$(id -u)/com.lteu.ai-qq
# 停止 / 卸载
launchctl bootout gui/$(id -u)/com.lteu.ai-qq
```

> 注意：LaunchAgent 只在**你登录后**运行（登录界面/注销时不跑）；机器睡眠时 WebSocket 也会断开，唤醒后 `KeepAlive` 会自动重新连接。

## 通过微信远程操控（`ai wx`）

让 `ai` 接入你自己的**个人微信**：在微信里给绑定账号发消息，就能远程让它在你这台机器上建文件、读写、跑命令。
走的是微信官方 **ilink 机器人协议**（`ilinkai.weixin.qq.com`，域名在 `weixin.qq.com` 官方域下，由腾讯 DNS 直接解析），
扫码绑定、长轮询收发，不是模拟个人号登录协议，不存在被判定异常登录的风险。
架构和 QQ 一样解耦——终端 / QQ / 微信共用同一个 agent 引擎（`src/agent/`），微信只是另一个「入口」。

### 1. 扫码绑定

```bash
ai wx-login
```

终端里会打印一个二维码，用微信扫一下、在手机上确认即可（无需服务器、无需内网穿透、无需注册开发者账号）。
绑定成功后凭据存在 `~/.ai/config.json`，绑定账号本人默认自动进白名单。

### 2. 启动

```bash
ai wx
```

之后直接在微信里给绑定的账号发消息即可：
- 短时间内连发的多条消息（比如粘贴/转发一段聊天记录）会自动合并成一条再交给 agent，避免逐条触发「还在处理中」；
- `/clear` 清空当前会话上下文，`/help` 看用法；
- 发「停」可中断正在执行的任务。

想让其他人也能操控，追加白名单：

```bash
ai --wx-allow <ilink_user_id>   # 未授权用户发消息会自动回显自己的 ilink_user_id，抄下来加进来即可
```

### ⚠️ 安全须知

同 QQ：`ai` 自带 `run_bash` / `write_file`，**等于把你机器的 shell 暴露给能操控 bot 的人**。
微信入口做了**强制 ilink_user_id 白名单**，未授权者只会收到「回显标识」的提示，**不触发任何 agent 动作**。

### 让微信服务常驻后台（macOS LaunchAgent）

`ai wx` 是前台进程，关掉终端就停了。要让它**登录即启动、崩溃自动拉起**，用 LaunchAgent（和 `ai serve` 一样的套路）。

> ⚠️ LaunchAgent 只保证「进程不死、登录自启」。`wx` 运行时会自动 `caffeinate -i` 阻止系统**空闲**休眠，但**合上笔记本盖子的强制休眠不受约束**（除非接电源 + 外接显示器）。想真正 7×24 常驻，请保持开盖或外接电源+显示器。

新建 `~/Library/LaunchAgents/com.<你的名字>.ai-wx.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>            <string>com.lteu.ai-wx</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>  <!-- which node -->
        <string>/opt/homebrew/bin/ai</string>     <!-- which ai -->
        <string>wx</string>
    </array>
    <key>RunAtLoad</key>        <true/>           <!-- 登录即启动 -->
    <key>KeepAlive</key>        <true/>           <!-- 崩溃/退出自动拉起 -->
    <key>ThrottleInterval</key> <integer>15</integer> <!-- 防止配置错误时疯狂重启 -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key> <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StandardOutPath</key> <string>/Users/你/Library/Logs/ai-wx.out.log</string>
    <key>StandardErrorPath</key> <string>/Users/你/Library/Logs/ai-wx.err.log</string>
</dict>
</plist>
```

> 路径按 `which node` / `which ai` 的实际结果填。Intel 机型 homebrew 通常在 `/usr/local/bin`。
> 环境变量（`AI_API_KEY` 等）如果没写进 `~/.zshrc`，需要加到 `EnvironmentVariables` 字典里。

加载并启动：

```bash
plutil -lint ~/Library/LaunchAgents/com.lteu.ai-wx.plist        # 校验格式
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lteu.ai-wx.plist
launchctl enable    gui/$(id -u)/com.lteu.ai-wx
launchctl kickstart -p gui/$(id -u)/com.lteu.ai-wx              # 立即跑一次
```

常用管理命令：

```bash
# 查看状态 / PID / 最近一次退出码
launchctl print gui/$(id -u)/com.lteu.ai-wx | grep -E 'state|pid|last exit'
# 看日志
tail -f ~/Library/Logs/ai-wx.out.log
# 重启（改了配置、白名单或代码后）
launchctl kickstart -k gui/$(id -u)/com.lteu.ai-wx
# 停止 / 卸载
launchctl bootout gui/$(id -u)/com.lteu.ai-wx
```

> 注意：LaunchAgent 只在**你登录后**运行（登录界面/注销时不跑）；机器睡眠时长轮询也会断开，唤醒后 `KeepAlive` 会自动重新连接。

## 美股 / 港股监控（`ai watch`）

按自选规则轮询 Yahoo 行情，触发条件时**发邮件 + 终端打印**告警。

```bash
ai watch add 3690.HK chg=5 email=lteu@icloud.com   # 单日涨跌幅 ±5% 时告警，发给指定邮箱
ai watch add AAPL above=300 below=250 chg=5         # 价格突破/跌破/涨跌幅，任一命中即告警
ai watch list                                       # 查看当前规则
ai watch rm AAPL                                     # 删除一条规则
ai watch                                             # 前台启动守护进程（持续轮询）
```

规则字段：`above=N`（价格 ≥ N）、`below=N`（价格 ≤ N）、`chg=P`（**当日**涨跌幅绝对值 ≥ P%）、`email=addr`（本规则专属收件人，不设则用全局）。

> ⚠️ `chg` 比较的是**当日相对昨收**的涨跌幅，不是多日累计涨幅。若标的连续几天慢涨、但每天都不到阈值，则不会告警。

先配好发件邮箱（SMTP）和全局收件人：

```bash
ai --set-smtp                         # 配置 SMTP 发件邮箱（Gmail/iCloud/QQ 需用「应用专用密码」）
ai --set-stocks-notify email,terminal # 告警渠道，默认 email+terminal
```

可选环境变量：`AI_STOCK_POLL`（轮询秒数，默认 60）、`AI_STOCK_EMAIL`（全局收件人）。

### 让监控常驻后台（macOS LaunchAgent）

`ai watch` 是前台进程，关掉终端就停了。要让它**登录即启动、崩溃自动拉起**，用 LaunchAgent。

新建 `~/Library/LaunchAgents/com.<你的名字>.ai-watch.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>            <string>com.lteu.ai-watch</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>  <!-- which node -->
        <string>/opt/homebrew/bin/ai</string>     <!-- which ai -->
        <string>watch</string>
    </array>
    <key>RunAtLoad</key>        <true/>           <!-- 登录即启动 -->
    <key>KeepAlive</key>        <true/>           <!-- 崩溃/退出自动拉起 -->
    <key>ThrottleInterval</key> <integer>30</integer> <!-- 防止配置错误时疯狂重启 -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key> <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StandardOutPath</key> <string>/Users/你/Library/Logs/ai-watch.out.log</string>
    <key>StandardErrorPath</key> <string>/Users/你/Library/Logs/ai-watch.err.log</string>
</dict>
</plist>
```

> 路径按 `which node` / `which ai` 的实际结果填。Intel 机型 homebrew 通常在 `/usr/local/bin`。

加载并启动：

```bash
plutil -lint ~/Library/LaunchAgents/com.lteu.ai-watch.plist        # 校验格式
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lteu.ai-watch.plist
launchctl enable    gui/$(id -u)/com.lteu.ai-watch
launchctl kickstart -p gui/$(id -u)/com.lteu.ai-watch              # 立即跑一次
```

常用管理命令：

```bash
# 查看状态 / PID
launchctl print gui/$(id -u)/com.lteu.ai-watch | grep -E 'state|pid'
# 看日志
tail -f ~/Library/Logs/ai-watch.out.log
# 改了代码（npm run build）或改了规则后，重启生效（规则在启动时读取）
launchctl kickstart -k gui/$(id -u)/com.lteu.ai-watch
# 停止 / 卸载
launchctl bootout gui/$(id -u)/com.lteu.ai-watch
```

> 注意：LaunchAgent 只在**你登录后**运行（登录界面/注销时不跑）；机器睡眠时轮询也会暂停。

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
  cli.tsx           入口：解析命令行参数（--set-*、ask、email、stock、watch...）+ 终端界面（消费 agent 引擎的事件流）；也分发 serve/wechat/wx/watch
  agent/
    engine.ts       共享 agent 引擎：模型↔工具反复调用（流式 + 并发工具执行），产出文字/工具事件流
    session.ts      多会话存储（QQ/微信多人/多群各持一份历史）+ system prompt 构建
    compact.ts       上下文压缩：会话过长时自动摘要旧消息，防止无限膨胀
    chatlog.ts        对话日志落盘（各 channel 共用）
  channels/
    qq.ts           QQ channel：对接 QQ 官方机器人 v2 API（鉴权/网关 WS/收发），openid 白名单
    wechat.ts       企业微信 channel：回调服务对接（配合 cloudflared 隧道）
    wx.ts           个人微信 channel：ilink 机器人协议（扫码绑定、长轮询收发），白名单
    watch.ts        美股/港股监控守护：轮询行情、边沿触发、每日去重、邮件/终端告警
    stopwords.ts    channel 文本处理用的停用词表
  stocks.ts         Yahoo 行情客户端：取价、计算当日涨跌幅、交易所时区
  smtp.ts           零依赖 SMTP 客户端（node:net/tls 手写，支持 465 隐式 TLS / 587 STARTTLS）
  tools.ts          本地工具：write_file / read_file / list_dir / run_bash / skill / send_image 等
  skills.ts         技能管理：扫描 ~/.ai/skills 与 项目 .ai/skills，渐进式披露给模型，按需取正文
  MultilineInput.tsx 可编辑的多行输入框（光标、删除、快捷键）；状态用 ref 承载，避免快速输入丢字符
  llm.ts            OpenAI 兼容客户端：流式聊天 + 带工具的非流式补全（DeepSeek/通义千问/OpenRouter 等通用）
  doubao.ts         豆包（火山引擎）语音合成客户端：按文本语种自动选音色
  tts.ts            语音合成统一入口：优先豆包 TTS，未配则退回本机 say
  term.ts           终端相关工具函数
  keepawake.ts      常驻进程（serve/wx/watch）自动 caffeinate -i，阻止系统空闲休眠
  config.ts         API key / 模型 / QQ / 微信 / SMTP / 豆包 TTS / 监控规则的读取与保存
  crashlog.ts       崩溃兜底：未捕获异常时落盘 ~/.ai/crash.log（含最近按键序列）并恢复终端
scripts/
  build-app.sh      组装内置 Node 的 Ai.app（被下面两个共用）
  make-pkg.sh       生成 .pkg 安装包（装好自动带 ai 命令）
  make-dmg.sh       生成 .dmg 磁盘镜像
```
