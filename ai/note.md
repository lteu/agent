## process to make Agent intelligent

1. 要让它能干活，得加一层 工具调用循环（agent loop）：给模型声明若干本地工具 → 模型返回 tool_calls → 你在本地执行 →
  把结果回传 → 再问模型，直到它给出最终答复。DeepSeek 是 OpenAI 兼容的，支持 tools/tool_calls。 我来实现。三步：新增 tools.ts，给 deepseek.ts 加带工具的非流式补全，再把 cli.tsx 改成 agent 循环。

agent loop

Q：你刚刚写的agent loop都能解决什么问题？据点例子啊                                                                      

⏺ 核心区别：以前模型只能说，现在它能说一句→动一下→看结果→再决定。这个循环解锁的是"需要多步、要看现状、要验证"的任务。按
  你 AGENT-LEVELS.md 的分级举具体例子：

  L0 单步动手（以前直接做不到）

  - 「建个空文档 notes.md」→ 调 write_file，文件真的出现。
  - 「新建文件夹 tmp/」→ 调 run_bash 跑 mkdir。
  - 「把这段配置存成 config.json」→ write_file 落盘。

  以前这些它全部回"我没权限"。

  L1 看一眼再写
  
  - 「这个项目用的什么 Node 版本？」→ read_file package.json 看完回答，而不是瞎猜。
  - 「列一下 src/ 里有哪些文件」→ list_dir，给你真实清单。

  多步串联（loop 的真正价值）

  单个工具不稀奇，关键是它能把多步自己串起来，每步看上一步结果再走下一步：

  - 「写个反转字符串的脚本并跑给我看」
  → write_file reverse.js → run_bash node reverse.js → 看到输出 → 告诉你结果。自带验证。
  - 「这个 build.sh 报错了，帮我看看」
  → run_bash bash build.sh（看真实报错）→ read_file 看相关文件 → 改 → 再跑确认。
  - 「把 src/ 下所有 .txt 改名加上日期前缀」
  → list_dir 拿到清单 → 据此拼出 mv 命令 → run_bash 执行。它得先知道有哪些文件才能动手，这正是 loop 给的。

  为什么必须是"循环"而不是"一次工具调用"

  比如「修个 bug」：模型第一次不知道 bug 在哪 → 先 run_bash 复现报错 → 根据报错 read_file 定位 → 改 →
  再跑一次确认修好了。这中间它要根据每一步的真实结果调整计划。没有 loop，它最多只能盲调一次工具就停；有了
  loop，它能像你刚才看到的 L0 测试那样：mkdir →（看到成功）→ write_file →（确认）→ 才说"做完了"。
  
  ---
  一句话总结它解决的问题：把"会聊建文件的助手"变成"真能建文件、还会自己跑起来验证的 agent"——你那张能力表从 L0 到 L4
  的题，技术通道现在都通了（L4 打包那种还得配合你已有的 make-pkg.sh）。
  
  想看的话，我可以直接拿表里某道题（比如 L2「给 CLI 加 --version」或 L3「加 /clear 命令」）用这个 ai
  实跑一遍，看它自己读代码、改、验证的全过程。


  Q:
  where has claude code specified its agent loop ?                                                                      

  A:
  ⏺ Bash(cd /Users/lteu/progetto/agent/claudecode && ls -la | head -60)
  ⎿  total 2408
     drwxrwxr-x@  59 lteu  staff    1888 Jun 16 23:47 .
     drwxrwxr-x@  12 lteu  staff     384 Jun 16 17:12 ..
     … +57 lines (ctrl+o to expand)

⏺ This claudecode/ is a de-obfuscated copy of Claude Code's source. Its agent loop lives in the query layer. Let me find
  the exact function:

  Searched for 1 pattern, read 1 file (ctrl+o to expand)
  ⎿  Loaded CLAUDE.md

⏺ Let me find where it runs the tools and loops back:

⏺ Bash(grep -nE "stop_reason|runTool|executeTool|toolResult|yield\* run|state = \{|continue$|return \{|new
      Terminal|Terminal\b" query.ts | sed -n '1,50p')
  ⎿  98:import { runTools } from './services/tools/toolOrchestration.js'
     99:import { applyToolResultBudget } from './utils/toolResultStorage.js'
     104:import type { Terminal, Continue } from './query/transitions.js'
     … +46 lines (ctrl+o to expand)

  Read 1 file (ctrl+o to expand)

⏺ Found it. In this de-obfuscated claudecode/ tree, the agent loop is not a tidy little function — it's a single big
  async generator called queryLoop. Here's the map:

  The loop itself

  - query.ts:219 — query() — public entry point. Just wraps queryLoop and does cleanup (query.ts:230).
  - query.ts:241 — queryLoop() — the actual agent loop. The heart is while (true) at query.ts:307.

  Each iteration does the same three things my for loop does:

  1. Call the model (streams the assistant turn), collecting its tool_use blocks.
  2. If the model asked for no tools → stop. That's return { reason: 'completed' } at query.ts:1357 — equivalent to my
  if (!toolCalls.length) break.
  3. Otherwise run the tools, then loop back with the results appended.

  Tool execution + the "loop back"

  - Tools run via runTools(...) at query.ts:1382, imported from services/tools/toolOrchestration.js (query.ts:98). It's
  an async generator — results stream in and get pushed into toolResults (query.ts:1395).
  - The continuation is at query.ts:1714-1727: it rebuilds the message list as
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults]   // query.ts:1716
  - assigns state = next, and falls off the bottom of the while back to the top. That's exactly my
  history.push(toolResult); continue.

  Note the checkpoint name at query.ts:1714 — 'query_recursive_call'. Historically this was a literal recursive
  generator (yield* query(...)); they since flattened it into an explicit while(true) + state reassignment to avoid
  blowing the stack on long turns. Same shape, different control flow.
  
  Side-by-side with what I wrote

  ┌───────────────────────────────────────┬───────────────────────────────────────────────────────────────────┐
  │           My ai/src/cli.tsx           │                       Claude Code query.ts                        │
  ├───────────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ for (let step = 0; step < 25; step++) │ while (true) (:307) + maxTurns guard (:1705)                      │
  ├───────────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ chatComplete(history, {tools})        │ streaming model call inside the loop                              │
  ├───────────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ if (!toolCalls.length) break          │ return { reason: 'completed' } (:1357)                            │
  ├───────────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ runTool(name, args)                   │ runTools(...) → toolOrchestration.js (:1382)                      │
  ├───────────────────────────────────────┼───────────────────────────────────────────────────────────────────┤
  │ history.push(tool result) then loop   │ state.messages = [...assistant, ...toolResults] (:1716) then loop │
  └───────────────────────────────────────┴───────────────────────────────────────────────────────────────────┘

  So conceptually mine is the same loop. The 1500 lines around it are the production concerns I skipped: context
  compaction (the autoCompact/microcompact logic), token budgets, stop-hooks, max-turns, abort handling, fallback
  models, streaming tool execution, and per-turn telemetry.
  
  Want me to walk through any one of those — e.g. how toolOrchestration.runTools decides permissions and runs tools in
  parallel (that's the piece my single-threaded for (const tc of toolCalls) skips)?


  =====
  ## 接入IM

  我想为项目 ai 加入 qq 可以原创对话，操控agent的功能。可以参考                 
  openclaw-2026.3.23，有什么实现想法吗？                                        
  
⏺ 先看一下你的项目结构，了解现有 agent 的实现方式，再给你具体的实现思路。

⏺ Bash(ls -la && echo "---" && git log --oneline -5)
  ⎿  total 128
     -rw-r--r--@  1 lteu  staff  32839 Jun 12 11:05 对比-模糊性处理-claudec
     ode-vs-openclaw.html
     … +17 lines (ctrl+o to expand)

  Searched for 1 pattern (ctrl+o to expand)

⏺ Let me look at the ai project structure since that's the target, and
  understand how openclaw handles channels (it seems to have a "channels"
  concept).

⏺ Bash(cd /Users/lteu/progetto/agent/ai && find . -type f -not -path
      './node_modules/*' -not -path './.git/*' | head -80 && echo "===
      package.json ===" && cat package.…)
  ⎿  ./.DS_Store
     ./note.md
     ./README.md
     … +105 lines (ctrl+o to expand)

  Read 2 files (ctrl+o to expand)

⏺ Now let me look at the core source of ai and how openclaw structures its
  "channels" (it references QQ-style integrations).

  Read 3 files (ctrl+o to expand)

⏺ Let me peek at how openclaw structures its "channels" (the multi-platform
  messaging concept the user wants to mirror).

⏺ Bash(cd /Users/lteu/progetto/agent/openclaw-2026.3.23 && ls src 2>/dev/null;
      echo "--- channel dirs ---"; find . -type d -path '*channel*' -not -path
      '*/node_modules…)
  ⎿  acp
     agents
     auto-reply
     … +95 lines (ctrl+o to expand)

  Listed 1 directory (ctrl+o to expand)

⏺ 我把你的 ai 项目和 openclaw 都看过了，给你一套可落地的思路。
     
  现状判断
  
  你的 ai 现在是单进程、UI 和 agent 
  循环绑死的结构：核心的「模型↔工具反复调用」循环写在 cli.tsx 的 send()
  里（104–144 行），它直接 setMessages 更新 Ink 界面。而真正可复用的是三块：
  
  - deepseek.ts — 模型客户端（纯函数，无 UI 依赖）✅
  - tools.ts — 本地工具（纯函数）✅
  - agent 循环 — 目前被困在 React 组件里，这是要接 QQ 必须先解开的结。

  openclaw 给的关键启发

  openclaw 没有 QQ，但它的 src/channels/ 架构正是你要的模式：core 与 channel 
  解耦。它把每个平台（imessage / signal / slack / whatsapp / discord，见
  src/channels/plugins/）抽象成一个 channel plugin，每个插件只做两件事：
  
  - inbound（归一化）：把平台消息转成统一的内部消息格式
  - outbound（动作）：把 agent 的回复/动作发回平台

  agent 核心完全不知道消息来自终端还是
  QQ。这就是你该照搬的核心思路：把终端当成"第一个 channel"，QQ 当成"第二个
  channel"，二者共用同一个 agent 引擎。
  
  QQ 接入的技术选型
  src/channels/plugins/）抽象成一个 channel plugin，每个插件只做两件事：

  - inbound（归一化）：把平台消息转成统一的内部消息格式
  - outbound（动作）：把 agent 的回复/动作发回平台

  agent 核心完全不知道消息来自终端还是 QQ。这就是你该照搬的核心思路：把终端当成"第一个 channel"，QQ 当成"第二个 channel"，二者共用同一个 agent 引擎。

  QQ 接入的技术选型

  QQ 没有官方机器人 API（个人号），2026 年主流方案是 OneBot 11 协议，用一个本地 QQ 客户端实现去对接：

  - NapCat（推荐，基于 NTQQ，活跃、稳定，正向 WebSocket）
  - Lagrange.OneBot（纯协议实现，无需装 QQ）
  - ~~go-cqhttp~~（已停更，不建议新接）

  它们会把 QQ 暴露成一个 WebSocket：你的 ai 连上去 → 收到群/私聊消息事件 → 跑 agent → 通过 API 把回复发回 QQ。你的代码不直接碰 QQ 协议，只对接 OneBot WebSocket。

  建议的改造步骤

  src/
    agent/
      engine.ts      ← 从 cli.tsx 抽出的纯 agent 循环（输入消息→产出事件流）
      session.ts     ← 多会话管理：每个 QQ 用户/群一份独立 history
    channels/
      channel.ts     ← 统一接口 { onMessage, send }
      terminal.tsx   ← 现在的 Ink 界面，改成调 engine
      qq.ts          ← 连 OneBot WebSocket，收发消息
    cli.tsx          ← 入口：ai (终端) / ai serve --qq (起 QQ bot)

  1. 抽 engine：把 send() 里的 for 循环改成一个 async function* runAgent(history, deps)，yield 出 {type:'text'|'tool'} 事件。终端和 QQ 都消费这个事件流。
  2. 会话隔离：QQ 是多人多群，historyRef 那种单例 history 不够用，要按 用户ID/群ID 分桶（参考 openclaw src/sessions/）。
  3. QQ channel：用 ws 连 NapCat，监听 message 事件，调 engine，把文字结果用 send_private_msg/send_group_msg 发回。
  4. 入口分流：ai 进终端；ai serve 起 QQ 守护进程。

  ⚠️  最重要的一个决策：安全

  你的工具里有 run_bash 和 write_file——一旦接到 QQ，任何能给这个 bot 发消息的人，都能在你的机器上任意执行命令、读写文件。这是开你电脑的后门。所以接 QQ
  前必须先定权限模型。这点会直接改变实现，我需要你拍板：

  ===

  接入情况
  做了什么

  按你定的「白名单 + 全工具、完整可跑」，照搬 openclaw 的 channel 解耦思路重构了 ai：

  ① 抽出共享 agent 引擎 — 把原先困在 cli.tsx React 组件里的「模型↔工具循环」抽成纯异步生成器 src/agent/engine.ts，产出 {type:'text'|'tool'} 事件流。终端和 QQ
  都消费同一个引擎，不再各写一份。

  ② 多会话存储 src/agent/session.ts — QQ 是多人/多群，私聊按用户、群聊按群各持一份独立历史，带上限修剪（不会把 tool 调用配对切断）。

  ③ QQ channel src/channels/qq.ts — 通过 OneBot v11 正向 WebSocket（推荐 NapCat）接 QQ，零新依赖（用 Node v24 自带的全局 WebSocket）。含：强制白名单、群里需 @、/clear
  /help 命令、同会话防并发、断线指数退避重连。

  ④ 配置与入口 — config.ts 加了 QQ 配置（OneBot 地址/token/白名单，写入仅自己可读的 ~/.ai/config.json），新增 ai --set-qq-url / --set-qq-token / --qq-allow 和 ai 
  serve。

  验证

  - 构建通过，终端模式无回归。
  - 用 mock OneBot 服务器跑了端到端：非白名单消息被静默丢弃、白名单消息正确回发 send_private_msg、连接/echo/重连链路全通。

  你接下来要做的

  1. 装 NapCat，开启正向 WebSocket（如 3001 端口）；
  2. ai --set-qq-url ws://127.0.0.1:3001 → ai --qq-allow 你的QQ号 → ai serve；
  3. 在 QQ 私聊里发消息即可远程操控。

  ⚠️  一点提醒：run_bash 全开 = 等于把 shell 暴露给能给 bot 发消息的人，所以只加你自己的号、管好 NapCat 和 access_token，别把这个 bot 拉进陌生群。这点我也写进 README
  的「安全须知」了。
