import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from '../../src/skill/builtin/index.js';
import { UPDATE_CONFIG_SKILL } from '../../src/skill/builtin/updateConfig.js';
import { STEP_CODE_SKILL } from '../../src/skill/builtin/stepCode.js';
import { buildSkillRegistry, renderSkillActivation, skillListing } from '../../src/skill/registry.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-builtin-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SHADOW_MD = `---\nname: update-config\ndescription: 项目自定义版\n---\n项目自定义正文。`;

describe('builtin skill 注册', () => {
  it('update-config 以 builtin 来源进注册表', () => {
    const reg = buildSkillRegistry(dir);
    const def = reg.skills.get('update-config');
    expect(def).toBeDefined();
    expect(def!.source).toBe('builtin');
    expect(def!.dir).toBe('builtin://update-config');
  });

  it('builtin 优先级最低：项目级同名 skill shadow 并记入冲突', () => {
    const shadowDir = join(dir, '.step-code', 'skills', 'update-config');
    mkdirSync(shadowDir, { recursive: true });
    writeFileSync(join(shadowDir, 'SKILL.md'), SHADOW_MD);
    const reg = buildSkillRegistry(dir);
    expect(reg.skills.get('update-config')!.source).toBe('project');
    const conflict = reg.conflicts?.find((c) => c.name === 'update-config');
    expect(conflict).toBeDefined();
    expect(conflict!.overridden.map((d) => d.source)).toContain('builtin');
  });

  it('disabledSkills 按名排除对 builtin 同样生效', () => {
    const reg = buildSkillRegistry(dir, [], [], ['update-config']);
    expect(reg.skills.has('update-config')).toBe(false);
  });

  it('清单含 update-config 但不含正文（懒加载）', () => {
    const reg = buildSkillRegistry(dir);
    const listing = skillListing(reg);
    expect(listing).toContain('update-config');
    expect(listing).not.toContain('配置根定位');
  });

  it('激活渲染注入正文', () => {
    const rendered = renderSkillActivation(UPDATE_CONFIG_SKILL, '');
    expect(rendered).toContain('<step-skill-loaded name="update-config" source="builtin">');
    expect(rendered).toContain('变更协议');
    expect(rendered).toContain('step doctor config');
  });

  it('内置 stepCode skill 提到子 agent 管理四件套与 trace 导出', () => {
    // 内置 skill 是主控了解自身能力的入口。漏提一个工具，主控就不知道它存在——
    // 新增工具后必须同步这里，否则「实现了但没人用」。
    expect(STEP_CODE_SKILL.content).toContain('subagent_list');
    expect(STEP_CODE_SKILL.content).toContain('subagent_trace');
    expect(STEP_CODE_SKILL.content).toContain('subagent_trace_export');
    expect(STEP_CODE_SKILL.content).toContain('spawn_agent');
  });

  it('BUILTIN_SKILLS 清单即当前全部内置 skill', () => {
    expect(BUILTIN_SKILLS.map((s) => s.name)).toEqual([
      'update-config',
      'team',
      'step-code',
      'subagent-authoring',
    ]);
  });
});

describe('step-code 内置 skill 正文', () => {
  const body = BUILTIN_SKILLS.find((s) => s.name === 'step-code')!.content;

  it('正文覆盖四类关键事实', () => {
    expect(body).toContain('read_file');
    expect(body).toContain('dynamic_workflow');
    // 六个 hook 事件全列
    for (const ev of ['PreToolUse', 'PostToolUse', 'PreOutput', 'Stop', 'UserPromptSubmit', 'SessionStart']) {
      expect(body).toContain(ev);
    }
    // 工具与命令条数
    expect(body).toContain('38 个');
    expect(body).toContain('37 个');
  });

  it('写明 busy 三分流（即时 / 排队 / 直接拒绝）', () => {
    expect(body).toContain('即时执行');
    expect(body).toContain('排队到回合边界');
    expect(body).toContain('忙碌时直接拒绝');
  });

  it('写明 dynamic_workflow 并行反模式', () => {
    expect(body).toContain('parallel');
    expect(body).toContain('顺序逐个 await');
  });

  it('正文不含反引号（模板字符串冲突）', () => {
    expect(body).not.toContain('`');
  });
});

describe('subagent-authoring 内置 skill 正文', () => {
  const body = BUILTIN_SKILLS.find((s) => s.name === 'subagent-authoring')!.content;

  it('覆盖八个 frontmatter 字段', () => {
    for (const f of ['description', 'whenToUse', 'tools', 'model', 'maxSteps', 'skills', 'disabledSkills', 'standby']) {
      expect(body).toContain(f);
    }
  });

  it('写明 skill 过滤的先后语义', () => {
    expect(body).toContain('先排除再启用');
  });

  it('写明 fork 必须同源的约束', () => {
    expect(body).toContain('fork');
    expect(body).toContain('prompt cache');
  });

  it('写明 standby 的 TTL', () => {
    expect(body).toContain('30 分钟');
  });

  it('正文不含反引号（模板字符串冲突）', () => {
    expect(body).not.toContain('`');
  });
});
