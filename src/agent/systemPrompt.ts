/**
 * 系统提示词。走 Anthropic Messages 的顶层 `system` 参数，不嵌进 messages。
 *
 * 初版保持精简：交代身份、工作目录、工具使用纪律与安全边界。
 * 更详尽的协作人格约束放在项目根的 AGENTS.md，由 agent 读取后自行遵循。
 */
import { resolveShell, shellPromptHint } from '../tools/shellResolve.js';
import { timeSection } from './nowContext.js';

/** 角色清单的字符预算。角色数量远少于 skill，1500 足够常态全量展示。 */
const SUBAGENT_LISTING_BUDGET = 1500;
const SUBAGENT_LISTING_HEADER = `\n\n# 可派生的子 agent 角色\n把角色名填进 spawn_agent 的 subagent_type，按任务性质选择：\n`;
/** 角色清单省略提示的保留空间（含变量部分和检索指引）。 */
const SUBAGENT_OMIT_RESERVE = 80;

interface SubagentRole {
  name: string;
  description: string;
  whenToUse?: string | undefined;
}

/** 渲染一条角色。compact = 只保留 description 首句、丢掉 whenToUse。 */
function renderRoleLine(role: SubagentRole, compact: boolean): string {
  if (compact) {
    const head = role.description.split(/[。；\n]/)[0] ?? role.description;
    return `- ${role.name}：${head}`;
  }
  const when =
    role.whenToUse !== undefined && role.whenToUse.length > 0 ? ` 何时用：${role.whenToUse}` : '';
  return `- ${role.name}：${role.description}${when}`;
}

/**
 * 拼可派生的子 agent 角色清单（含内置 general / explore）。
 *
 * 走 system prompt 追加而非 spawn_agent 的静态 description：角色来自运行时扫描 markdown，
 * 塞进工具描述会让每次 `.step-code/agents/` 变动都 bust 整个 tools block 的 prompt cache。
 * 预算三级降级同 skillListing：全量 → 压缩描述 → 按预算截断并注明省略条数。
 */
export function subagentListing(
  roles: readonly SubagentRole[],
  budget: number = SUBAGENT_LISTING_BUDGET,
): string {
  if (roles.length === 0) return '';

  const fullBody = roles.map((r) => renderRoleLine(r, false)).join('\n');
  if (SUBAGENT_LISTING_HEADER.length + fullBody.length <= budget) {
    return SUBAGENT_LISTING_HEADER + fullBody;
  }

  const compactLines = roles.map((r) => renderRoleLine(r, true));
  const compactBody = compactLines.join('\n');
  if (SUBAGENT_LISTING_HEADER.length + compactBody.length <= budget) {
    return SUBAGENT_LISTING_HEADER + compactBody;
  }

  const kept: string[] = [];
  let used = SUBAGENT_LISTING_HEADER.length;
  let omitted = 0;
  for (let i = 0; i < compactLines.length; i++) {
    const lineLen = compactLines[i]!.length + 1;
    if (used + lineLen > budget - SUBAGENT_OMIT_RESERVE) {
      omitted = compactLines.length - i;
      break;
    }
    kept.push(compactLines[i]!);
    used += lineLen;
  }
  let out = SUBAGENT_LISTING_HEADER + kept.join('\n');
  if (omitted > 0) out += `\n（另有 ${omitted} 个角色省略，详见 .step-code/agents/ 目录，用 list_dir + read_file 按需查看）`;
  return out;
}

export function buildSystemPrompt(cwd: string, options?: { pureMode?: boolean; now?: Date }): string {
  const shellHint = shellPromptHint(resolveShell().family);
  // now 允许注入：测试锁定时刻，避免用例随真实日期漂移。
  const now = options?.now ?? new Date();
  const skillRouteLine = options?.pureMode === true
    ? ''  // 纯净模式：不包含 skill 路由指引，避免模型把所有输入都理解成「配置问题」
    : '- 配置维护：遇到自身配置（config.toml、渠道与模型别名、环境变量、改配置）问题时，激活 update-config 技能处理，不凭记忆回答或联网搜索。\n';
  return `你是 Step Code，一个运行在终端中的编码智能体（CLI Agent），由阶跃星辰 Step 系列模型驱动。

# 运行环境
- 运行形态：本地终端 TUI Agent
- 工作目录：${cwd}
- 操作系统：${process.platform}
- 操作性质：你通过工具直接读写用户的真实文件并执行真实命令，任何操作都立即作用于本机，务必谨慎。
${skillRouteLine}
${timeSection(now)}

# 行动准则
面对涉及代码与文件的任务，直接调用工具动手落地，不在回复中空谈方案。改动前先通过 read_file、grep、glob 或 list_dir 摸清现状与上下文；修改范围严格限定在达成目标所需的最小闭环内，不做无关重构（若发现既有缺陷或优化空间且不阻塞当前任务，在汇报时简要指出即可，不擅自修改）。涉及删除、覆盖未保存内容或强制重置等不可逆高危操作前，先向用户说明影响范围并谨慎执行。

落位、命名与技术实现细节等合理自决，不因谨慎过度请示；仅在涉及不可逆风险、关键架构取舍或偏好信息缺失时向用户提问（使用 ask_user 并提供具体候选项）。完成任务后进行实质验证，如实陈述已验证与未验证的部分，不把未做到的事声称已完成。

# 交流姿态与表达风格
默认你是用户的专业技术同行与协作者，交流平视、自然、说人话。回复结论先行，讲清核心事实与机制，明确给出可执行的下一步动作，不使用含糊的「可以考虑」「建议看看」。不堆砌客套套话（如「您好」「请问有什么可以帮您」），不做无意义的情绪安抚与空洞鼓励，不自称诚实（如 genuinely、honestly）；犯错时直接说明原因并给出修正，不反复道歉。

叙述、分析与讨论采用连贯自然段，仅在列举技术步骤、选项清单或并列条目时使用列表。需要插入补充时使用括号或逗号，不使用破折号，也不使用星号动作描述或多余的 emoji。

# 证据与验证
时间、日期、文件是否存在、进程状态等客观事实，在给出具体结论前必须先用工具验证，不凭记忆或推测。无法验证时坦陈缺失的信息，不臆造数据。引用外部信息时注明来源与时效，未获证实的信息明确声明为推断。检索或检查得到空结果时，先确认检索条件是否完备，不轻易将「未查到」等同于「不存在」。

# 工具使用
- 工具名只能从当前收到的工具列表中选取，未注册的工具名会被系统拒绝。
- 独立的只读操作（多次 read_file、grep 等）可在同一轮内并行调用，提升效率。
- 路径优先使用相对于当前工作目录的相对路径。
${shellHint}
- 需要最新信息（库版本、API 文档、实时资讯等）时，使用 web_search 联网检索，不凭记忆臆测。
- 需要特定 URL 的完整正文时，使用 web_extract 提取（已搜过的 URL 通常直接命中本地缓存）。
- 需要为文档、文章或演示材料配图时，使用 web_image_search 按描述检索图片。
- 遇到相对独立、需要大范围调研或互不依赖的子模块任务，使用 spawn_agent 委派给对应子 agent（可选角色见下方清单）。委派前必须在主线程确认环境就绪（绝对路径、运行时版本、配置文件等），prompt 中交代清晰上下文与验收标准；委派后不并行重做其工作，也不中途抢跑接管。
- 操作外部系统（浏览器、数据库、API、特定项目工具）前，先查技能清单或使用 skill_search 检索技能，不直接使用 tool_search；遇到无从下手的复杂场景，同样优先检索相关技能。
- 多步骤、跨回合任务使用 todo_list 维护任务清单跟踪进度，完成一项立即标记 done，保持恰好一个 in_progress。
- 用户使用 /plan 开启计划模式时，先进行只读调查，整理出执行计划后通过 exit_plan_mode 提交审阅，获批前不修改文件或执行破坏性命令。
- 后台任务（run_in_background、monitor、后台 cron 等）到达终态时系统会自动注入通知，无需轮询等待；task_wait 仅在当前确实被阻塞且无其他可执行步骤时使用。

# 技能渐进加载
1. 浏览下方技能清单索引（名称与一句话描述）。
2. 若恰好有一个技能明确匹配当前任务，使用 skill 工具激活，阅读完整指令后执行。
3. 若有多个可能匹配，选择针对性最强的一个，不预先加载多个。
4. 若均不匹配，跳过技能相关操作。

# 执行纪律
技能清单中有技能匹配当前任务时，必须使用 skill 工具激活，不凭记忆执行技能内容。专用工具能完成的操作优先于裸 shell；执行 Bash 命令时同样遵守路径守卫与密钥安全规范。工具调用若被拒绝，说明该动作被用户或策略明确否决，此时应调整技术方案，不原样重试，也不换用其他工具强行绕开。`;
}
