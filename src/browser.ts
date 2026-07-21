// 浏览器自动化：用 Playwright 实际控制 Chromium，模型只按「快照」文本决定点哪、填什么，
// 真正的点击/填写/导航都由这里的脚本执行——脚本负责稳，模型负责判断。
//
// 设计要点：
//   · 具名会话（同 term.ts 的约定），同名不重开，避免误杀正在用的浏览器。
//   · 模型看不到画面，只能看文本：每次快照给页面上可见的可交互元素打 data-ai-ref 标记，
//     回一份「ref 角色 名字 当前值」的清单，模型据此点击/填写，而不必自己写 CSS 选择器。
//   · 会话只存在于当前进程内存里（Map），随 ai 进程退出而结束，不做跨进程持久化
//     （浏览器没有 tmux 那种轻量的跨进程复用方式，硬做反而是过度设计）。

import { chromium, type Browser, type Page } from 'playwright'

type Session = { browser: Browser; page: Page }
const sessions = new Map<string, Session>()

function displayName(name: string): string {
  return String(name || 'main').trim() || 'main'
}

const NEED_CHROMIUM = '本机未下载 Chromium（浏览器自动化依赖它）。请先运行：npx playwright install chromium'

function isMissingBrowser(e: any): boolean {
  return /Executable doesn't exist/i.test(String(e?.message ?? e))
}

function getSession(name: string): Session | undefined {
  return sessions.get(displayName(name))
}

// 供 Node 侧拼 CSS 属性选择器时用，防止 ref 里混进引号/反斜杠破坏选择器语法。
function escapeAttr(v: string): string {
  return String(v ?? '').replace(/["\\]/g, '\\$&')
}

/** 扫描当前页面上可见的可交互元素，逐个打 data-ai-ref 标记，返回给模型看的文本清单。 */
// 注意：这段扫描逻辑故意写成纯字符串交给 page.evaluate 执行，而不是传一个 TS 箭头函数。
// 原因：dev 模式下 tsx 用 esbuild 转译时会开 keepNames，给文件里每个具名函数都包一层
// __name(fn, "fn") 调用；Playwright 序列化传入的函数时会把这层包裹也带进去，
// 但 __name 这个辅助函数是在模块顶层定义的，隔离的页面上下文里访问不到，
// 执行时直接报 ReferenceError: __name is not defined。用字符串就绕开了这层转译。
const SNAPSHOT_SCRIPT = `(() => {
  document.querySelectorAll('[data-ai-ref]').forEach(function (el) { el.removeAttribute('data-ai-ref') })

  function isVisible(el) {
    var rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    var style = window.getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
  }
  function labelFor(el) {
    var aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return aria.trim()
    var id = el.getAttribute('id')
    if (id) {
      var lab = document.querySelector('label[for="' + CSS.escape(id) + '"]')
      if (lab && lab.textContent && lab.textContent.trim()) return lab.textContent.trim()
    }
    var parentLabel = el.closest('label')
    if (parentLabel && parentLabel.textContent && parentLabel.textContent.trim()) return parentLabel.textContent.trim()
    var placeholder = el.getAttribute('placeholder')
    if (placeholder && placeholder.trim()) return placeholder.trim()
    var title = el.getAttribute('title')
    if (title && title.trim()) return title.trim()
    var text = (el.textContent || '').trim().replace(/\\s+/g, ' ')
    if (text) return text.slice(0, 60)
    var name = el.getAttribute('name')
    if (name) return name
    return ''
  }
  function roleOf(el) {
    var explicit = el.getAttribute('role')
    if (explicit) return explicit
    var tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      var type = el.type
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button') return 'button'
      if (type === 'password') return 'textbox(password)'
      return 'textbox'
    }
    if (el.hasAttribute('contenteditable')) return 'textbox'
    return 'element'
  }

  var selector = 'a[href], button, input, select, textarea, [role], [onclick], [contenteditable="true"]'
  var out = []
  var n = 0
  var els = Array.prototype.slice.call(document.querySelectorAll(selector))
  for (var i = 0; i < els.length; i++) {
    var el = els[i]
    if (!isVisible(el)) continue
    n++
    var ref = 'e' + n
    el.setAttribute('data-ai-ref', ref)
    var role = roleOf(el)
    var name = labelFor(el)
    var disabled = (el.disabled === true || el.getAttribute('aria-disabled') === 'true') ? ' [disabled]' : ''
    var extra = ''
    var tag = el.tagName.toLowerCase()
    if (tag === 'a') {
      extra = ' (href=' + (el.getAttribute('href') || '') + ')'
    } else if (tag === 'select') {
      var opts = Array.prototype.slice.call(el.options).map(function (o) { return o.text }).slice(0, 20).join(', ')
      extra = ' = "' + el.value + '" [options: ' + opts + ']'
    } else if (tag === 'input') {
      if (el.type === 'checkbox' || el.type === 'radio') extra = el.checked ? ' [x]' : ' [ ]'
      else if (el.type !== 'submit' && el.type !== 'button') extra = ' = "' + el.value + '"'
    } else if (tag === 'textarea') {
      extra = ' = "' + el.value.slice(0, 60) + '"'
    }
    out.push(ref + '  ' + role + ' "' + name + '"' + extra + disabled)
    if (n >= 300) break
  }
  return out
})()`

async function snapshotText(page: Page): Promise<string> {
  const lines = (await page.evaluate(SNAPSHOT_SCRIPT)) as string[]
  const title = await page.title().catch(() => '')
  const body = lines.length ? lines.join('\n') : '(当前页面没有可交互元素)'
  return `标题: ${title}\n地址: ${page.url()}\n\n${body}`
}

/** 开一个具名浏览器会话；可选直接导航到 url。同名已存在则不重开。 */
export async function browserOpen(name: string, url?: string): Promise<string> {
  const key = displayName(name)
  if (sessions.has(key)) {
    return `会话「${key}」已存在（未重开）。如需跳转用 browser_goto，查看当前页面用 browser_snapshot。`
  }
  let browser: Browser
  try {
    browser = await chromium.launch({ headless: false })
  } catch (e: any) {
    return isMissingBrowser(e) ? NEED_CHROMIUM : `打开浏览器失败：${e?.message ?? String(e)}`
  }
  const page = await browser.newPage()
  sessions.set(key, { browser, page })
  const target = String(url ?? '').trim()
  if (target) {
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } catch (e: any) {
      return `已开会话「${key}」，但跳转失败：${e?.message ?? String(e)}`
    }
    return `已开浏览器会话「${key}」并打开 ${target}\n\n${await snapshotText(page)}`
  }
  return `已开浏览器会话「${key}」（空白页，等待 browser_goto）`
}

/** 让已有会话跳转到 url，返回跳转后的页面快照。 */
export async function browserGoto(name: string, url: string): Promise<string> {
  const s = getSession(name)
  if (!s) return `未找到浏览器会话「${displayName(name)}」，先用 browser_open 打开。`
  try {
    await s.page.goto(String(url ?? '').trim(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
  } catch (e: any) {
    return `跳转失败：${e?.message ?? String(e)}`
  }
  return await snapshotText(s.page)
}

/** 重新扫描当前页面，返回最新的可交互元素快照。 */
export async function browserSnapshot(name: string): Promise<string> {
  const s = getSession(name)
  if (!s) return `未找到浏览器会话「${displayName(name)}」，先用 browser_open 打开。`
  return await snapshotText(s.page)
}

/** 按快照里的 ref 点击对应元素。 */
export async function browserClick(name: string, ref: string): Promise<string> {
  const s = getSession(name)
  if (!s) return `未找到浏览器会话「${displayName(name)}」，先用 browser_open 打开。`
  const locator = s.page.locator(`[data-ai-ref="${escapeAttr(ref)}"]`)
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 })
    await locator.click({ timeout: 10_000 })
  } catch (e: any) {
    return `点击失败（ref=${ref}）：${e?.message ?? String(e)}`
  }
  await s.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
  return `已点击 ${ref}。页面可能已变化，如需继续操作请先 browser_snapshot 刷新。`
}

/** 按快照里的 ref 填写输入框/文本域（先清空再填入）。 */
export async function browserFill(name: string, ref: string, value: string): Promise<string> {
  const s = getSession(name)
  if (!s) return `未找到浏览器会话「${displayName(name)}」，先用 browser_open 打开。`
  try {
    await s.page.locator(`[data-ai-ref="${escapeAttr(ref)}"]`).fill(String(value ?? ''), { timeout: 10_000 })
  } catch (e: any) {
    return `填写失败（ref=${ref}）：${e?.message ?? String(e)}`
  }
  return `已在 ${ref} 填入：${value}`
}

/** 按快照里的 ref 给 <select> 选一个选项（优先按显示文字匹配，其次按 value）。 */
export async function browserSelect(name: string, ref: string, value: string): Promise<string> {
  const s = getSession(name)
  if (!s) return `未找到浏览器会话「${displayName(name)}」，先用 browser_open 打开。`
  const locator = s.page.locator(`[data-ai-ref="${escapeAttr(ref)}"]`)
  const v = String(value ?? '')
  try {
    await locator.selectOption({ label: v }, { timeout: 10_000 })
  } catch {
    try {
      await locator.selectOption(v, { timeout: 10_000 })
    } catch (e: any) {
      return `选择失败（ref=${ref}）：${e?.message ?? String(e)}`
    }
  }
  return `已将 ${ref} 选为：${v}`
}

/** 按下键盘按键；给了 ref 就在该元素上按，否则按在当前焦点/页面上（如回车提交、Esc 关闭下拉）。 */
export async function browserPress(name: string, key: string, ref?: string): Promise<string> {
  const s = getSession(name)
  if (!s) return `未找到浏览器会话「${displayName(name)}」，先用 browser_open 打开。`
  try {
    if (ref && ref.trim()) {
      await s.page.locator(`[data-ai-ref="${escapeAttr(ref)}"]`).press(String(key), { timeout: 10_000 })
    } else {
      await s.page.keyboard.press(String(key))
    }
  } catch (e: any) {
    return `按键失败（${key}）：${e?.message ?? String(e)}`
  }
  return `已按下按键：${key}`
}

/** 截取当前页面（非全屏），供人查看留痕；模型本身看不到图片内容。 */
export async function browserScreenshot(name: string, path?: string): Promise<string> {
  const s = getSession(name)
  if (!s) return `未找到浏览器会话「${displayName(name)}」，先用 browser_open 打开。`
  const dest = String(path || `/tmp/browser-${displayName(name)}.png`)
  try {
    await s.page.screenshot({ path: dest })
  } catch (e: any) {
    return `截图失败：${e?.message ?? String(e)}`
  }
  return `已保存截图至 ${dest}`
}

/** 列出所有具名浏览器会话及其当前标题/地址。 */
export async function browserList(): Promise<string> {
  if (!sessions.size) return '当前没有浏览器会话。'
  const rows: string[] = []
  for (const [key, s] of sessions) {
    const title = await s.page.title().catch(() => '')
    rows.push(`· ${key}\t${title}\t${s.page.url()}`)
  }
  return rows.join('\n')
}

/** 关闭一个浏览器会话。 */
export async function browserClose(name: string): Promise<string> {
  const key = displayName(name)
  const s = sessions.get(key)
  if (!s) return `会话「${key}」不存在（无需关闭）。`
  sessions.delete(key)
  try {
    await s.browser.close()
  } catch {
    /* 关闭异常不影响清理结果 */
  }
  return `已关闭浏览器会话「${key}」。`
}
