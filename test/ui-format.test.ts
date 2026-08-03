import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compactUrlForDisplay,
  inlineMarkdownSegments,
  localWebFetchUrl,
  markdownLinePresentation,
  splitRemoteWebTitle,
  terminalHyperlink,
} from '../src/ui-format.js'

test('长 URL 的默认标题只保留域名和路径', () => {
  assert.equal(
    compactUrlForDisplay(
      'https://mcphub.example.net/oauth/authorize?response_type=code&client_id=abc&state=very-long-state',
    ),
    'mcphub.example.net/oauth/authorize',
  )
  assert.equal(compactUrlForDisplay('not-a-url', 6), 'not-a…')
})

test('助手正文渲染单星号和双星号强调且隐藏标记', () => {
  assert.deepEqual(inlineMarkdownSegments('the *soft* and **strong** words'), [
    { text: 'the ', style: 'plain' },
    { text: 'soft', style: 'italic' },
    { text: ' and ', style: 'plain' },
    { text: 'strong', style: 'bold' },
    { text: ' words', style: 'plain' },
  ])
  assert.deepEqual(inlineMarkdownSegments('keep \\*literal\\* star'), [
    { text: 'keep *literal* star', style: 'plain' },
  ])
})

test('Web 工具标题只拆出工具名和普通样式参数', () => {
  assert.deepEqual(splitRemoteWebTitle('Web Search("terminal UI")'), {
    tool: 'Web Search',
    argument: '("terminal UI")',
  })
  assert.deepEqual(splitRemoteWebTitle('Fetch(https://example.com)'), {
    tool: 'Fetch',
    argument: '(https://example.com)',
  })
  assert.equal(splitRemoteWebTitle('Read(/tmp/file)'), undefined)
  assert.equal(
    localWebFetchUrl('抓取 https://api.example.com/data?x=1'),
    'https://api.example.com/data?x=1',
  )
})

test('Markdown 标题隐藏井号，链接隐藏目标并生成 OSC 8 点击区域', () => {
  assert.deepEqual(markdownLinePresentation('### "fluffy"（毛茸茸的）'), {
    content: '"fluffy"（毛茸茸的）',
    heading: true,
  })
  assert.deepEqual(
    inlineMarkdownSegments('- [Dragons are Tricksy](https://example.com/a-long-article/)'),
    [
      { text: '- ', style: 'plain' },
      {
        text: 'Dragons are Tricksy',
        style: 'link',
        href: 'https://example.com/a-long-article/',
      },
    ],
  )
  assert.equal(
    terminalHyperlink('https://example.com', 'Example'),
    '\x1b]8;;https://example.com\x07Example\x1b]8;;\x07',
  )
})
