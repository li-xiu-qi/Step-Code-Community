import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildSkillRegistry, skillListing, type SkillRegistry } from '../skill/registry.js';
import { McpManager, mcpInputSchemaToZod, type McpServerConfig } from '../mcp/manager.js';
import type { DeferredTool } from '../agent/toolSearch.js';
import type { ToolSearchRegistry } from '../tools/toolSearch.js';
import type { StepCodeConfig } from '../config/config.js';
import { registerDynamicTool } from '../tools/index.js';

/**
 * ACP 模式的运行时组合：skill 注册表 + MCP 接入。
 *
 * 背景：ACP 分支原先只带 config/provider/store 启动，system prompt 不拼 skill 清单、
 * ToolContext 不带 skills/toolSearch，导致模型既看不到领域 skill 也发现不了 MCP 工具
 * （tool_search 恒回报「懒加载未配置」）。嵌入式驱动方（如 HearSight 问答 agent）
 * 依赖这两条链路，故在此显式组合。
 *
 * 与 TUI 组合根的差异（有意为之，范围最小）：不并入 plugin 贡献的 skill/MCP。
 * 嵌入式场景的 skill 与 MCP 来自工作区目录（cwd 相对 + mcp.json），无需插件面。
 */

export interface AcpRuntime {
  /** skill 注册表（供 skill 工具激活与 system prompt 清单） */
  skills: SkillRegistry;
  /** 拼在 buildSystemPrompt 之后的 skill 清单段；无 skill 时为空串。 */
  skillSection: string;
  /** tool_search 的 deferred 注册表与加载回调（MCP 工具经此发现）。 */
  toolSearch: ToolSearchRegistry;
  /** 进程退出前调用：等后台连接收尾并断开全部 MCP server，避免 stdio 子进程泄漏。 */
  close: () => Promise<void>;
}

/** 读 ~/.step-code/mcp.json 的 mcpServers 表（HOME 派生；读取失败不抛，返回空表）。 */
function readMcpServerConfigs(): Record<string, McpServerConfig> {
  try {
    const mcpPath = join(homedir(), '.step-code', 'mcp.json');
    if (!existsSync(mcpPath)) return {};
    const parsed = JSON.parse(readFileSync(mcpPath, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

export async function composeAcpRuntime(config: StepCodeConfig, cwd: string): Promise<AcpRuntime> {
  const skills = buildSkillRegistry(cwd, [], config.extraSkillDirs, config.disabledSkills);
  const skillSection = skillListing(skills, config.skillListingBudget);

  const manager = new McpManager();
  const deferred: DeferredTool[] = [];
  const registerMcpTool = (tool: { qualifiedName: string; description: string; inputSchema: unknown }): void => {
    registerDynamicTool({
      name: tool.qualifiedName,
      description: tool.description,
      schema: mcpInputSchemaToZod(tool.inputSchema),
      execute: async (input) => {
        const r = await manager.callTool(tool.qualifiedName, input as Record<string, unknown>);
        return { content: r.content, isError: r.isError, images: r.images };
      },
    });
  };
  const toolSearch: ToolSearchRegistry = {
    deferred,
    load: (names) => {
      for (const n of names) {
        const found = manager.find(n);
        if (found === undefined) continue;
        registerMcpTool(found.info);
      }
    },
  };

  // 并行连接并等全部收尾（单点失败隔离，每 server 启动超时见 mcp.json）。
  // 这里必须 await：否则首个 session/prompt 的 tool_search 可能在 server 连上前
  // 执行，deferred 还是空的，模型第一轮就发现不了工具。本地 stdio server 连接
  // 在百毫秒级，等待成本可忽略；卡死的 server 由 startupTimeoutMs 兜底。
  const configs = readMcpServerConfigs();
  await manager
    .connectAll(configs, (serverName) => {
      for (const tool of manager.toolsOf(serverName)) {
        deferred.push({
          name: tool.qualifiedName,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    })
    .catch(() => {});

  // 嵌入式驱动方信号：enabled_tools 非空 = 调用方已显式声明工具契约。此时白名单内的
  // MCP 工具直接注册，不等 tool_search 发现——省一轮慢速往返（本地模型一轮几十秒），
  // 也避免模型漏走发现步骤。未配白名单（TUI/IDE 常规路径）保持 deferred 原样。
  if (config.enabledTools !== undefined && config.enabledTools.length > 0) {
    for (const tool of manager.allTools()) {
      if (config.enabledTools.includes(tool.qualifiedName)) registerMcpTool(tool);
    }
  }

  return {
    skills,
    skillSection,
    toolSearch,
    close: async () => {
      await manager.closeAll();
    },
  };
}
