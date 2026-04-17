#!/usr/bin/env bun
/**
 * notion-channel-mcp — per-session MCP stdio server
 *
 * Spawned once per Claude Code session via `claude mcp add`. Exposes
 * three tools that let the calling agent subscribe to Notion pages
 * and subtrees:
 *
 *   - notion_watch_page(page_id, include_descendants)
 *   - notion_unwatch_page(page_id)
 *   - notion_list_my_watches()
 *
 * Subscriptions are written directly to the shared SQLite store; the
 * receiver reads the same store when webhook events arrive. The MCP
 * server does not talk to the receiver over HTTP — it just writes to
 * the database.
 *
 * Receiver lifecycle: on startup, this MCP server checks whether the
 * receiver is already running (/health on the configured port). If not,
 * it spawns the receiver as a detached background process. The receiver
 * has a singleton guard — only one instance binds the port. When this
 * MCP server exits, the receiver keeps running (it's shared across all
 * sessions).
 *
 * The owning peer's stable_id is computed from this process's cwd,
 * which is inherited from the parent Claude Code session. It matches
 * the stable_id claude-hive derives for that same session.
 */

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { computeStableId } from "./shared/stable-id.ts";
import {
  addSubscription,
  removeSubscription,
  listSubscriptionsFor,
} from "./shared/db.ts";

const myStableId = computeStableId(process.cwd());
const RECEIVER_PORT = parseInt(process.env.NOTION_RECEIVER_PORT ?? "8787", 10);
const RECEIVER_DIR = import.meta.dir;
const RECEIVER_LOG = join(
  homedir(),
  "Library/Logs/notion-channel-receiver.log",
);

function log(msg: string, extra?: Record<string, unknown>): void {
  // Only stderr for MCP stdio servers; stdout is the JSON-RPC channel.
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    msg,
  };
  if (extra) Object.assign(line, extra);
  console.error(`[notion-channel-mcp] ${JSON.stringify(line)}`);
}

log("starting", { cwd: process.cwd(), stable_id: myStableId });

// --- Ensure the receiver is running ---

async function receiverIsHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${RECEIVER_PORT}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

async function ensureReceiver(): Promise<void> {
  if (await receiverIsHealthy()) {
    log("receiver already running");
    return;
  }
  log("spawning receiver");
  // Open the log file once and hand the descriptor to the child so logs
  // persist after we exit.
  const fd = openSync(RECEIVER_LOG, "a");
  const child = spawn(
    process.execPath, // current bun binary
    ["run", join(RECEIVER_DIR, "receiver.ts")],
    {
      cwd: RECEIVER_DIR,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env },
    },
  );
  child.unref();
  // Give it a moment to bind the port before the first tool call lands.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await receiverIsHealthy()) {
      log("receiver ready", { pid: child.pid });
      return;
    }
  }
  log("receiver did not become healthy within 2s — check log", {
    log_path: RECEIVER_LOG,
  });
}

// Fire-and-forget: don't block MCP startup on receiver spawn. The
// subscription tools only write to SQLite, which doesn't need the
// receiver. Events will flow as soon as the receiver binds.
void ensureReceiver();

const mcp = new Server(
  { name: "notion-channel", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions: `You have access to the notion-channel tools. Use them to subscribe to Notion pages whose comments you want to see as channel events.

- On startup, if your workspace has a canonical parent page you're responsible for (e.g., a "Drafts" parent for blog work, a "CRM" parent for contact management, a weekly-plans parent for the conductor), call \`notion_watch_page\` once with \`include_descendants: true\` so you automatically receive comments on all descendants — including ones you haven't created yet.
- When you create a new page that sits outside your canonical parent but is still your responsibility, call \`notion_watch_page\` on that page with \`include_descendants: false\`.
- Subscriptions persist across session restarts (they're keyed on your workspace stable_id), so you don't have to re-subscribe every session. Use \`notion_list_my_watches\` to see your current set before adding new ones; the subscribe call is idempotent so re-adding is safe but noisy.
- Inbound Notion comments arrive as <channel source="claude-hive" ...> messages (they're routed through claude-hive by the notion-channel receiver). Treat them as peer taps — respond promptly. The message text has the page title, commenter name, timestamp, a Notion URL, and the full comment body.`,
  },
);

const TOOLS = [
  {
    name: "notion_watch_page",
    description:
      "Subscribe to Notion comments on a page, or on an entire subtree if include_descendants is true. Idempotent: calling repeatedly with the same args is safe and will just update the flag. The subscription is scoped to this session's workspace stable_id, so comments route back via claude-hive to whichever session is currently in that workspace.",
    inputSchema: {
      type: "object" as const,
      properties: {
        page_id: {
          type: "string" as const,
          description:
            "The Notion page ID. Accepts either a raw 32-char hex UUID, a dashed UUID, or a full Notion URL — the server extracts the ID.",
        },
        include_descendants: {
          type: "boolean" as const,
          description:
            "If true, also deliver comments on any descendant page. Default false.",
          default: false,
        },
      },
      required: ["page_id"],
    },
  },
  {
    name: "notion_unwatch_page",
    description:
      "Remove a subscription previously created by notion_watch_page. No-op if no matching subscription exists.",
    inputSchema: {
      type: "object" as const,
      properties: {
        page_id: {
          type: "string" as const,
          description:
            "The page_id that was subscribed. Same input formats as notion_watch_page.",
        },
      },
      required: ["page_id"],
    },
  },
  {
    name: "notion_list_my_watches",
    description:
      "List every Notion subscription for this workspace. Scoped to the calling session's stable_id.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;

  switch (name) {
    case "notion_watch_page": {
      const pageId = normalizePageId(String(a.page_id ?? ""));
      if (!pageId) return errorText("page_id is required and must be a valid Notion page UUID or URL");
      const includeDescendants = Boolean(a.include_descendants);
      addSubscription(myStableId, pageId, includeDescendants);
      log("subscribe", {
        page_id: pageId,
        include_descendants: includeDescendants,
      });
      return text(
        `Subscribed to ${pageId}${includeDescendants ? " (including descendants)" : ""}. Comments will arrive as claude-hive channel messages.`,
      );
    }

    case "notion_unwatch_page": {
      const pageId = normalizePageId(String(a.page_id ?? ""));
      if (!pageId) return errorText("page_id is required");
      const removed = removeSubscription(myStableId, pageId);
      log("unsubscribe", { page_id: pageId, removed });
      return text(
        removed
          ? `Unsubscribed from ${pageId}.`
          : `No existing subscription for ${pageId}.`,
      );
    }

    case "notion_list_my_watches": {
      const subs = listSubscriptionsFor(myStableId);
      if (subs.length === 0) {
        return text(
          `No active subscriptions for stable_id ${myStableId}. Use notion_watch_page to add one.`,
        );
      }
      const lines = subs.map(
        (s) =>
          `- ${s.page_id}${s.include_descendants ? " (subtree)" : ""} — subscribed ${s.created_at}`,
      );
      return text(
        `${subs.length} subscription(s) for stable_id ${myStableId}:\n${lines.join("\n")}`,
      );
    }

    default:
      return errorText(`Unknown tool: ${name}`);
  }
});

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errorText(s: string) {
  return {
    content: [{ type: "text" as const, text: s }],
    isError: true,
  };
}

/**
 * Accept a raw 32-char hex UUID, a dashed UUID, or a Notion URL
 * and return the dashed UUID the Notion API expects.
 */
function normalizePageId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const dashed = trimmed.match(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  );
  if (dashed) return trimmed.toLowerCase();

  // Extract the last 32-hex run; handles raw IDs and URLs like
  // https://www.notion.so/My-Page-title-<32hex>?foo=bar
  const hexMatches = trimmed.match(/[0-9a-fA-F]{32}/g);
  if (!hexMatches || hexMatches.length === 0) return null;
  const hex = hexMatches[hexMatches.length - 1].toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

await mcp.connect(new StdioServerTransport());
log("MCP connected");
