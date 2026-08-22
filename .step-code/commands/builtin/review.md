---
name: review
description: 代码审查，不修改文件
triggers:
  - "review"
  - "审查"
  - "code review"
  - "检查代码"
  - "review code"
allowedTools:
  - read_file
  - grep
  - bash
output: inline
priority: 100
---

# Review 行为

当用户要求审查代码、review 变更时，进入 review 模式。

## 行为规则

1. **只读不改**：不调用 write_file / edit_file，不执行有副作用的 bash 命令。
2. **获取变更范围**：
   - 用户未指定 → 跑 `git diff HEAD` 获取未提交变更
   - 用户指定目录 → 只审查该目录下的变更
   - 用户指定 `--since` → 跑 `git log --since` 获取范围
   - 用户指定 `--commit` → 跑 `git show <hash>`
3. **加载审查规则**（按优先级从低到高叠加）：
   - 内置安全规则（见下方「内置规则」）
   - `.step-code/review/rules/*.md`（按 frontmatter 的 paths 匹配生效）
   - 用户通过参数指定的额外规则文件
4. **逐文件检查**：对每条变更，对照所有生效的规则逐项检查。
5. **输出格式**：

```markdown
# Review: {scope}

**Files**: X changed, +Y -Z
**Rules**: N built-in + M project

## Findings
| Severity | File | Line | Rule | Description |
|----------|------|------|------|-------------|
| error | src/api/ | 42 | 自定义规则 | ... |
| warning | src/ | 15 | 自定义 | ... |

## Summary
X error, Y warning, Z info
```

Severity 三级：
- **error**：必须修复（安全、回归风险）
- **warning**：建议修复（规范、可读性）
- **info**：仅供参考（改进建议）

## 内置规则（不可关闭）

以下规则始终生效，除非用户自定义规则用 `override: true` 显式覆盖：

- **凭证泄露**：硬编码 API key / token / password
- **危险函数**：eval / exec / Function() / spawn 未加约束
- **路径穿越**：用户输入拼接路径未 sanitize
- **SQL 注入**：字符串拼接构造 SQL 查询
- **回归风险**：删除公开 API、改接口签名、移除导出
- **测试缺口**：新增业务代码无对应测试文件

## 规则文件格式

`.step-code/review/rules/*.md` 每个文件是一个规则集：

```yaml
---
paths: ["src/**", "!src/vendor/**"]
severity: error
override: false
---

- 规则描述
```

- `paths`：Glob 模式，限定规则生效的文件范围
- `severity`：该规则集的默认严重度
- `override`：设为 true 可覆盖同路径的内置规则

## 约束

- 不修改任何文件
- 不执行有副作用的 bash 命令（git diff / git show 等只读命令除外）
- 审查结果写入对话上下文，不写入文件（除非用户要求）
