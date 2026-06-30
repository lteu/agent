// 技能（skill）管理：把「一段可复用的操作手册」存成带 frontmatter 的 markdown，
// 让模型按需取用——对标 Claude Code 的 skill「渐进式披露」(progressive disclosure)：
//   · 启动时只把每个技能的「名字 + 一句话描述」放进系统提示（省 token）；
//   · 模型判断某个技能与当下需求相关时，再用 skill 工具把完整正文拉进上下文，照做。
//
// 技能来源（靠后的覆盖靠前的同名技能）：
//   1. ~/.ai/skills/        —— 用户全局技能（所有项目通用）
//   2. <cwd>/.ai/skills/    —— 项目本地技能（随仓库走，团队共享）
// 每个技能可以是：
//   · 目录式：<dir>/<name>/SKILL.md（推荐，正文可引用同目录下的脚本/资源）
//   · 单文件：<dir>/<name>.md
// SKILL.md 形如：
//   ---
//   name: release-notes
//   description: 根据 git 提交生成发布说明
//   ---
//   <正文：给模型看的操作步骤>

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type SkillSource = 'user' | 'project'

export type SkillMeta = {
  name: string
  description: string
  /** SKILL.md / <name>.md 的绝对路径 */
  path: string
  source: SkillSource
}

// 技能搜索目录：靠后的覆盖靠前的同名技能（项目本地 > 用户全局）。
function skillDirs(cwd: string): { dir: string; source: SkillSource }[] {
  return [
    { dir: join(homedir(), '.ai', 'skills'), source: 'user' },
    { dir: join(cwd, '.ai', 'skills'), source: 'project' },
  ]
}

/** 解析 markdown 顶部的 YAML frontmatter（只认 `key: value` 单行，够 name/description 用）。 */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { data: {}, body: text }
  const data: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    let v = kv[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    data[kv[1]] = v
  }
  return { data, body: m[2] }
}

/** 扫一个目录下的技能（不递归子目录，目录式技能只认其顶层 SKILL.md）。 */
function collectFrom(dir: string, source: SkillSource): SkillMeta[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // 目录不存在 / 不可读：当作没有技能
  }
  const out: SkillMeta[] = []
  for (const e of entries) {
    let file: string | null = null
    let fallbackName = e.name
    if (e.isDirectory()) {
      const p = join(dir, e.name, 'SKILL.md')
      if (existsSync(p)) file = p
    } else if (e.isFile() && /\.md$/i.test(e.name) && e.name.toLowerCase() !== 'readme.md') {
      file = join(dir, e.name)
      fallbackName = e.name.replace(/\.md$/i, '')
    }
    if (!file) continue
    let data: Record<string, string> = {}
    try {
      data = parseFrontmatter(readFileSync(file, 'utf8')).data
    } catch {
      continue
    }
    const name = (data.name || fallbackName).trim()
    if (!name) continue
    out.push({ name, description: (data.description || '').trim(), path: file, source })
  }
  return out
}

/** 列出所有已安装技能（项目本地覆盖用户全局的同名技能），按名字排序。 */
export function loadSkills(cwd: string = process.cwd()): SkillMeta[] {
  const map = new Map<string, SkillMeta>()
  for (const { dir, source } of skillDirs(cwd)) {
    for (const s of collectFrom(dir, source)) map.set(s.name, s)
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 按名字读取某个技能的完整正文（去掉 frontmatter）；不存在返回 null。 */
export function readSkill(
  name: string,
  cwd: string = process.cwd(),
): { meta: SkillMeta; body: string } | null {
  const meta = loadSkills(cwd).find(s => s.name === name)
  if (!meta) return null
  return { meta, body: parseFrontmatter(readFileSync(meta.path, 'utf8')).body.trim() }
}

/**
 * 给系统提示用的技能清单（只含名字+描述，渐进式披露）。无技能时返回空串。
 */
export function skillCatalog(cwd: string = process.cwd()): string {
  const skills = loadSkills(cwd)
  if (!skills.length) return ''
  const lines = skills.map(s => `- ${s.name}：${s.description || '(无描述)'}`)
  return (
    '\n\n你还装有以下「技能」(skill，可复用的操作手册)。当用户的需求与某个技能相关时，' +
    '先用 skill 工具（参数 name）把它的完整说明读进上下文，再严格按其步骤执行；不相关就忽略：\n' +
    lines.join('\n')
  )
}

/** 新建一个用户全局技能模板，返回创建的 SKILL.md 路径。已存在则抛错。 */
export function scaffoldSkill(name: string): string {
  const safe = name.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!safe) throw new Error('技能名非法（只能含字母、数字、- 和 _）')
  const dir = join(homedir(), '.ai', 'skills', safe)
  const file = join(dir, 'SKILL.md')
  if (existsSync(file)) throw new Error(`技能已存在: ${file}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    file,
    `---\nname: ${safe}\ndescription: 一句话说明这个技能做什么、用户提出什么需求时该用它\n---\n\n` +
      `# ${safe}\n\n在这里写给模型看的操作步骤：分阶段、可执行。可以引用本目录下的脚本/资源（用相对路径）。\n`,
  )
  return file
}
