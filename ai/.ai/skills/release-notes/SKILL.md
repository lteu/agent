---
name: release-notes
description: 根据 git 提交历史生成一份面向用户的发布说明（changelog）
---

# 生成发布说明

当用户说「写发布说明 / 生成 changelog / 总结这次发了什么」时，按下面步骤做。

## 1. 确定范围

先看清要总结哪一段提交：

- 用户给了起止 tag/commit（如 `v0.1.0..HEAD`）就用它；
- 没给就用最近一个 tag 到 HEAD：`run_bash` 执行
  `git describe --tags --abbrev=0` 取最近 tag，再 `git log <tag>..HEAD --oneline`；
- 仓库没有任何 tag，就总结最近 20 条：`git log -20 --oneline`。

## 2. 读取提交

`run_bash` 执行 `git log <范围> --pretty=format:'%h %s'`，拿到每条提交的短哈希与标题。

## 3. 归类整理

把提交按类型归到下面几栏（空栏省略），用一句人话描述，不要照抄 commit message：

- ✨ 新功能（feat）
- 🐛 修复（fix）
- ⚡ 优化（perf / refactor 中对用户可感知的）
- 📝 文档 / 其他（docs、chore 等，可合并成一两条）

## 4. 输出

用 markdown 输出，顶部写版本号与日期（日期用 `date +%F`）。例：

```
## v0.2.0 (2026-06-30)

### ✨ 新功能
- ……

### 🐛 修复
- ……
```

如果用户要求，再用 write_file 存成 `CHANGELOG` 或追加到现有文件。
