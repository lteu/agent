# ai

在终端输入 `ai`，弹出一个**可编辑的对话框**（类似 `claude`），接入 **DeepSeek**。

技术栈：Node + [Ink](https://github.com/vadimdemedes/ink)（终端里的 React），参考自 `../claudecode`。

## 安装

```bash
cd ai
npm install
npm run build      # 产出 dist/cli.js
npm link           # 让全局可用 `ai`（或见下方“免 link”）
```

> 不想 `npm link`，可加别名：`alias ai="node /Users/lteu/progetto/claude/ai/dist/cli.js"`

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

## 开发

```bash
npm run dev        # 用 tsx 直接跑源码，免编译
```

## 结构

```
src/
  cli.tsx           入口 + 界面（消息历史、流式输出、参数处理）
  MultilineInput.tsx 可编辑的多行输入框（光标、删除、快捷键）
  deepseek.ts       DeepSeek 流式 API 客户端
  config.ts         API key / 模型 的读取与保存
```
