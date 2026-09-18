# Step Code

> 终端编码 agent CLI · 由阶跃星辰 Step 系列模型驱动 · 前端 pi-tui 差分渲染。
> 在本仓做开发的 AI 代理，动手前先读本文件。

## 项目速览

- **语言/运行时**：TypeScript + Node ≥ 22（`node:fs.globSync` 要求 22+），ESM
- **包管理**：pnpm（设置写在 `pnpm-workspace.yaml`，不是 package.json 的 `pnpm` 字段）
- **UI 层**：pi-tui（`@earendil-works/pi-tui`，命令式组件、非 React）
- **模型接入**：多协议 provider，按渠道 `type` 分发——Anthropic Messages、OpenAI Chat Completions、OpenAI Responses，三者均支持工具调用
- **CLI 解析**：commander；**配置**：TOML（smol-toml）；**校验**：zod 4
- **构建**：`pnpm build`（tsc → `dist/`）；**开发**：`pnpm dev`（tsx）；**类型检查**：`pnpm typecheck`（tsc 严格模式）；**测试**：`pnpm test`（vitest）

核心分层：`config` → `provider` → `tools` → `agent`（循环）→ `tui-pi` / `chat` → 入口层。架构真相、分层依赖方向与五条铁律见 skill `step-code-architecture`，改动模块结构前先读它。

## 目录结构

```
src/
├── main.ts               # bin 引导：无静态 import。设 NODE_ENV + 堆上限 re-exec，再动态加载 cli.js（见「bin 引导入口」）
├── cli.ts                # 轻量入口：commander 参数/子命令解析（--help 不触发完整栈）
├── cli-app.ts            # 完整应用装配：全部 import + 模块初始化 + 各模式分发（-p / -r / sessions / --acp / 交互）
├── i18n.ts               # 中英文案表（zh + en 两张，改文案两边同步）
├── version.ts            # 版本号单一来源（与 package.json 对齐，有测试断言）
├── config/               # env / .env / ~/.step-code/config.toml；协议预设、渠道与模型别名解析
├── provider/
│   ├── step/             # 阶跃专属适配（stepCommon 档位折算与 effort 形态 / stepMessages 通道）
│   ├── anthropicMessages.ts / openaiChat.ts / openaiResponses.ts  # 三协议 provider
│   ├── openaiCommon.ts   # OpenAI 两协议共用：请求/响应与 Anthropic 形状互译
│   ├── adapter.ts        # 通道投影 + 按能力降级 + 错误驱动重投影
│   ├── capability-registry.ts  # 模型能力声明（(channel, model) 精确匹配，未声明默认放行）
│   ├── degrader.ts       # 按能力降级：媒体块占位化 / thinking 剥离 / cache_control 剥离
│   ├── projector.ts      # 消息投影：轮次结构规整
│   ├── catalog.ts        # models.dev 模型目录导入
│   ├── compaction.ts     # 压缩专用 provider 装配
│   ├── prepare.ts        # cache_control 注入 + 合并 tool_result-only 消息
│   ├── retry.ts          # 指数退避重试 + 可重试判定 + 空响应诊断上下文
│   └── factory.ts / types.ts
├── agent/
│   ├── loop.ts / runTurn.ts    # 多回合编排 + 单回合核心（流式 → tool_use → 授权执行 → 回灌）
│   ├── toolScheduler.ts        # 并行工具调度：资源冲突判定 + 乱序执行 + 按序回收
│   ├── toolResultLimit.ts      # 工具结果体积上限与截断
│   ├── wirelog.ts              # 原始请求/响应帧留存（排查协议层问题）
│   ├── hooks.ts / events.ts / message.ts / wire.ts
│   ├── hooks/engine.ts         # 用户可配置 hooks 引擎（PreToolUse 等 5 事件）
│   ├── systemPrompt.ts / agentsMd.ts
│   ├── turns.ts                # 轮次派生与按轮截断
│   ├── reflect.ts              # /reflect 方法论回顾
│   ├── toolSearch.ts           # 外部工具（MCP）懒加载检索
│   ├── dynamicWorkflow/        # 动态工作流：sandbox(quickjs) / primitives / runner / journal / scriptStore
│   ├── permission/mode.ts      # 权限判定 manual/auto/yolo + plan 模式硬拦
│   ├── subagent/               # 子 agent：types / registry(内置+md) / runner(嵌套)
│   ├── goal/                   # 自主目标：状态机 + 双预算 + 持久化 + 纯函数续跑裁决
│   ├── team/                   # 团队模式：任务模型 + git(worktree/merge) + 规则(互斥/门控/信箱) + session 状态
│   ├── cron/                   # 定时/循环任务：cronexpr + scheduler + 按 cwd 持久化
│   ├── background/             # 后台任务：manager + notify + 终端通知(BEL/OSC 9)
│   └── compaction/             # token 估算 + 微压缩 + 全量摘要压缩
├── session/
│   ├── store.ts                # 会话持久化：JSON 快照，按 workdir 分桶（+ fork/resume）
│   ├── attachments.ts          # 大附件内容寻址落盘 + 回填（消息里只留指针）
│   ├── inputHistory.ts         # 输入历史：按 cwd 隔离 + 上下键回溯
│   ├── resumeHint.ts / debugBundle.ts / debugCli.ts
├── chat/                 # 前端无关的纯逻辑层（斜杠命令 / 补全 / 历史回放 / think / undo / 流缓冲等）
│                         #   commands.ts 是斜杠命令注册表（SLASH_COMMANDS）
├── tui-pi/               # pi-tui 组件：PiChat / Transcript / StatusLine / blocks(markdown) /
│                         #   pickers / prompts / overlays(Expand/Agents/Tasks) / theme 等
├── skill/                # 技能懒加载：扫描 + frontmatter 解析 + 清单预算 + 激活注入
├── plugin/               # 插件发现与能力合流（skills + mcpServers + hooks + commands）+ install 管理
├── mcp/                  # MCP：stdio 连接/发现/调用 + status
├── acp/server.ts         # ACP 服务端（--acp，stdin/stdout JSON-RPC，供 IDE 驱动）
├── tools/                # 各工具（zod schema + execute）+ index.ts 注册表
│                         #   文件/执行：read_file/write_file/edit_file/list_dir/glob/grep
│                         #   编排：spawn_agent/dynamic_workflow/task_*/todo_list/*_goal/team_*
│                         #   交互：exit_plan_mode/ask_user；联网：web_search/web_fetch/web_image_search
│                         #   其他：skill/tool_search/cron_*；access.ts / webCache.ts / shellResolve.ts / fsutil.ts
└── utils/                # logger / redact
tests/                    # vitest 单元 + 集成测试
```

面向用户的功能说明在 `docs/`。`README.md`（英文）与 `README_CN.md`（简体中文）顶部有互链，改动其中一份必须同步另一份。

## 模型接入（多协议，按渠道 type 分发）

三协议均支持工具调用，新增协议在 `src/provider/` 加适配器并注册 `PROVIDER_PRESETS`：

- **anthropic**（Messages，`/v1/messages`）：`base_url` **不带 `/v1`**（SDK 自动拼），鉴权 `x-api-key`，`system` 走顶层参数。`max_tokens` **必填**，缺省返回 400。思考控制经 `output_config.effort` 发出，不写顶层 `effort` 或官方 `thinking.budget_tokens`（后两者会被静默接受但不生效）。
- **openai**（Chat Completions，`/v1/chat/completions`）：`base_url` **带 `/v1`**，鉴权 `Authorization: Bearer`，思考读 `reasoning_content`、控制用顶层 `reasoning_effort`。
- **openai_responses**（Responses，`/v1/responses`）：`base_url` **带 `/v1`**，`Authorization: Bearer`，流式。工具形状与 Chat 不同：tools 定义平铺（不嵌 `function`），工具往返用 `function_call` / `function_call_output` 两类独立 input 项靠 `call_id` 关联，而非 `role:"tool"` 消息。
- **思考参数三协议各不相同**，统一由 `src/provider/step/stepCommon.ts` 翻译。运行时类型 `ThinkingParam`（`provider/types.ts`）同时带 `level` 与 `budgetTokens`：阶跃渠道取 `level`，原生 Anthropic 渠道取 `budgetTokens`（作 `thinking.budget_tokens` 发出），由 `factory.ts` 一次算好两份下发。
- **TS 结构类型在这条链上帮不上忙**：`{ budgetTokens?: number }` 与 `ThinkingParam` 结构兼容，漏填 `level` 编译器不报错，但档位会静默回落到最高思考量。改这条链路必须手工确认 `level` 已填上（`tests/provider/factory.test.ts` 有护栏）。
- 三套结束原因（`finish_reason` / `status`+`incomplete_details.reason` / `stop_reason`）分别归一，**未知值一律归 `null`（无信号），不冒充正常收尾**，否则截断与内容拦截会被伪装成正常结束。
- **`/v1` 带不带配错会 404**；模型与协议不是自由组合，配错时服务端返回 400/404 并指明应改用的接口，客户端不做前置校验（服务端报错永远比硬编码快照新）。职责是**不吞掉这两条报错消息**（`tests/provider/openaiChat.test.ts` 有护栏）。
- provider 统一产出 Anthropic 形状的事件流与 `finalMessage()`，OpenAI 协议在 provider 内部翻译，消费方（runTurn/loop/compaction/TUI）零感知。
- 多模态：支持 base64 图片理解（`image/png`|`jpeg`|`gif`|`webp`），不支持音视频；交互界面 Alt+V 从剪贴板粘贴图片。
- API key 优先级：`STEP_CODE_API_KEY` > 配置文件 `api_key`（anthropic/openai 协议另认 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`）；`STEP_CODE_PROVIDER`/`BASE_URL`/`MODEL` 环境变量可覆盖。多渠道多模型经 `[providers.<id>]` + `[models.<别名>]` 配置。

> **静默接受不等于生效**：渠道对未知参数通常返回 200 但忽略，「发了不报错」不能作为参数生效的证据。涉及思考档位、思考预算这类「不报错的 bug」，必须用会引发长推理的任务做并发配对实测验证；简单任务各档无差异，会得出假阴性。

## 破坏性迭代与兼容判据

1.0 前允许破坏性迭代。一段兼容代码去留的判据只有一条：**只为旧版本自产数据/格式/配置存在的兼容，拆；为不受控外部行为（服务端、SDK、协议、终端、用户手写文件/配置）或前向健壮性（崩溃窗口、写入中断）存在的容错，留。**

- 拆的例子：读旧格式会话文件的折算归一化路径；旧环境变量名的回落识别。
- 留的例子：事件日志读盘容忍崩溃截断的尾行（防进程死在写入中途）；对用户手写 base_url 做裸域名/后缀归一化（防配置书写习惯导致 404）。
- 每段保留的容错，注释里必须写明它防的是哪个外部行为，不允许只写「兼容」「兜底」，否则下次清理无法区分它是容错还是旧数据兼容。

## 开发纪律

- 改动前先读相关文件；改动最小化，不做无关重构。
- 每次改完跑 `pnpm typecheck` 与 `pnpm test`；改完入口相关文件先 `pnpm build` 重建 `dist/`（本机 `step` 命令直接用 dist）。
- 新增工具：在 `src/tools/` 下单文件（zod schema + execute，返回 `ok()`/`fail()`），注册进 `src/tools/index.ts` 的 `ALL_TOOLS`。工具报错返回 `fail()` 不抛异常，循环会回灌给模型自纠。
- 权限判定改 `agent/permission/mode.ts`；斜杠命令改 `chat/commands.ts` 的 `SLASH_COMMANDS` 注册表；横切逻辑走 `agent/hooks.ts` 的 `LoopHooks` 缝，不要塞进 `runTurn` 核心。
- 子 agent：角色定义在 `agent/subagent/registry.ts`（内置）或 `.step-code/agents/*.md`（frontmatter：description/tools/model/maxSteps + 正文即 system prompt）。递归防护双保险：子 agent 工具集永不含 spawn_agent + `ToolContext.depth` 上限。限制走配置的 `[subagent]` 段（`max_depth`/`max_steps`/`max_concurrent`，「可配 + 默认 + clamp」，见 `config.ts` 的 `resolveSubagentLimits`）。
- 跨平台优先：文件操作用 `node:fs` 原生 API 而非 shell；bash 工具在 Windows 下已封装 Git Bash 探测。
- **跨平台路径拼接**：处理 Windows 风格路径时（含仅在 `process.platform === 'win32'` 分支内、以及 mock 成 `'win32'` 的单测），必须显式用 `path.win32`（或 `path.posix`），禁止默认 `path.join`。默认 join 在 POSIX 机器上把反斜杠当普通字符，会拼出混合分隔符导致路径匹配失败。
- pnpm 配置改动写 `pnpm-workspace.yaml`（pnpm 10+ 不再读 package.json 的 `pnpm` 字段）。

### 推翻一个结论后，全库扫用户文案

修完代码、更新完文档之后，照着旧结论写的用户文案仍会漏，且错误文案会主动劝用户放弃正确做法。推翻结论时按固定清单扫，不靠回忆：`src/i18n.ts`（zh + en 两张表）、`docs/zh` + `docs/en`、`CHANGELOG.md`、`src/skill/builtin/*.ts` 的内嵌文本、代码注释。被实测推翻的说法要加测试护栏（见 `tests/i18n.test.ts`「文案不得复活已被推翻的结论」：正则黑名单钉错误说法 + 正面断言必须给出正确手段）。护栏标准是「该说法被实测推翻**且**出现在面向用户的文案里」；代码注释讲历史不算，注释本就该记录被推翻的过程。

### 工具调用泄漏检测的判据是尖括号标签

`runTurn.ts` 的 `TOOL_CALL_LEAK_PATTERNS` 只匹配 `<` 开启的标签形态（`<invoke name=`、`<function_calls>` 等），**不匹配裸词，别「优化」回裸词**。理由：裸词字面就写在文档里，「读文档并复述」是常见任务，裸词判据会让 agent 每次讨论这个机制都误报；而真实泄漏必然带尖括号，收紧不损失召回。`tests/agent/runTurnToolCallLeak.test.ts` 有用例钉住这个判据。同样不做两件事：不做文本兜底解析（把漏出的 XML 解析回工具调用，非严格 XML 且无转义，参数含尖括号时无法可靠还原）；不做回灌重试（触发条件是上下文长度，回灌不改变它）。

## bin 引导入口不可污染（硬约束）

`src/main.ts` 是 bin 入口，只做两件事：设 `process.env.NODE_ENV`（含堆上限不足时 re-exec 加 `--max-old-space-size`），然后动态 `import('./cli.js')`。

**禁止**给它加任何静态 `import`，禁止把 `NODE_ENV` 赋值挪到动态 import 之后。ES 模块的静态 import 一律在模块体之前求值，赋值写在 cli 里就已经晚了。反过来，`cli.ts` / `cli-app.ts` 里也不要设置 `NODE_ENV`、不要 import 任何设置它的模块当「兜底」，那会制造设置点不一致。`src/env.ts` 已删除，不得重建。

堆 re-exec 用 `STEP_CODE_HEAP_REEXEC` 标记防递归，转发原有 `process.execArgv`（`--inspect` / `--enable-source-maps` 等不静默失效）；re-exec 后堆仍不足时告警一次并继续，不无限重试。

改动入口相关文件后必须过这两条（`pnpm test` 已包含）：

- `tests/env.test.ts`：静态断言（引导文件无静态 import、赋值早于动态 import、cli 不设 NODE_ENV、env.ts 不存在）。
- `tests/tui-pi/firstFrameSmoke.test.ts`：进程级冒烟，真实 spawn `dist/main.js` 断言 stdout 非空。**依赖 `dist/` 已构建**，未构建时自动跳过，所以改完入口先 `pnpm build` 再跑，否则这条测不到。

三条分发路径各有保障：bin 靠本引导文件运行时赋值；bundle 靠 esbuild `define` 静态折叠（为此 `main.ts` 那行赋值会触发 assign-to-define 警告，已在 `scripts/build-bundle.mjs` 显式静音，**不要为消警告改写赋值语法**，会让 env.test.ts 的静态断言失效）；直跑 `tsx src/cli.ts`（仅开发调试）靠不设即默认 development。

## 文档规范

- 用户文档放 `docs/zh/` + `docs/en/`（功能说明、快捷键、命令参考、配置说明），中英双份同步。
- 本文件是**源码仓的工程纪律文件**，只放「在本仓写代码需要遵守的约束」。设计决策、复盘记录、协议实测数据、内部迭代流水账不放这里。
- 写面向用户的文档时，只描述本项目自身设计意图，不参照、不提及其他产品。

## 并发开发纪律（多终端并行，必读）

本仓常有多个终端 / 多个 agent 会话同时开工。工作区是共享的，你看到的未提交改动**不一定是你的**。

1. **四个禁用命令**：`git stash`、`git switch`、`git checkout <分支>` / `git checkout .`、`git reset --hard` 作用于整个工作区，会把他人在途改动一并卷走。`git stash push <单个文件>` 同样不是文件级操作，首选是根本不用。
2. **跑验证不动工作区状态**：绕开某个文件的问题时单跑目标测试（`npx vitest run <file>`，vitest 按需编译，无关文件有问题不影响），不隔离、不 stash。只有准备提交前才跑全量 `pnpm typecheck` + `pnpm test`。
3. **全量 tsc 的报错不一定是别人的**：它同时编译他人在途半成品和你自己上一步的中间态。按顺序排除：是不是我刚编辑到一半 → `git diff <file>` 看归属 → 单独编译确认 → 确认是他人问题就**记录并告知，不替他修、不隔离**。
4. **提交只提自己的**：禁用 `git add -A` / `git commit -a`，逐文件 add，提交前 `git status` 核对清单里没有他人文件。
5. **需要长期隔离才开 worktree**：worktree 用于开工前就知道要长期并行的场景（`git worktree add ../<工作区名> -b wt/<名字>`），改动铺开后再建是负收益。

一句话教训：**先确认报错是不是自己造成的，再考虑动手；诊断没坐实之前，不对共享工作区做任何状态变更。**

## 当前能力边界

已实现：工具循环 + 错误回灌、权限系统（manual/auto/yolo + 审批）、计划模式（`/plan`）、Esc 中断、指数退避重试（`Retry-After` 优先 + 并行子 agent 429 重排队）、prompt cache 注入、会话持久化（`--continue`/`--session`/`--resume`/`--fork`）、上下文压缩（micro/full 两级 + `/compact`）、斜杠命令与补全、`--output-format stream-json`、联网搜索、markdown 终端渲染、图片粘贴（Alt+V）、thinking 过程呈现、子 agent（内置 + `.step-code/agents/*.md` 自定义）、并行工具执行、动态工作流（模型写 JS 编排子 agent）、任务清单、自主目标（轮次 + token 双预算）、后台任务、定时任务、技能懒加载、插件（skills + mcpServers + hooks + 命令）、用户可配置 hooks（5 事件）、外部工具懒加载（MCP stdio）、ACP 服务端（`--acp`）、多协议 provider 与多渠道多模型、国际化（中/英）、启动期配置自检（语法错误 fail-fast + 语义警告 + 别名引用检查，与 `step doctor config` 共用规则）。

未完成 / 后续：MCP 的 http/sse transport 与 OAuth（当前仅 stdio）、流式工具调用参数逐显、长历史渲染的进一步性能优化。
