## process to make Agent intelligent

1. 要让它能干活，得加一层 工具调用循环（agent loop）：给模型声明若干本地工具 → 模型返回 tool_calls → 你在本地执行 →
  把结果回传 → 再问模型，直到它给出最终答复。DeepSeek 是 OpenAI 兼容的，支持 tools/tool_calls。 我来实现。三步：新增 tools.ts，给 deepseek.ts 加带工具的非流式补全，再把 cli.tsx 改成 agent 循环。

