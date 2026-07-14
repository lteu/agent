# AI agent lab
Comparison of claudecode and openclaw.

## `ai/` — 终端 DeepSeek 对话框

终端里输入 `ai` 弹出可编辑对话框，接入 DeepSeek。详见 [`ai/README.md`](ai/README.md)。

### 生成可分发的 macOS 安装包

```bash
cd ai
npm install
ARCH=universal npm run pkg     # 推荐：双击即装好，自动带 ai 命令（Apple Silicon + Intel 通吃）
```

产物在 `ai/dist/ai-<version>-universal.pkg`，**内置官方 Node 运行时**，收到的人无需装任何环境。
双击安装后**新开终端直接输入 `ai`** 即可。其它目标：

```bash
npm run pkg                     # 仅 Apple Silicon
ARCH=x64 npm run pkg            # 仅 Intel
npm run dmg                     # 改出 .dmg 磁盘镜像（拖拽安装，ai 命令需多点一下）
```

打包细节、安装与首次填 key 的说明见 [`ai/README.md`](ai/README.md#打包分发macos)。
