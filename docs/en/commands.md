<p align="center">
  <a href="./commands.md">English</a> |
  <a href="../zh/commands.md">简体中文</a>
</p>

# Command System

Step Code commands go beyond slash commands and tool calls. You can define your own commands in markdown files, make them appear in the `/` menu, activate them via trigger words, and even invoke skills. This page explains the full custom command format, load locations, and how rule files work with `/review`.

## Table of Contents

- [Custom Commands](#custom-commands)
- [Frontmatter Fields](#frontmatter-fields)
- [Three Command Types](#three-command-types)
- [Load Locations and Priority](#load-locations-and-priority)
- [Trigger Matching](#trigger-matching)
- [Review Rule Files](#review-rule-files)

## Custom Commands

Place markdown files in the following locations and they are auto-loaded into the `/` menu on startup:

| Location | Scope | Priority |
|----------|-------|----------|
| `.step-code/commands/builtin/*.md` | Project-level (shipped with the repo) | 100 |
| `~/.step-code/commands/*.md` | User-level (cross-project) | 50 |

When commands share the same name: user-level overrides project-level. Built-in commands cannot be fully shadowed by user-level — both load, user-level wins on match.

## Frontmatter Fields

```yaml
---
name: review
description: Code review, no file modifications
type: prompt                    # prompt | pipeline | skill
triggers:
  - "review"
  - "审查"
  - "code review"
allowedTools:                    # Optional: restrict available tools
  - read_file
  - grep
  - bash
model: reasoning-heavy          # Optional: override model (used by pipeline)
output: inline                  # inline | file
outputPath: .step-code/plans/{date}-{slug}.md  # Required when output: file
priority: 100                   # Sort weight, higher = earlier
params:                         # Optional: key-value pairs passed to handler
  key: value
---
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Command name (invoke with `/name`) |
| `description` | Yes | Short description shown in the menu |
| `type` | No | `prompt` (default) / `pipeline` / `skill` |
| `triggers` | No | Natural-language trigger words. Input containing any of them activates this command |
| `allowedTools` | No | Whitelist; if omitted, all tools are available |
| `model` | No | Override model (commonly used by `pipeline` type, e.g. `reasoning-heavy`) |
| `output` | No | `inline` (default, result injected into conversation) / `file` (result written to file) |
| `outputPath` | No | Disk path when `output: file`, supports `{date}` `{slug}` variables |
| `priority` | No | Sort weight, default 50, built-ins 100 |
| `params` | No | Key-value pairs passed through to the pipeline handler |

The body (markdown after the frontmatter) is the instruction content: for `prompt` type it is injected into context; for `skill` type it activates the corresponding skill.

## Three Command Types

### prompt type

The most common type. The body is injected as a prompt into the current turn, and the model acts on it.

Example (project-level builtin/scan-todo.md):

```yaml
---
name: scan-todo
description: Scan code for TODO/FIXME comments and list them
type: prompt
triggers:
  - "todo scan"
  - "scan todos"
allowedTools:
  - grep
  - bash
output: inline
---

Scan all .ts / .tsx files under src/ for code comments that contain TODO or FIXME.
For each finding, give the file, line number, and the original comment text.
```

Invocation:
- Type `/scan-todo`
- Or type natural language containing any trigger ("todo scan", "scan todos")

### pipeline type

Commands with a fixed execution flow. The body describes the behavior rules; the `handler` field names the processor function in code.

Built-in examples: `reflect` and `review` are pipeline types. Their bodies describe behavior rules, and corresponding handlers are registered in code.

```yaml
---
name: my-pipeline
description: My custom pipeline
type: pipeline
handler: myHandler          # The handler name registered in code
params:
  maxRetries: 3
output: inline
---

Body describes the behavior rules for this pipeline.
```

Pipeline-type handlers must be registered in code. User-defined commands generally do not use this type.

### skill type

Activates a registered skill. The body is empty; the skill is identified by `name` or specified in frontmatter.

Example (built-in pkm-hub.md):

```yaml
---
name: pkm-hub
description: Knowledge base management entry point
type: skill
triggers:
  - "pkm"
  - "knowledge base"
---
```

Calling `/pkm-hub` or typing "pkm" activates the `pkm-hub` skill.

## Load Locations and Priority

```
Project-level .step-code/commands/builtin/    priority: 100 (built-in)
User-level     ~/.step-code/commands/          priority: 50
```

Load order:
1. Scan project-level first, then user-level
2. Same name: user-level overrides project-level
3. Built-in commands cannot be shadowed by same-named user commands — both coexist, user-level wins on match

After editing a command file, run `/reload` or it takes effect at the next turn boundary (auto-detected).

## Trigger Matching

Matching user input against the `triggers` list:

- **Prefix match first**: "review" matches trigger "review"
- **Subsequence fallback**: enabled for exactly 2 characters, e.g. "cp" matches "compact"
- **Containment match**: "do a review for me" contains "review" and hits
- Menu shows 6 per screen, scrolls when overflowed

## Review Rule Files

In addition to built-in rules, `/review` loads rule files under `.step-code/review/rules/*.md`.

### Rule File Format

```yaml
---
paths: ["src/**", "!src/vendor/**"]
severity: error
override: false
---

- Rule description (one per line)
- Another rule description
```

| Field | Description |
|-------|-------------|
| `paths` | Glob patterns limiting which files the rules apply to |
| `severity` | Default severity for this rule set: `error` / `warning` / `info` |
| `override` | `true` to override built-in rules on the same path |

### Built-in Rules (Cannot be Disabled)

The following rules are always active unless a custom rule with `override: true` explicitly covers them:

- **Credential leakage**: hard-coded API key / token / password
- **Dangerous functions**: eval / exec / Function() / unconstrained spawn
- **Path traversal**: user input concatenated into paths without sanitization
- **SQL injection**: SQL queries built via string concatenation
- **Regression risk**: deleting public APIs, changing interface signatures, removing exports
- **Test gaps**: new business code without corresponding test files

### Rule Stacking Order

1. Built-in security rules (lowest priority)
2. `.step-code/review/rules/*.md` (activated by matching `paths` in frontmatter)
3. Extra rule files specified by the user via parameters (highest priority)

### Usage Example

Suppose your project convention requires "all async functions must have error handling". Create `.step-code/review/rules/error-handling.md`:

```yaml
---
paths: ["src/**/*.ts"]
severity: warning
override: false
---

- All async functions must have try/catch or .catch() handling
- Promise chains must end with .catch() or be awaited inside a try block
- Do not swallow exceptions: catch blocks must not be empty or only contain console.log
```

`/review` automatically loads this rule and stacks it with built-in rules.
