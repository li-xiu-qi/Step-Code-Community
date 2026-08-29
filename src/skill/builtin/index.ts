import type { SkillDefinition } from '../registry.js';
import { UPDATE_CONFIG_SKILL } from './updateConfig.js';
import { TEAM_SKILL } from './team.js';
import { STEP_CODE_SKILL } from './stepCode.js';
import { SUBAGENT_AUTHORING_SKILL } from './subagentAuthoring.js';

/**
 * 内置 skill 清单：随二进制分发、不依赖任何文件系统目录（正文内嵌字符串）。
 * 注册时优先级最低（最先 addAll），用户级/项目级/plugin 同名 skill 可 shadow；
 * disabled_skills 按名排除对 builtin 同样生效。
 */
export const BUILTIN_SKILLS: SkillDefinition[] = [
  UPDATE_CONFIG_SKILL,
  TEAM_SKILL,
  STEP_CODE_SKILL,
  SUBAGENT_AUTHORING_SKILL,
];
