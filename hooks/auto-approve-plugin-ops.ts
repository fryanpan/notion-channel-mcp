#!/usr/bin/env bun
/**
 * PreToolUse hook for the notion-channel-mcp plugin.
 *
 * Auto-approves tool calls that fall inside the plugin's own surface so
 * users don't have to "Allow Claude to use <tool>" for every new MCP tool
 * the plugin ships.
 *
 * Two categories, evaluated independently:
 *
 *   1. **MCP tools published by this plugin**
 *      Tool name matches `mcp__plugin_notion-channel-mcp_notion-channel__*` → approve.
 *      Rationale: the user opted into the entire MCP surface when they ran
 *      `claude plugin install notion-channel-mcp@…`. Making them re-opt-in
 *      per tool is friction without security value — the MCP server is the
 *      trust boundary, not the individual tool names. Auto-approving here
 *      means new tools shipped in plugin updates don't require every user
 *      to re-edit `~/.claude/settings.json`.
 *
 *   2. **Bash patterns specific to the plugin's lifecycle**
 *      Narrow allowlist of dev-mode commands the plugin documents in the
 *      README / SETUP.md:
 *        - `bun server.ts` (foreground MCP server)
 *        - `bun receiver.ts` (foreground webhook receiver)
 *      Anything else falls through to Claude Code's normal prompt.
 *
 * Everything outside the plugin's domain (file writes outside the project,
 * destructive ops, third-party MCP tools, etc.) is unaffected.
 *
 * On any error (malformed payload, unexpected shape) the hook exits 0
 * with no decision so Claude Code's normal prompt fires — fail-open is
 * safer than fail-block here.
 *
 * Reference design: https://github.com/fryanpan/claude-live-feedback-plugin/pull/40
 */

type HookPayload = {
  tool_name?: string;
  tool_input?: {
    command?: string;
    [key: string]: unknown;
  };
};

type HookDecision = {
  decision?: 'approve' | 'block';
  reason?: string;
};

const MCP_PREFIX = 'mcp__plugin_notion-channel-mcp_notion-channel__';

/**
 * Anchored prefix matchers for Bash commands the plugin owns.
 * `command.startsWith(pattern)` is sufficient — these are command lines
 * Claude generates from the README's documented dev workflow, not arbitrary
 * shell. Keep the list short; surprise approvals are worse than an extra
 * prompt.
 */
const BASH_PREFIX_ALLOWLIST = [
  'bun server.ts',
  'bun receiver.ts',
  'bun run server',
  'bun run receiver',
];

function approveBash(command: string): { approve: true; reason: string } | null {
  for (const prefix of BASH_PREFIX_ALLOWLIST) {
    if (command.startsWith(prefix)) {
      return { approve: true, reason: `plugin lifecycle: ${prefix}` };
    }
  }
  return null;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(Buffer.from(chunk));
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.exit(0);
  }
  const tool = payload.tool_name;
  if (!tool) process.exit(0);

  // MCP tools owned by this plugin — auto-approve unconditionally.
  if (tool.startsWith(MCP_PREFIX)) {
    const out: HookDecision = {
      decision: 'approve',
      reason: 'notion-channel-mcp plugin MCP tool — user already opted in via plugin install',
    };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  // Bash — check against the narrow allowlist.
  if (tool === 'Bash') {
    const command = payload.tool_input?.command;
    if (typeof command !== 'string') process.exit(0);
    const decision = approveBash(command);
    if (decision) {
      const out: HookDecision = { decision: 'approve', reason: decision.reason };
      process.stdout.write(JSON.stringify(out));
    }
    // No match → exit 0 with no decision; Claude Code prompts normally.
    process.exit(0);
  }

  // Any other tool: pass through.
  process.exit(0);
}

void main();
