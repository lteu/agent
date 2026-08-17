# `ai-cc` 使用指南

`ai-cc` 在隔离的 Docker 容器中运行 Anthropic 官方 Claude Code，并通过 SSH
远端主机转发全部 HTTP/HTTPS 流量。它适合希望保留 Claude Code 的交互体验，
同时隔离宿主机凭据、限制工作区范围并固定网络出口的场景。

## 主要功能

- 在临时 Docker 容器中运行官方 Claude Code；退出后自动清理容器和内部网络。
- 当前目录作为可写主工作区挂载，Claude Code 对其中文件的修改会直接反映到宿主机。
- 容器 HOME 持久化到宿主机的 `~/.ai-cc`，保留登录凭据、设置、会话和用户安装的
  Python 包。
- Claude 容器没有直接公网路由；HTTP/HTTPS 经独立代理容器和 SSH SOCKS 隧道从
  `remote` 主机出网。
- Claude 容器看不到宿主机的 `~/.ssh` 或 SSH Agent。只有不挂载工作区的代理容器
  能以只读方式读取 `~/.ssh`，并可使用宿主机 SSH Agent。
- 支持附加可写或只读挂载，并将参数原样传给 Claude Code。
- 使用只读容器根文件系统、非 root 用户、移除 Linux capabilities、禁止提权并限制
  进程数；临时目录使用独立 tmpfs。
- 保留宿主终端的颜色相关设置，并关闭 Claude Code 的非必要流量、遥测、错误报告、
  `/bug` 和自动更新。
- 镜像预装 Git、curl、OpenSSH、ripgrep、`jq`、`file`、`zip`/`unzip`、bzip2/xz、
  procps、DNS 诊断工具、SQLite CLI、FFmpeg、Python 3、pip、venv、IPython，以及
  NumPy、pandas、SciPy、Matplotlib、Seaborn、scikit-learn、Requests、HTTPX、
  Beautiful Soup、Pillow、OpenPyXL、XlsxWriter、pytest 等常用工具和库。
- 预装 Playwright 和 Chromium，并包含中日韩文字与彩色 Emoji 字体，可直接检查、截图
  和调整本地 HTML 页面，无需在只读运行容器中临时下载浏览器依赖。

## 前置条件

使用前需要：

1. Node.js 20 或更高版本以及 npm。
2. 正在运行的 Docker 环境。
3. 宿主机存在 `~/.ssh`，且 `ssh remote` 能以非交互方式连接。
4. SSH 远端允许动态端口转发，并能访问 Claude Code 所需的服务。

若 SSH 主机名不是 `remote`，请设置 `AI_CC_SSH_HOST`。

## 安装

在本项目根目录运行：

```bash
npm install
npm run build
npm link
```

首次运行会构建 `ai-cc:local` 镜像并要求按 Claude Code 的提示登录。后续运行会复用
镜像和 `~/.ai-cc` 中的登录状态。

## 基本用法

```bash
# 查看帮助
ai-cc --help

# 在当前目录启动交互式 Claude Code
ai-cc

# 验证容器无法直接出网，并显示 SSH 代理出口 IP
ai-cc --probe

# 把参数传给 Claude Code；使用 -- 可清楚地区分两套参数
ai-cc -- --model sonnet
```

`--probe` 的正常结果应包含：

```text
direct_egress=blocked
proxy_egress_ip=<SSH 远端的公网 IP>
browser_render=ok
timezone=Etc/UTC
home_dir=<持久化 HOME 的宿主机路径>
```

`browser_render=ok` 表示非 root 用户已成功启动镜像中的 Chromium、渲染包含中文的
HTML，并生成截图。浏览器程序位于只读镜像层的 `/opt/ms-playwright`；临时用户资料和
截图仍写入容器的 tmpfs，不会污染持久化 HOME。

## 镜像软件包清单与更新

镜像的直接依赖由以下两个排序清单维护，Dockerfile 会直接读取它们安装软件：

- [`deploy/ai-cc-apt-packages.txt`](../deploy/ai-cc-apt-packages.txt)：系统工具和字体。
- [`deploy/ai-cc-python-packages.txt`](../deploy/ai-cc-python-packages.txt)：Python 工具和库；
  Playwright 在此固定版本。

Chromium 由清单中的 Playwright 安装；其随 Debian 和 CPU 架构变化的系统依赖由
`playwright install --with-deps chromium` 解析，不在直接依赖清单中重复维护。

系统清单覆盖以下通用工作流：

- `zip`/`unzip`、`bzip2` 和 `xz-utils`：创建或解压常见归档格式。
- `jq` 和 `file`：检查 JSON、API 响应与未知文件类型。
- `procps` 和 `dnsutils`：提供 `ps`/`pgrep`/`top` 以及 `dig`/`nslookup` 等诊断命令。
- `sqlite3` 和 `ffmpeg`：直接检查 SQLite 数据库以及处理音视频文件。

更新软件包时：

1. 在相应清单中增删直接依赖，并保持一行一个、按字母排序。
2. 升级浏览器时，同时修改 Python 清单中的 `playwright==<版本>`。
3. 运行 `npm test`，然后运行 `ai-cc --probe` 完成镜像重建和完整探针。

运行容器使用非 root 用户和只读根文件系统，不应在会话中临时运行 `apt install`。
需要长期提供的系统命令必须加入 apt 清单并重建镜像；用户态 Python 包可继续安装到
持久化的 `/home/agent/.local`。

启动器会对 Dockerfile、两个清单、代理脚本和代理配置计算指纹。任何构建输入变化都会
自动重建旧镜像；`AI_CC_REBUILD=1` 仍可用于主动刷新未固定为版本号的上游软件包。

## 工作区与访问范围

`ai-cc` 将启动时的当前目录作为唯一的主工作区挂载。HOME 下的目录会保留相对层级：

```text
宿主机：/Users/alice/progetto/work-member-sql/culumative
容器内：/workspace/progetto/work-member-sql/culumative
```

容器路径中的父目录层级只是为了生成稳定的项目路径，并不代表对应的宿主机父目录
已经挂载。因此，上例中的 Claude Code 无法通过
`/workspace/progetto/work-member-sql` 读取宿主机上的其他同级目录。

若要让 Claude Code 访问整个父项目，应从父目录启动：

```bash
cd /Users/alice/progetto/work-member-sql
ai-cc
```

HOME 之外的当前目录会映射到稳定且不暴露宿主路径的地址：

```text
/workspace/_external/<目录名>-<哈希>
```

工作区是可写 bind mount。容器中的创建、修改和删除操作会立即影响宿主机文件，使用
Claude Code 执行修改前仍应检查目标路径和版本控制状态。

## 默认和附加挂载

以下宿主目录如果存在，会默认以可写方式挂载：

| 宿主机目录 | 容器内目录 |
|---|---|
| `~/Desktop` | `/mnt/Desktop` |
| `~/Downloads` | `/mnt/Downloads` |
| `~/Documents` | `/mnt/Documents` |
| `~/Sites` | `/mnt/Sites` |

这些默认挂载是主工作区边界之外的额外入口。例如项目位于 `~/Documents` 时，
Claude Code 也可能通过 `/mnt/Documents` 访问该目录中的其他内容。

使用 `--mount` 添加可写挂载，使用 `--mount-ro` 添加只读挂载；两者都可重复：

```bash
ai-cc \
  --mount-ro /path/to/reference-data \
  --mount /path/to/output \
  -- --model sonnet
```

附加挂载按参数顺序映射为：

```text
/mnt/1-reference-data
/mnt/2-output
```

路径必须在启动前存在。若只需读取资料，优先使用 `--mount-ro`。

## 命令行选项

| 选项 | 作用 |
|---|---|
| `-h`, `--help` | 显示帮助 |
| `--probe` | 检查直接网络阻断、代理出口、浏览器渲染、时区和持久化 HOME |
| `--mount <路径>` | 添加可写文件或目录挂载，可重复 |
| `--mount-ro <路径>` | 添加只读文件或目录挂载，可重复 |
| `-- <参数...>` | 将后续参数原样传给 Claude Code |

不属于 `ai-cc` 的其他参数也会传给 Claude Code，但建议始终使用 `--` 分隔，以避免
未来的选项名称冲突。

## 环境变量

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `AI_CC_SSH_HOST` | `remote` | SSH 主机名或 `~/.ssh/config` 别名 |
| `AI_CC_IMAGE` | `ai-cc:local` | 使用或构建的 Docker 镜像名 |
| `AI_CC_HOME_DIR` | `~/.ai-cc` | 持久化容器 HOME 的宿主机目录 |
| `AI_CC_REBUILD=1` | 未设置 | 即使镜像已存在也强制重新构建 |

示例：

```bash
AI_CC_SSH_HOST=my-server ai-cc --probe
AI_CC_HOME_DIR=/path/to/private-state ai-cc
AI_CC_REBUILD=1 ai-cc --probe
```

## 数据与安全边界

- `~/.ai-cc` 包含 Claude Code 登录凭据和会话，应像其他认证资料一样妥善保护和备份。
- 工作区、默认挂载和附加挂载中的内容可被 Claude Code 读取；可写挂载也可被修改。
- 网络隔离避免 Claude 容器直接使用宿主机公网出口，但通过代理访问的服务仍能看到
  SSH 远端的公网 IP。
- 隔离不会匿名化 Claude 账号。登录账号、订阅、付款资料、使用模式和主动提交的内容
  仍可能关联身份。
- 不应使用本工具规避 Anthropic 的地区限制、服务条款或账号措施。

## 常见问题

### 看不到父目录或同级项目

这是预期行为：主工作区只挂载启动 `ai-cc` 时的当前目录。请退出后从共同父目录重新
启动，或者用 `--mount-ro`/`--mount` 显式添加所需目录。

### 提示找不到 SSH 配置目录

确认宿主机存在 `~/.ssh`。如果使用自定义状态或密钥位置，仍需通过标准 SSH 配置让
指定主机可由 `ssh <主机名>` 连接。

### 代理出口未就绪

先在宿主机验证 `ssh remote`，或验证 `AI_CC_SSH_HOST` 指定的主机。检查 SSH 密钥、
SSH Agent、远端网络以及远端是否允许 TCP 转发，然后再次运行 `ai-cc --probe`。

### 主动刷新镜像中的软件包

运行：

```bash
npm run build
AI_CC_REBUILD=1 ai-cc --probe
```

构建文件或软件包清单改变时会自动重建；上述命令用于没有文件变化但仍希望刷新
`latest` 或未固定版本软件包的情况。重建不会删除 `~/.ai-cc` 中的登录状态和其他
持久化数据。
