import { normalizeToolName } from "../tool-policy.js";

/** Transport prefix CLI harnesses use for loopback OpenClaw MCP tool names. */
export const OPENCLAW_MCP_TOOL_PREFIX = "mcp__openclaw__";

/** Strips the loopback MCP transport prefix so observers see gateway tool names. */
export function stripOpenClawMcpToolPrefix(toolName: string): string {
  return toolName.startsWith(OPENCLAW_MCP_TOOL_PREFIX)
    ? toolName.slice(OPENCLAW_MCP_TOOL_PREFIX.length)
    : toolName;
}

/**
 * Derives the loopback MCP grant allowlist from a selectable-backend MCP
 * permission list. Wildcards keep the full session-scoped surface; entries for
 * other MCP servers are not loopback-governed and drop out. A non-wildcard
 * list that leaves no loopback names fails closed (empty allowlist).
 */
export function resolveLoopbackToolsAllowFromMcpPermissions(
  mcp: readonly string[] | undefined,
): string[] | undefined {
  if (!mcp) {
    return undefined;
  }
  const names = new Set<string>();
  for (const entry of mcp) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*" || trimmed === `${OPENCLAW_MCP_TOOL_PREFIX}*`) {
      return undefined;
    }
    if (trimmed.startsWith("mcp__") && !trimmed.startsWith(OPENCLAW_MCP_TOOL_PREFIX)) {
      continue;
    }
    const name = normalizeToolName(stripOpenClawMcpToolPrefix(trimmed));
    if (name) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * Translates a runtime tool allowlist into the only surface a selectable CLI
 * backend can actually enforce: native tools off, loopback MCP scoped to the
 * named tools. The loopback grant bounds that list server-side, so tools
 * outside it can be neither listed nor called — unlike `--allowedTools`, which
 * is advisory under bypass permission modes. Returns undefined when the
 * allowlist cannot be expressed faithfully (empty, wildcard, or unnamed), so
 * callers fail closed instead of dropping the policy and running unrestricted.
 */
export function resolveCliToolSurfaceFromToolsAllow(
  toolsAllow: readonly string[],
): { native: []; mcp: string[] } | undefined {
  if (toolsAllow.length === 0) {
    return undefined;
  }
  const names = new Set<string>();
  for (const entry of toolsAllow) {
    const name = normalizeToolName(entry);
    if (!name || name.includes("*")) {
      return undefined;
    }
    names.add(name);
  }
  return {
    native: [],
    mcp: [...names].map((name) => `${OPENCLAW_MCP_TOOL_PREFIX}${name}`),
  };
}

/** CLI backends cannot enforce runtime caps; keep only real restrictions. */
export function resolveCliRuntimeToolsAllow(
  toolsAllow?: string[],
  toolsAllowIsDefault?: boolean,
): string[] | undefined {
  if (toolsAllow === undefined || toolsAllowIsDefault) {
    return undefined;
  }
  return toolsAllow.some((toolName) => normalizeToolName(toolName) === "*")
    ? undefined
    : toolsAllow;
}
