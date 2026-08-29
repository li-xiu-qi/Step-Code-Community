import type { SkillDefinition } from '../registry.js';

/**
 * 内置 skill「subagent-authoring」：怎么写 .step-code/agents/*.md 子 agent 模板。
 *
 * 与 team.ts / updateConfig.ts / stepCode.ts 同风格：正文内嵌模板字符串。
 * 正文内不使用反引号与 ${ 序列。
 */
const SUBAGENT_AUTHORING_BODY = `# subagent-authoring：写子 agent 模板

当你要新建或修改 .step-code/agents/ 下的 *.md 子 agent 模板时，以本 skill 为事实源。
**先读完再动手**，不要凭印象写 frontmatter。

---

## 一、文件放哪、怎么被发现

- .step-code/agents/*.md  —— 项目级（当前工作目录）
- ~/.step-code/agents/*.md —— 用户级

每个 .md 文件是一个模板。**文件名就是角色名**（frontmatter 没写 name 时）；写了 name 则以 name 为准。

解析规则（parseAgentMarkdown）：
- 必须有 frontmatter，且含 description（非空字符串）——否则整个文件被跳过
- 正文（systemPrompt）有最小长度要求，过短视为非 agent 文件
- YAML 解析失败 → 跳过，不报错

三个内置角色始终存在，不能被覆盖：general、explore，以及派发给外部 CLI 的类型。

---

## 二、frontmatter 字段全集

| 字段 | 类型 | 必填 | 作用 |
|---|---|---|---|
| description | string | 是 | 「这个角色是什么」，进 system prompt 角色清单 |
| whenToUse / when_to_use | string | 否 | 「什么时候该选它」。两种写法都认，与 skill 命名习惯对齐 |
| tools | string[] | 否 | 工具名白名单；不写 = 全部可用（运行时会强制剔除 spawn_agent） |
| model | string | 否 | 模型覆盖；不写 = 继承父 agent 的模型 |
| maxSteps | number | 否 | 单次最大往返轮数；不写 = 用 config 的 subagent.maxSteps |
| skills | string[] | 否 | 仅启用的 skill 名列表；不写 = 全部可用 |
| disabledSkills / disabled_skills | string[] | 否 | 排除的 skill 名列表。与 skills 同时存在时**先排除再启用** |
| standby | boolean | 否 | 跑完是否进待命（见下节）。不写 = false |

模板示例：

模板示例（frontmatter + 正文）：

    ---
    description: 专职写作子 agent，按既定文风与结构产出成稿
    whenToUse: 需要产出正式成文、且对文风与结构有明确约束时
    model: water18
    skills: [cross-lingual-expression, ai-output-guide]
    disabledSkills: [dev-session, pkm-hub]
    standby: false
    ---

    你是写作子 agent。输出前必须先读 user-profile 与 ai-output-guide 两个 skill……

---

## 三、skill 过滤：先排除再启用

两个字段同时出现时，语义是**先跑 disabledSkills 减法，再跑 skills 白名单**：

disabledSkills: [a, b, c]   →   可用集 = 全部 - {a, b, c}
skills: [x, y]              →   可用集 = {x, y}
两者都有                  →   可用集 = {x, y} - 已排除的

**什么时候用哪个**：

- **继承全部能力、只禁少数** → 只写 disabledSkills。适合「基于通用角色做减法」
- **只给它某几个专项能力** → 只写 skills。适合「专职角色，多一个 skill 都是干扰」

不建议两个都写，语义容易误读。确需都写时，先想清楚减法和白名单的先后是不是你要的。

过滤发生在子 agent 启动时，影响它的 skill 懒加载清单。**不禁 skill 的代价是真实的**：正文不注入所以不占上下文，但清单变长会让模型在选择时犹豫，启动时的目录扫描也更慢。

---

## 四、模型覆盖与继承

三种指定方式，优先级从高到低：

1. spawn_agent 的 model 参数（仅当次派生生效，不写回模板）
2. 模板的 model 字段
3. 继承父 agent 的模型

**fork 模式下的硬约束**：fork 一个子会话时，必须用与源会话相同的模型。fork 全量复制历史，历史里的 assistant 消息带原模型的 thinking 块与缓存前缀，换模型会让 prompt cache 失效、thinking 块格式不兼容。主控临时指定 model 覆盖在 fork 路径上会被拒绝。

这条约束不是偏好，是缓存正确性要求。见 step-code-product-design 的 PromptCache 设计文档。

---

## 五、standby：一次性 vs 待命

不写 standby（默认 false）：跑完直接归档。适合任务型角色（探索完就结束、改完就交差）。

standby: true：跑完进待命，30 分钟无活动自动归档。待命期间：
- 出现在 /agents 列表和主控的 subagentListing 里
- 主控可以主动 handoff 过去
- 用户可以 /handoff <id> 切换进去续跑

**待命不占并发槽位**，只占列表可见性。真正在跑的才受 maxConcurrent 限制。

**什么时候用 standby**：需要多轮对话的长期协作者。典型如写作 agent（你写完让它改，改完再让它调结构）、调研 agent（先探一轮，你看了再决定往哪挖）。

**什么时候不要用**：一次性任务。待命列表越长，主控选型时的干扰越大。

---

## 六、正文（systemPrompt）怎么写

正文就是这个角色的完整 system prompt，会原样注入。写法上是普通 markdown，但有三条实际约束：

**说清边界，不只说能力**。「你是 XX 专家」没用，「你负责 XX；不做 YY；遇到 ZZ 时停下来问」才有用。角色失效最常见的原因是只声明了能力没声明边界。

**指定事实源**。如果这个角色依赖某些 skill 或文档，在正文里点名让它先读。子 agent 看不到主 agent 的上下文，你不点名它就不知道。

**不要复述通用规范**。ai-output-guide、user-profile 这类全局约束由主控的 AGENTS.md 负责，子 agent 通过继承拿到。在模板里重复写一遍，两边措辞漂移后反而制造冲突。

---

## 七、数量与可见性控制

主控能看到的子 agent 清单有预算上限（subagentListing 字节数），超出自动截断并提示去 .step-code/agents/ 按需读取。所以：

- **角色数量控制在 10 个以内**。超过之后主控选型准确率下降，且清单截断会让后面的角色完全不可见
- **description 写短**。一句话说清「是什么 + 何时用」，不要写段落
- **专用角色 > 通用角色**。一个「写作 + 绘图 + 翻译」的万能角色，不如三个各司其职的。万能角色在每个具体任务上都不如专用的准

---

## 八、写完怎么验证

1. 在 step-code 里敲 /skill reload 让技能目录重扫（子 agent 模板在回合边界也会自动检测）
2. 看 /agents 列表里有没有出现新角色，description 是否如预期
3. 真派一次看它有没有按边界行事——模板写错的代价很低，改完重启即可
`;

/**
 * 内置 skill 定义。
 */
export const SUBAGENT_AUTHORING_SKILL: SkillDefinition = {
  name: 'subagent-authoring',
  description:
    '怎么写 .step-code/agents/*.md 子 agent 模板的事实源。覆盖：文件落位与发现规则（文件名即角色名，缺 description 或正文过短整文件跳过）、frontmatter 八个字段全集（description / whenToUse 驼峰与蛇形双写法 / tools 白名单 / model 覆盖 / maxSteps / skills 白名单 / disabledSkills 排除 / standby 待命）、skill 过滤「先排除再启用」的语义与两个字段的选型、模型覆盖三层优先级与 fork 模式下必须同源的硬约束（prompt cache 正确性）、standby 待命机制（30 分钟 TTL、不占并发槽位、何时该用何时不该用）、正文 systemPrompt 的三条写法约束（声明边界不说能力、点名事实源、不复述全局规范）、数量与可见性预算控制（建议 10 个以内、description 一句话、专用角色优于万能角色）、写完如何验证。当需要新建或修改子 agent 模板、判断某能力该配给哪个角色、或排查「模板写了 standby: true 为什么不生效」时，必须先读取本 skill。',
  content: SUBAGENT_AUTHORING_BODY,
  dir: 'builtin://subagent-authoring',
  source: 'builtin',
};
