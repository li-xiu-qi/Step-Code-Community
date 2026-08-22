<p align="center">
  <a href="../en/commands.md">English</a> |
  <a href="./commands.md">简体中文</a>
</p>

# 命令体系

Step Code 的命令不限于斜杠命令和工具调用。你可以在 markdown 文件里定义自己的命令，让它出现在 `/` 菜单里、通过触发词激活、甚至调用 skill。本页讲清自定义命令的完整格式、加载位置、规则文件怎么配合 `/review` 工作。

## 目录

- [自定义命令](#自定义命令)
- [frontmatter 字段](#frontmatter-字段)
- [三种命令类型](#三种命令类型)
- [加载位置与优先级](#加载位置与优先级)
- [trigger 匹配规则](#trigger-匹配规则)
- [review 规则文件](#review-规则文件)

## 自定义命令

把 markdown 文件放到以下位置，启动时自动加载到 `/` 菜单：

| 位置 | 作用域 | 优先级 |
|------|--------|--------|
| `.step-code/commands/builtin/*.md` | 项目级（随仓库分发） | 100 |
| `~/.step-code/commands/*.md` | 用户级（跨项目） | 50 |

同名命令：用户级覆盖项目级，内置不能被用户级完全屏蔽（重名时两者都加载，用户级优先匹配）。

## frontmatter 字段

```yaml
---
name: review
description: 代码审查，不修改文件
type: prompt                    # prompt | pipeline | skill
triggers:
  - "review"
  - "审查"
  - "code review"
allowedTools:                    # 可选：限制该命令可用工具
  - read_file
  - grep
  - bash
model: reasoning-heavy          # 可选：指定模型（pipeline 类型用）
output: inline                  # inline | file
outputPath: .step-code/plans/{date}-{slug}.md  # output: file 时必填
priority: 100                   # 排序权重，越大越靠前
params:                         # 可选：透传给 handler 的参数
  key: value
---
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 命令名（用 `/name` 调用） |
| `description` | 是 | 菜单里显示的简短描述 |
| `type` | 否 | `prompt`（默认）/ `pipeline` / `skill` |
| `triggers` | 否 | 自然语言触发词列表。用户输入包含其中任一即激活该命令 |
| `allowedTools` | 否 | 白名单，不填则用全部工具 |
| `model` | 否 | 覆盖模型（`pipeline` 类型常用，如 `reasoning-heavy`） |
| `output` | 否 | `inline`（默认，结果注入对话）/ `file`（结果写入文件） |
| `outputPath` | 否 | `output: file` 时的落盘路径，支持 `{date}` `{slug}` 变量 |
| `priority` | 否 | 排序权重，默认 50，内置 100 |
| `params` | 否 | 透传给 pipeline handler 的键值对 |

正文（frontmatter 之后的 markdown）是指令内容：`prompt` 类型注入上下文，`skill` 类型激活对应 skill。

## 三种命令类型

### prompt 类型

最常见的类型。正文作为 prompt 注入当前回合，模型按正文执行。

示例（项目级 builtin/check-license.md）：

```yaml
---
name: check-license
description: 扫描代码中的竞品参考声明并修复
type: prompt
triggers:
  - "版权检查"
  - "检查竞品声明"
  - "license check"
allowedTools:
  - grep
  - bash
  - edit_file
output: inline
---

扫描 src/ 目录下所有 .ts / .tsx 文件的代码注释，找出：
1. 明确提及竞品名称或路径的（如 "设计参考：某项目 path"）
2. 含 "参考/对标/借鉴" 且指向具体竞品的
3. commit message 中的竞品名称

对每处给出文件、行号、原文，以及建议的改写方式。
确认后直接修复。
```

调用方式：
- 输入 `/check-license`
- 或输入包含任一 trigger 的自然语言（"版权检查"、"检查竞品声明"）

### pipeline 类型

有固定执行流程的命令。正文写行为规则，`handler` 字段指定代码中的处理器函数名。

内置示例：`reflect`、`review` 是 pipeline 类型，它们的正文描述了行为规则，代码里有对应的 handler 实现。

```yaml
---
name: my-pipeline
description: 我的自定义流水线
type: pipeline
handler: myHandler          # 对应代码中注册的 handler 名
params:
  maxRetries: 3
output: inline
---

正文描述该 pipeline 的行为规则。
```

pipeline 类型的 handler 需要在代码里注册，用户自定义命令一般不用这个类型。

### skill 类型

激活一个已注册的 skill。正文为空，skill 名通过 `name` 或 frontmatter 指定。

示例（内置 pkm-hub.md）：

```yaml
---
name: pkm-hub
description: 知识库管理入口
type: skill
triggers:
  - "pkm"
  - "知识库"
---
```

调用 `/pkm-hub` 或输入"pkm"即激活 `pkm-hub` skill。

## 加载位置与优先级

```
项目级 .step-code/commands/builtin/    priority: 100（内置）
用户级 ~/.step-code/commands/          priority: 50
```

加载顺序：
1. 先扫项目级，再扫用户级
2. 同名命令：用户级覆盖项目级
3. 内置命令（builtin）不能被同名用户命令屏蔽——两者共存，用户级优先匹配

修改命令文件后需要 `/reload` 或在下一轮生效（turn 边界自动检测）。

## trigger 匹配规则

用户输入与 `triggers` 列表的匹配：

- **前缀匹配优先**：输入 "review" 匹配 trigger "review"
- **子序列回退**：恰好 2 个字符时启用，如 "cp" 匹配 "compact"
- **包含匹配**：输入 "帮我做个 review" 包含 "review" 即命中
- 菜单一屏 6 条，超出窗口化滚动

## review 规则文件

`/review` 命令除了内置规则外，还会加载 `.step-code/review/rules/*.md` 下的规则文件。

### 规则文件格式

```yaml
---
paths: ["src/**", "!src/vendor/**"]
severity: error
override: false
---

- 规则描述（每条一行）
- 另一条规则描述
```

| 字段 | 说明 |
|------|------|
| `paths` | Glob 模式，限定规则生效的文件范围 |
| `severity` | 该规则集的默认严重度：`error` / `warning` / `info` |
| `override` | `true` 可覆盖同路径的内置规则 |

### 内置规则（不可关闭）

以下规则始终生效，除非自定义规则用 `override: true` 显式覆盖：

- **凭证泄露**：硬编码 API key / token / password
- **危险函数**：eval / exec / Function() / spawn 未加约束
- **路径穿越**：用户输入拼接路径未 sanitize
- **SQL 注入**：字符串拼接构造 SQL 查询
- **回归风险**：删除公开 API、改接口签名、移除导出
- **测试缺口**：新增业务代码无对应测试文件

### 规则叠加顺序

1. 内置安全规则（最低优先）
2. `.step-code/review/rules/*.md`（按 frontmatter 的 `paths` 匹配生效）
3. 用户通过参数指定的额外规则文件（最高优先）

### 使用示例

假设你有一个项目规范要求"所有异步函数必须有错误处理"，新建 `.step-code/review/rules/error-handling.md`：

```yaml
---
paths: ["src/**/*.ts"]
severity: warning
override: false
---

- 所有 async 函数必须有 try/catch 或 .catch() 处理
- Promise 链末尾必须有 .catch() 或 await 在 try 块内
- 不吞异常：catch 块不能为空或只写 console.log
```

`/review` 时会自动加载这条规则，与内置规则叠加审查。
