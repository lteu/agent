# AI vs. Claude Code: Agent Performance Review

> Point-in-time review archived for reference. Some findings may already be implemented
> or no longer match the current source tree.

## Executive summary

The `ai/` implementation has a solid compact core, but its biggest performance limitations are execution correctness, weak verification, and missing project context—not model quality.

The highest-priority improvements are:

1. Add runtime tool-input validation.
2. Replace unrestricted concurrent tool execution with effect-aware scheduling.
3. Add permission and risk classification before tool execution.
4. Load repository instruction files such as `AGENTS.md` and `CLAUDE.md`.
5. Replace model-only verification with deterministic completion evidence.

These changes should be implemented before adding more tools or substantially expanding the prompt.

## What is already working well

The current implementation already has several useful foundations:

- A UI-independent model/tool agent loop in `ai/src/agent/engine.ts`.
- Streaming model output and early tool-call detection.
- Abort handling for model requests and shell commands.
- OpenAI-compatible and native Anthropic API support.
- Automatic context compaction with reactive overflow recovery.
- Progressive skill disclosure.
- Multi-channel reuse of the same agent engine.
- Bounded agent steps and network retry handling.
- A successful production build with `npm run build`.

## Highest-impact findings

### 1. Tool calls can race and duplicate side effects

> Status update: the uncommitted-stream side-effect issue was fixed after this review. Tool calls are now collected during streaming and start only after the complete assistant response has been committed to history. Effect-aware serialization remains outstanding and is covered separately below.

At the time of the original review, the executor immediately launched every streamed tool call concurrently, including `write_file`, `edit_file`, `run_bash`, `send_email`, and browser actions. Calls are now deferred until the assistant response is committed, although the calls within that committed batch still run concurrently.

Relevant code:

- `ai/src/agent/engine.ts:150`
- `ai/src/agent/engine.ts:183`

This creates several failure modes:

- Two edits to the same file can overwrite each other.
- `install dependency` followed by `run tests` may execute in the wrong order.
- `write file` followed by `read file` may read the old version.
- If the model stream fails after a command starts, the request is retried without recording the side effect. The same command may then execute twice.

Claude Code explicitly classifies tool calls by concurrency safety. It runs read-only batches concurrently and serializes state-changing calls:

- `studio/claudecode/services/tools/toolOrchestration.ts:19`
- `studio/claudecode/services/tools/toolOrchestration.ts:84`

Recommended design:

```ts
type ToolEffect = 'read' | 'write' | 'external'

const TOOL_EFFECTS = {
  read_file: 'read',
  grep: 'read',
  glob: 'read',
  write_file: 'write',
  edit_file: 'write',
  run_bash: 'write',
  send_email: 'external',
} satisfies Record<string, ToolEffect>
```

Run consecutive read-only calls concurrently with a limit such as 6–10. Run writes and external actions serially, and only after the assistant response has completed successfully.

### 2. Invalid tool arguments can perform unintended operations

Malformed tool-call JSON is silently converted to an empty object:

- `ai/src/agent/engine.ts:101`

Tools then coerce missing fields into strings:

- `write_file` can resolve a missing path as a file literally named `undefined`: `ai/src/tools.ts:617`.
- `run_bash` accepts an empty command: `ai/src/tools.ts:685`.
- `edit_file` similarly coerces missing arguments: `ai/src/tools.ts:758`.

Claude Code performs schema validation and tool-specific semantic validation before execution:

- `studio/claudecode/services/tools/toolExecution.ts:614`
- `studio/claudecode/services/tools/toolExecution.ts:682`

Add runtime schemas, preferably with Zod. Invalid JSON or invalid values should return a structured tool error so the model can repair the call. A malformed call should never execute with `{}`.

### 3. The agent ignores repository instructions

The system prompt describes available tools, but the implementation does not load `CLAUDE.md`, `AGENTS.md`, `.claude/rules`, or equivalent project instructions:

- `ai/src/agent/session.ts:7`

Claude Code discovers instructions from user, project, nested-directory, and local sources:

- `studio/claudecode/utils/claudemd.ts:1`
- `studio/claudecode/utils/claudemd.ts:877`

This directly affects coding quality. The agent cannot reliably follow repository-specific test commands, architecture constraints, naming conventions, or nested-directory requirements if it never sees them.

Recommended discovery order:

1. `~/.ai/AI.md`
2. Repository-root `AGENTS.md` and `CLAUDE.md`
3. `.ai/rules/*.md`
4. Nested instruction files loaded when the agent touches files below their directory

Include the source path with every injected instruction and deduplicate files already loaded into the session.

### 4. Verification is mostly cosmetic and disabled by default

Verification defaults to off:

- `ai/src/agent/engine.ts:125`

When enabled, final verification mainly asks the same model to judge its latest response. It receives truncated tool output, and an API or parsing failure becomes an automatic pass:

- `ai/src/agent/verify.ts:121`
- `ai/src/agent/verify.ts:156`
- `ai/src/agent/verify.ts:191`

The verification rubric also says that a requested file must appear in the final answer. That can reject correct work when the agent created the file on disk and appropriately summarized the change instead of pasting it.

Prefer deterministic completion evidence:

- After an edit, reread the affected region or inspect `git diff`.
- After implementation, discover and run the relevant tests, build, lint, or type checker.
- Preserve command exit codes independently from stdout and stderr.
- Track requested deliverables in a task ledger.
- Require evidence for every deliverable before returning.
- Use model-based review only as a secondary check, preferably with a different model.

Claude Code also explicitly reinforces reading before editing, diagnosing failures, verifying work before claiming completion, and accurately reporting test results:

- `studio/claudecode/constants/prompts.ts:220`

## Other important improvements

### Permissions and external side effects

`run_bash`, file writes, email, and browser operations execute without a permission boundary:

- `ai/src/tools.ts:685`
- `ai/src/tools.ts:712`

Claude Code resolves permissions before execution and distinguishes allow, ask, and deny:

- `studio/claudecode/services/tools/toolExecution.ts:916`

Introduce three risk levels:

- Read-only: normally automatic.
- Local reversible mutation: automatic or configurable.
- Destructive or external: explicit approval required.

At minimum, gate deletion, `git push`, email, uploads, dependency removal, credential access, operations outside the working directory, and commands that affect shared systems.

### Context compaction should be model-aware

Compaction currently uses a fixed 40,000-token threshold and a rough `characters / 3` estimate:

- `ai/src/agent/compact.ts:23`
- `ai/src/agent/compact.ts:57`

The summarization input is truncated to the first 60,000 characters, potentially dropping the most recent portion of the section being summarized:

- `ai/src/agent/compact.ts:70`

Claude Code calculates thresholds from the selected model’s context window, reserves output headroom, and has a compaction failure circuit breaker:

- `studio/claudecode/services/compact/autoCompact.ts:28`
- `studio/claudecode/services/compact/autoCompact.ts:62`

Recommended improvements:

- Maintain model capability metadata.
- Count tool schemas and system prompts as well as message text.
- Reserve space for output and tool results.
- Keep structured summary sections: goal, constraints, files changed, commands run, failures, and pending work.
- Persist a checkpoint before compaction.
- Avoid silently deleting important context through `SessionStore.trim()`: `ai/src/agent/session.ts:69`.

### Retry policy misses HTTP rate limits and server failures

The retry logic recognizes socket and connection errors, but HTTP `429`, `500`, `502`, `503`, and `529` are thrown as ordinary errors and generally not retried:

- `ai/src/llm.ts:395`
- `ai/src/agent/engine.ts:199`

Claude Code has status-aware retries, `Retry-After` handling, bounded exponential backoff, authentication refresh, and fallback behavior:

- `studio/claudecode/services/api/withRetry.ts:50`
- `studio/claudecode/services/api/withRetry.ts:170`

Create a typed API error containing status, headers, provider, and request ID. Retry only appropriate statuses with exponential backoff and jitter.

### Tool results need structure

All tools currently return strings. The engine must infer failure by matching phrases such as `错误`, `failed`, or `fatal`. This is brittle and complicates verification, retry handling, telemetry, and compaction.

Recommended result type:

```ts
type ToolResult = {
  ok: boolean
  summary: string
  output?: string
  error?: string
  exitCode?: number
  truncated?: boolean
  artifacts?: string[]
  durationMs: number
}
```

Store the structured result internally and render a concise textual representation only at the API boundary.

### Tool selection is too broad

Every request receives all 31 built-in tool schemas:

- `ai/src/agent/engine.ts:89`

This increases prompt cost and can make weaker models more likely to choose an irrelevant tool. Keep core coding tools loaded, but defer browser, email, finance, document readers, terminal sessions, and channel-specific tools until they become relevant.

Claude Code uses deferred tool discovery to limit schema overhead and reduce irrelevant choices.

### The system prompt needs stronger task-execution guidance

The current system prompt mostly explains tool availability. It provides relatively little guidance about:

- Reading existing code before proposing or making changes.
- Preserving unrelated user changes.
- Diagnosing an error before switching approaches.
- Avoiding unnecessary files and speculative abstractions.
- Testing before claiming completion.
- Reporting failures honestly.
- Separating dependent and independent tool calls.

These behaviors should be encoded in modular prompt sections, with stable sections cached or reused between requests.

### Subagents need specialization and isolation

`run_agent` creates a generic child using the same model, a generic prompt, and a fixed 15-step limit. It lacks:

- Explicit read-only versus write authorization.
- Specialized exploration, implementation, and verification roles.
- Background lifecycle and status reporting.
- Per-agent budgets.
- A structured result contract.
- Protection against agents editing the same file concurrently.

Until conflict control exists, use subagents primarily for independent read-only research and context isolation.

### Session persistence and memory are limited

Interactive history is held in memory and chat logs are written for human inspection, but there is no robust session resume mechanism or persistent operational memory.

Useful additions include:

- Session checkpoints with message and tool-result state.
- Resume by session ID.
- Per-project memory for stable conventions and user preferences.
- Retrieval based on task relevance rather than injecting all memory.
- Staleness metadata for time-sensitive memories.
- Secret scanning before persisting memory.

## Recommended implementation order

### Phase 1: correctness foundation

1. Add runtime tool schemas and structured results.
2. Add effect-aware scheduling.
3. Prevent speculative execution of mutating tools.
4. Add idempotency and duplicate-call protection for external effects.
5. Add permission and risk classification.

### Phase 2: task quality

1. Load repository instruction files.
2. Add a lightweight task ledger for multi-step work.
3. Add deterministic post-edit and final verification.
4. Strengthen the task-execution system prompt.
5. Preserve and report verification evidence.

### Phase 3: reliability and efficiency

1. Add model-aware context thresholds.
2. Implement status-aware API retries.
3. Add persistent session checkpoints and resume.
4. Defer non-core tool schemas.
5. Add specialized, bounded subagents.

### Phase 4: measurement

Build a repeatable evaluation suite before further prompt tuning.

Start with 20–30 tasks covering:

- Codebase navigation.
- Single-file edits.
- Multi-file edits.
- Debugging and root-cause analysis.
- Test repair.
- Failed-command recovery.
- Long-context continuation.
- Unsafe or destructive requests.
- Dependent tool calls.
- Parallel read-only tool calls.
- Malformed tool arguments.
- Interrupted and retried model streams.

Record:

- Task success rate.
- Relevant tests passed.
- False completion claims.
- Unnecessary files or edits.
- Tool-call count.
- Invalid tool-call rate.
- Retry recovery rate.
- Latency to first token and completion.
- Input and output token usage.
- Compaction frequency and information loss.
- Permission prompts and denial recovery.

Without this harness, changes in prompting, scheduling, or verification will be difficult to distinguish from normal model variance.

## Suggested first engineering milestone

The best initial milestone is a safe, deterministic tool execution layer with the following properties:

1. Every call is parsed and validated before execution.
2. Every tool declares its effect and concurrency safety.
3. Read-only calls can run concurrently within a bounded pool.
4. Mutating and external calls execute serially after the model turn completes.
5. Risky calls pass through a permission policy.
6. Every result contains structured status, timing, truncation, and artifact metadata.
7. Retried model streams cannot silently repeat completed side effects.
8. Unit tests cover malformed input, ordering, concurrency, cancellation, and duplicate prevention.

This milestone should improve reliability more than adding memory, more tools, or a larger system prompt.

## Validation performed during this review

- Inspected the `ai/` agent engine, tools, provider client, compaction, verification, skills, session handling, and prompts.
- Compared them with Claude Code’s query execution, tool orchestration, validation, permissions, compaction, retry, instruction-loading, memory, and prompt architecture.
- Ran `npm run build` in `ai/`; it completed successfully.
- Found no automated TypeScript tests covering the `ai/` agent loop, tool validation, concurrency, compaction, or verification behavior.
- No source code was modified as part of the diagnostic review.
