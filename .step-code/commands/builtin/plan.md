---
name: plan
description: 生成实施计划，只读不写
triggers:
  - "plan"
  - "planner"
  - "先计划再执行"
  - "规划一下"
allowedTools:
  - read_file
  - grep
  - glob
  - web_search
  - ask_user
model: reasoning-heavy
output: file
outputPath: .step-code/plans/{date}-{slug}.md
priority: 100
---

# Plan 行为

当用户要求规划、计划或任何包含 plan 触发词的请求时，进入 plan 模式。

## 行为规则

1. **只读优先**：只使用 read_file, grep, glob, web_search 工具，不碰 write_file / edit_file / bash。
2. **主动澄清**：用 ask_user 提出 2-4 个关键问题（scope, 约束, 验收标准, 依赖项）。
3. **结构化输出**：按以下模板输出 plan：

```markdown
# Plan: {任务标题}

**Scope**: {作用范围}
**Created**: {日期}
**Model**: {模型名}

## Overview
2-3 句话讲清要做什么、为什么这么做。

## Steps
| # | File | Task | Complexity | Deps |
|---|------|------|-----------|------|
| 1 | path/to/file.ts | 描述 | 1-10 | — |

## Risks
- 潜在风险点

## Verification
- 验证步骤（测试, lint, typecheck）
```

4. **等待确认**：输出 plan 后，明确说「等待你确认后执行」。不要自动开始执行。
5. **写入文件**：将 plan 写入 {outputPath}，文件名包含日期和任务 slug。

## 约束

- 不修改任何文件
- 不执行任何 shell 命令
- 不调用会产生副作用的工具
- 超出 scope 的需求标注为「后续独立任务」
