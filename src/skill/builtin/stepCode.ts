import type { SkillDefinition } from '../registry.js';

/**
 * 内置 skill「step-code」：step-code 自身能力的事实源。
 *
 * 与 team.ts / updateConfig.ts 同风格：正文内嵌模板字符串，不读外部 .md。
 * 正文内不使用反引号与 ${ 序列（外层模板字符串冲突 + 占位符展开风险）。
 *
 * 分工：update-config 只管配置体系（config.toml / provider / 别名），本 skill 管
 * 「跑起来之后能干什么」——工具、命令、hooks、动态工作流、会话导航、后台任务。
 * 两者互补不重叠。
 */
const STEP_CODE_BODY = `# step-code：自身能力地图

当你需要调用 step-code 提供的工具、建议用户敲某个斜杠命令、或判断该用哪个机制时，
以本 skill 为事实源。**遇到不确定的能力先激活本 skill，不要凭印象回答。**

本 skill 只答「有什么、怎么选」。配置项取值见内置的 update-config skill。

---

## 一、内置工具（38 个）

按用途分组，同组内功能互斥，按场景选一个：

**文件读写**
- read_file：读文本（支持 offset/limit 分页）；read_media：读图片/视频（支持 region 局部裁剪、probe 探测尺寸）
- write_file：新建或整体覆盖；edit_file：精确字符串替换（局部修改优先用它，不要整体覆盖）
- list_dir / glob / grep：列目录、按文件名模式找、按内容正则搜

**执行**
- bash：跑 shell 命令。注意 Git Bash / WSL / PowerShell 回退链由内部解析，不要自己拼 powershell -c
- bashOutput：取长耗时 bash 的输出（配合后台任务）

**联网**
- web_search：搜公开信息（库版本、API 变更、实时资讯）
- web_extract：抓指定 URL 正文；已搜过的 URL 会命中缓存，不再发请求
- web_image_search：按描述找配图

**子 agent 与协作**
- spawn_agent：派生子 agent（可带 resume / fork / model / skills 覆盖）
- subagent_list / subagent_status / subagent_trace：列会话、看元信息、读消息正文
- session_send / session_list / session_inbox：跨会话投递与收件
- team_init / team_plan / team_spawn / team_send / team_inbox / team_status / team_merge / team_teardown：团队模式九件套（细节见内置 team skill）

**后台与定时**
- task_list / task_output / task_stop / task_wait：后台任务四件套
- cron_create / cron_list / cron_delete：定时任务
- create_goal / update_goal / set_goal_budget / get_goal：自主目标（多轮自主推进）

**交互**
- ask_user：让用户从选项里选（2-4 个选项），需要主观判断时才用
- exit_plan_mode：计划模式下提交计划等批准
- todo_list：维护多步骤任务清单，完成一项立即标 done，保持恰好一个 in_progress

**编排**
- dynamic_workflow：用 JS 脚本编排多个子 agent（parallel / pipeline / 条件分支 / 循环）
- skill / skill_search：激活技能、按关键词检索技能
- tool_search：检索外部 MCP/function 工具（当前工具集没有的能力）

---

## 二、斜杠命令（37 个）

输入以 / 开头即走命令路由。**busy 时按「是否改动当前回合依赖的状态」分两路**：

**即时执行**（只读或纯 UI）：/help、/goal、/team、/handoff、/loop、/sessions、/agents、/lang、/mcp、/plugin、/tasks、/context、/usage、/memory，以及 /model、/provider、/permission、/skill、/think 的无参查询形态。

**排队到回合边界**（改动历史/会话/模型/权限/plan）：其余全部命令。

**忙碌时直接拒绝**：/handoff、/fork、/export-debug-zip。这三个需要当前回合的运行时状态，回合结束后同样拿不到，排队无意义。

高频几个：

- /model：切换模型，无参开选择器
- /agents：列出当前会话派生的子 agent，可下钻只读回看
- /handoff <id> [追加指令]：直接续跑某个子 agent，不经过主 agent
- /history：本会话输入历史，可回退到某轮重发
- /tasks：后台任务浏览器（列表 + 输出预览 + 停止）
- /compact：手动压缩上下文
- /export-debug-zip：导出调试包（会话正文 + 脱敏配置 + 运行日志）
- /reload：热重载 config.toml

---

## 三、Hooks（6 个事件）

生命周期事件：PreToolUse、PostToolUse、PreOutput、Stop、UserPromptSubmit、SessionStart。

执行语义：shell 命令 + stdin JSON 输入。
- exit 0 放行（UserPromptSubmit / SessionStart 时 stdout 注入上下文）
- exit 2 阻断（stderr 为原因）
- 其余非零 / 超时 / 崩溃 fail-open（不阻塞）

matcher 是可选正则，匹配工具名或事件相关标识；非法正则整条跳过。

---

## 四、动态工作流（dynamic_workflow）

用一段 JS 编排多个子 agent，适合「固定批量 + 需要中间结果决定后续」的场景。

可用原语：
- agent(prompt, {schema})：派子 agent；给 schema 拿结构化输出，校验失败自动纠正重试 ≤2 次
- parallel([...])：并发 barrier，失败位返回 null 不抛错，汇总前必须 filter(Boolean)
- pipeline(items, ...stages)：每项串行过各 stage
- phase(title)：标记阶段，展示在进度面板
- budget({agents, minutes})：收紧本 run 预算，只能收紧不能放松

**反模式**：多个无依赖的 agent() 顺序逐个 await。必须用 parallel([...]) 一次并发，否则慢 N 倍。

**resume**：脚本存档后可 resume_from_run_id 重放，已成功的 agent() 瞬时返回旧结果不重烧 token。

---

## 五、会话导航：spawn / resume / fork / handoff

四者都是「在会话之间连一条边」，按控制权方向区分：

| 机制 | 控制权 | 是否新建会话 | 何时用 |
|---|---|---|---|
| spawn_agent | 主 → 子（单向向下） | 是 | 派新任务下去 |
| resume | 谁发起谁主导，可向上 | 否，同 id 续跑 | 超时恢复、断点续跑、子 agent 返回 id 后由主控续跑 |
| fork | 源会话不受影响 | 是，新 UUID | 基于已有工作另起方向，不想污染源会话 |
| /handoff | 用户 → 任意会话 | 否，本质是 resume | 用户直接接管子会话，不经主 agent |

选型判据：要另起一条不受影响的路 → fork；要模型代劳续跑 → spawn_agent 带 resume；你自己来且知道要什么 → /handoff；超时后原地恢复 → resume。

---

## 六、后台任务

bash 工具的长耗时命令可转后台。模型侧用 task_list / task_output / task_stop / task_wait 管理。

**注意通知队列**：后台任务终态会注入会话通知。历史会话 resume 时会补投上次未送达的通知，数量多时是正常现象（上次会话积累的），不是新产生的错误。

---

## 七、已知边界

**dist 错位**：当前进程加载的是启动时的代码。merge 进来的新功能（包括本 skill 的更新）在当前进程不可用，要重启才生效。判断「功能怎么没生效」时先想这一层——不是代码没写好，是进程还在跑旧版本。

**skill 懒加载**：本 skill 与 team、update-config 一样是内置的，但正文只在激活时注入上下文，不在启动时预加载。需要用了才激活，不要预先假设模型已经知道全部内容。

**MCP / plugin 工具**：外部工具通过 tool_search 懒加载命中，不在内置 38 个之内。
`;

/**
 * 内置 skill 定义。
 */
export const STEP_CODE_SKILL: SkillDefinition = {
  name: 'step-code',
  description:
    'step-code 自身能力的事实源地图。覆盖：38 个内置工具的分组与选型（文件读写 / 执行 / 联网 / 子 agent / 后台定时 / 交互 / 编排）、37 个斜杠命令及 busy 时的两路分流（即时执行 vs 排队 vs 直接拒绝）、6 个 hook 生命周期事件与 exit code 语义、dynamic_workflow 的原语与反模式（并行必须 parallel 不得顺序 await）、会话导航四原语（spawn / resume / fork / handoff）的选型判据、后台任务通知队列机制。当模型需要调用 step-code 提供的工具、建议用户敲斜杠命令、判断该用哪个机制、或遇到「这个功能怎么没生效」的排查时，必须先读取本 skill。不涉及 config.toml / provider / 别名的取值（那归内置的 update-config skill）。',
  content: STEP_CODE_BODY,
  dir: 'builtin://step-code',
  source: 'builtin',
};
