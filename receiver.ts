#!/usr/bin/env bun
/**
 * notion-channel-mcp — webhook receiver daemon
 *
 * Long-running HTTP server that:
 *   1. Handles the Notion webhook verification handshake (echoes the
 *      verification_token on the first POST to /webhook).
 *   2. Receives `comment.created` events from Notion.
 *   3. Fetches the full comment + walks its ancestry via the Notion API.
 *   4. Looks up subscribing peers in the shared SQLite store.
 *   5. Forwards each match to its stable_id via the claude-hive broker.
 *
 * Typically managed by launchd in production. Run directly for dev:
 *   bun receiver.ts
 */

import { computeStableId } from "./shared/stable-id.ts";
import { findMatchingPeers } from "./shared/db.ts";
import {
  fetchComment,
  fetchPage,
  getAncestors,
} from "./shared/notion.ts";
import {
  registerPeer,
  sendMessage,
  heartbeat,
  unregister,
  isHiveAlive,
} from "./shared/hive.ts";
import type { NotionComment, NotionPage } from "./shared/types.ts";

const PORT = parseInt(process.env.NOTION_RECEIVER_PORT ?? "8787", 10);
const HEARTBEAT_MS = 15_000;
const SUMMARY =
  "Notion webhook bridge — routes Notion comment events to subscribed peers";

let myPeerId: string | null = null;
let myStableId: string | null = null;

// --- Structured stderr logging ---

type LogLevel = "info" | "warn" | "error";

function log(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (extra) Object.assign(line, extra);
  console.error(JSON.stringify(line));
}

// --- claude-hive registration + heartbeat loop ---

async function registerWithHive(): Promise<void> {
  const cwd = process.cwd();
  myStableId = computeStableId(cwd);
  try {
    const reg = await registerPeer({
      pid: process.pid,
      cwd,
      git_root: null,
      summary: SUMMARY,
      stable_id: myStableId,
    });
    myPeerId = reg.id;
    log("info", "registered with claude-hive", {
      id: reg.id,
      stable_id: reg.stable_id,
      reclaimed: reg.reclaimed ?? false,
    });
  } catch (err) {
    log("warn", "claude-hive unavailable on startup; will retry", {
      error: String(err),
    });
  }
}

setInterval(async () => {
  if (!myPeerId) {
    if (await isHiveAlive()) {
      await registerWithHive();
    }
    return;
  }
  try {
    await heartbeat(myPeerId);
  } catch (err) {
    log("warn", "heartbeat failed; will retry on next interval", {
      error: String(err),
    });
    // If the broker forgot us, drop our cached id so the next tick re-registers.
    if (String(err).includes("404")) {
      myPeerId = null;
    }
  }
}, HEARTBEAT_MS);

// --- Webhook handler ---

interface NotionWebhookBody {
  verification_token?: string;
  type?: string;
  entity?: { id?: string; type?: string };
}

async function handleWebhook(req: Request): Promise<Response> {
  let body: NotionWebhookBody;
  try {
    body = (await req.json()) as NotionWebhookBody;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // Verification handshake: sent once when a new webhook subscription
  // is created in the Notion UI. The receiver echoes the token back so
  // Notion knows the endpoint belongs to the integration.
  if (body.verification_token) {
    log("info", "notion verification handshake", {
      token_prefix: String(body.verification_token).slice(0, 12) + "...",
    });
    return Response.json({ verification_token: body.verification_token });
  }

  const eventType = body.type ?? "";
  if (eventType !== "comment.created") {
    log("info", "ignoring non-comment event", { type: eventType });
    return new Response("ok", { status: 200 });
  }

  const commentId = body.entity?.id ?? "";
  if (!commentId) {
    return new Response("missing entity.id", { status: 400 });
  }

  // Process asynchronously so we ack Notion quickly. Notion retries on
  // 5xx, but only within a short window per POST.
  processCommentEvent(commentId).catch((err) => {
    log("error", "processCommentEvent failed", {
      comment_id: commentId,
      error: String(err),
    });
  });

  return new Response("accepted", { status: 202 });
}

async function processCommentEvent(commentId: string): Promise<void> {
  const comment = await fetchComment(commentId);
  if (!comment.page_id) {
    log("warn", "comment has no page_id; cannot route", {
      comment_id: commentId,
    });
    return;
  }

  const page = await fetchPage(comment.page_id);
  const ancestors = await getAncestors(comment.page_id);
  const matches = findMatchingPeers(comment.page_id, ancestors);

  if (matches.length === 0) {
    log("info", "no subscribers for page", {
      page_id: comment.page_id,
      page_title: page.title,
      ancestor_count: ancestors.length,
    });
    return;
  }

  if (!myPeerId) {
    log("warn", "not registered with claude-hive; dropping event", {
      page_id: comment.page_id,
      matches,
    });
    return;
  }

  log("info", "routing comment", {
    page_id: comment.page_id,
    page_title: page.title,
    commenter: comment.author_name,
    matches,
  });

  const payload = formatCommentMessage(comment, page);
  for (const peerStableId of matches) {
    try {
      await sendMessage({
        from_id: myPeerId,
        to_stable_id: peerStableId,
        text: payload,
      });
    } catch (err) {
      log("error", "send_message failed", {
        peer_stable_id: peerStableId,
        error: String(err),
      });
    }
  }
}

function formatCommentMessage(
  comment: NotionComment,
  page: NotionPage,
): string {
  // Strip dashes from the page_id to build a Notion URL slug.
  const urlId = page.id.replace(/-/g, "");
  return [
    "📝 New Notion comment",
    `Page: ${page.title}`,
    `URL: https://www.notion.so/${urlId}`,
    `Commenter: ${comment.author_name}`,
    `Time: ${comment.created_at}`,
    "",
    comment.text || "(empty comment body)",
  ].join("\n");
}

// --- HTTP server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "ok",
        peer_id: myPeerId,
        stable_id: myStableId,
        pid: process.pid,
      });
    }
    if (req.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(req);
    }
    return new Response("not found", { status: 404 });
  },
});

log("info", `receiver listening on 127.0.0.1:${PORT}`);

// Kick off claude-hive registration. Non-blocking; the heartbeat loop
// will retry if the broker is down.
void registerWithHive();

// Graceful shutdown.
async function cleanup(): Promise<void> {
  if (myPeerId) {
    try {
      await unregister(myPeerId);
    } catch {
      // best effort
    }
  }
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
