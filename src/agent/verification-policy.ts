export type VerificationRequirement = 'none' | 'local' | 'standard' | 'strict'

export type VerificationCheckKind = 'test' | 'typecheck' | 'lint' | 'build' | 'syntax'

export type VerificationCheckEvidence = {
  batch: number
  order: number
  kind: VerificationCheckKind
  ok: boolean
}

const DOC_OR_DATA_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.rst',
  '.adoc',
  '.csv',
])

const CODE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx',
  '.kt', '.kts', '.php', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.swift', '.ts', '.tsx',
  '.vue', '.yaml', '.yml',
])

const STRICT_PATH_RE =
  /(^|\/)(auth|authorization|billing|database|db|deploy|deployment|infra|migration|migrations|payment|permissions?|schema|security)(\/|$)|(^|\/)(dockerfile|compose\.ya?ml)$|(^|\/)\.github\/workflows\//i

function extension(path: string): string {
  const basename = path.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = basename.lastIndexOf('.')
  return dot >= 0 ? basename.slice(dot).toLowerCase() : ''
}

export function classifyVerificationCommand(command: string): VerificationCheckKind | null {
  const normalized = command.replace(/\\\s*\n/g, ' ').replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  const usesEsbuildApi =
    /require\s*\(\s*['"]esbuild['"]\s*\)|(?:import|from)\b[^;]*['"]esbuild['"]/i.test(normalized)
  const invokesEsbuildBuild =
    /(?:\.\s*)?build(?:Sync)?\s*\(/i.test(normalized)
  const invokesEsbuildTransform =
    /(?:\.\s*)?transform(?:Sync)?\s*\(/i.test(normalized)
  const invokesEsbuildCli =
    /(?:^|[;&|]\s*)(?:['"]?[^\s'"]*\/)?esbuild['"]?\s+(?!--version(?:\s|$))/i.test(normalized)

  if (
    /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|test:[\w:-]+)(?:\s|$)/i.test(normalized) ||
    /(?:^|[;&|]\s*)(?:pytest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)(?:\s|$)/i.test(normalized) ||
    /(?:^|[;&|]\s*)(?:node|tsx)\s+--test(?:\s|$)/i.test(normalized) ||
    /(?:^|[;&|]\s*)(?:(?:npx|bunx)\s+)?(?:jest|vitest)(?:\s|$)/i.test(normalized) ||
    /(?:^|[;&|]\s*)make\s+test(?:\s|$)/i.test(normalized) ||
    /(?:^|[;&|]\s*)python(?:3)?\s+-m\s+(?:pytest|unittest)(?:\s|$)/i.test(normalized)
  ) return 'test'

  if (
    /(?:^|[;&|]\s*)(?:(?:npx|bunx)\s+)?(?:tsc|mypy|pyright)(?:\s|$)/i.test(normalized) ||
    /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|check:types)(?:\s|$)/i.test(normalized)
  ) return 'typecheck'

  if (
    /(?:^|[;&|]\s*)(?:(?:npx|bunx)\s+)?(?:eslint|ruff|biome|golangci-lint|shellcheck)(?:\s|$)/i.test(normalized) ||
    /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint(?:\s|$)/i.test(normalized)
  ) return 'lint'

  if (
    /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?:\s|$)/i.test(normalized) ||
    /(?:^|[;&|]\s*)(?:cargo\s+build|go\s+build|mvn\s+package|gradle\s+build)(?:\s|$)/i.test(normalized) ||
    (usesEsbuildApi && invokesEsbuildBuild) ||
    invokesEsbuildCli
  ) return 'build'

  if (
    /(?:^|[;&|]\s*)node\s+--check(?:\s|$)/i.test(normalized) ||
    /(?:^|[;&|]\s*)python(?:3)?\s+-m\s+py_compile(?:\s|$)/i.test(normalized) ||
    /(?:^|[;&|]\s*)(?:bash|sh)\s+-n(?:\s|$)/i.test(normalized) ||
    (usesEsbuildApi && invokesEsbuildTransform)
  ) return 'syntax'

  return null
}

export function verificationRequirementForFiles(paths: Iterable<string>): VerificationRequirement {
  const files = [...new Set([...paths].map(path => path.replace(/\\/g, '/')))]
  if (files.length === 0) return 'none'
  if (files.every(path => DOC_OR_DATA_EXTENSIONS.has(extension(path)))) return 'local'
  if (files.length >= 3 || files.some(path => STRICT_PATH_RE.test(path))) return 'strict'
  if (files.some(path => CODE_EXTENSIONS.has(extension(path)))) return 'standard'
  return 'local'
}

export function evaluateVerificationEvidence(
  checks: readonly VerificationCheckEvidence[],
  lastMutationBatch: number,
): { hasSuccessfulEvidence: boolean; unresolvedFailures: number } {
  // 同批工具会并发执行，因此只有后续批次的检查才能证明最后一次修改后的状态。
  const relevant = checks.filter(check => check.batch > lastMutationBatch)
  const latestByKind = new Map<VerificationCheckKind, VerificationCheckEvidence>()
  for (const check of relevant) {
    const previous = latestByKind.get(check.kind)
    if (!previous || check.order > previous.order) latestByKind.set(check.kind, check)
  }
  return {
    hasSuccessfulEvidence: relevant.some(check => check.ok),
    unresolvedFailures: [...latestByKind.values()].filter(check => !check.ok).length,
  }
}

export function verificationNudge(
  requirement: VerificationRequirement,
  failedChecks: number,
): string {
  const failure = failedChecks > 0
    ? `最后一次修改后还有 ${failedChecks} 项验证失败。请先定位并修复；若确认与本次修改无关，也要在最终回复中如实说明。`
    : '最后一次修改后还没有成功的验证证据。'
  const scope = requirement === 'strict'
    ? '这是多文件或高风险修改，请运行最相关的测试，并补充类型检查、构建或接口验证中适用的项目。'
    : '请根据项目配置运行最相关的定向测试、类型检查、构建或语法检查；不要为了凑验证而运行无关命令。'
  return `【验证提示】${failure}${scope}`
}
