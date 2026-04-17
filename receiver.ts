#!/usr/bin/env bun
/**
 * notion-channel-mcp — webhook receiver
 *
 * HTTP server that:
 *   1. Handles the Notion webhook verification handshake.
 *   2. Receives comment and page events from Notion.
 *   3. For each event, resolves the page_id, walks ancestry, and finds
 *      subscribing peers via the shared SQLite store.
 *   4. Forwards formatted events to each match via the claude-hive broker.
 *
 * Lifecycle: singleton. The per-session MCP server spawns this on first
 * use; subsequent sessions detect it's already running via /health and
 * skip the spawn. If the port is already bound, this process exits 0
 * quietly — that means another instance won the race.
 *
 * Run directly for dev: `bun receiver.ts`
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
  "Notion webhook bridge — routes Notion comment and page events to subscribed peers";
// Consistent stable_id regardless of which session spawned the receiver.
const RECEIVER_CWD = import.meta.dir;

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

// --- Pre-flight singleton check ---

async function anotherInstanceAlreadyRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) {
      const body = (await res.json()) as { status?: string };
      return body.status === "ok";
    }
  } catch {
    // fetch failed — nobody listening, we're free to bind
  }
  return false;
}

if (await anotherInstanceAlreadyRunning()) {
  log("info", "another receiver instance is already running; exiting", {
    port: PORT,
  });
  process.exit(0);
}

// --- claude-hive registration + heartbeat loop ---

async function registerWithHive(): Promise<void> {
  myStableId = computeStableId(RECEIVER_CWD);
  try {
    const reg = await registerPeer({
      pid: process.pid,
      cwd: RECEIVER_CWD,
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
    if (String(err).includes("404")) {
      myPeerId = null;
    }
  }
}, HEARTBEAT_MS);

// --- Event handling ---

interface NotionWebhookEntity {
  id?: string;
  type?: string;
}

interface NotionWebhookBody {
  verification_token?: string;
  type?: string;
  entity?: NotionWebhookEntity;
  data?: Record<string, unknown>;
}

async function handleWebhook(req: Request): Promise<Response> {
  let body: NotionWebhookBody;
  try {
    body = (await req.json()) as NotionWebhookBody;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // Verification handshake — Notion POSTs this once when creating a subscription.
  if (body.verification_token) {
    log("info", "notion verification handshake", {
      verification_token: String(body.verification_token),
    });
    return Response.json({ verification_token: body.verification_token });
  }

  const eventType = body.type ?? "";
  const entityType = body.entity?.type ?? "";
  const entityId = body.entity?.id ?? "";

  if (!eventType || !entityId) {
    log("warn", "webhook missing type or entity.id", { body });
    return new Response("missing fields", { status: 400 });
  }

  // Ack fast; process asynchronously.
  processEvent(eventType, entityType, entityId, body).catch((err) => {
    log("error", "processEvent failed", {
      event_type: eventType,
      entity_id: entityId,
      error: String(err),
    });
  });

  return new Response("accepted", { status: 202 });
}

async function processEvent(
  eventType: string,
  entityType: string,
  entityId: string,
  body: NotionWebhookBody,
): Promise<void> {
  // Resolve the page_id this event is about.
  // - For comment events: fetch the comment (or use body.data for deletes).
  // - For page events: the entity IS the page.
  let pageId: string;
  let comment: NotionComment | null = null;

  if (eventType.startsWith("comment.")) {
    if (eventType === "comment.deleted") {
      // Deleted comments can't be fetched. Notion includes page_id in data.
      pageId = String(
        (body.data as { parent?: { page_id?: string } } | undefined)?.parent
          ?.page_id ?? "",
      );
      if (!pageId) {
        log("info", "comment.deleted has no page_id; cannot route", {
          comment_id: entityId,
        });
        return;
      }
    } else {
      try {
        comment = await fetchComment(entityId);
      } catch (err) {
        log("warn", "failed to fetch comment; cannot route", {
          comment_id: entityId,
          error: String(err),
        });
        return;
      }
      pageId = comment.page_id;
    }
  } else if (eventType.startsWith("page.")) {
    pageId = entityId;
  } else {
    log("info", "unhandled event type; skipping", { event_type: eventType });
    return;
  }

  if (!pageId) {
    log("warn", "could not resolve page_id", {
      event_type: eventType,
      entity_id: entityId,
    });
    return;
  }

  // Best-effort: fetch page for title. For deletes this may fail.
  let page: NotionPage | null = null;
  try {
    page = await fetchPage(pageId);
  } catch {
    // Page may be deleted/inaccessible — keep going with just the ID.
  }

  // Best-effort: walk ancestry for subtree matching.
  let ancestors: string[] = [];
  try {
    ancestors = await getAncestors(pageId);
  } catch {
    // OK — direct subscribers will still match via pageId.
  }

  const matches = findMatchingPeers(pageId, ancestors);

  if (matches.length === 0) {
    log("info", "no subscribers for event", {
      event_type: eventType,
      page_id: pageId,
      page_title: page?.title,
      ancestor_count: ancestors.length,
    });
    return;
  }

  if (!myPeerId) {
    log("warn", "not registered with claude-hive; dropping event", {
      event_type: eventType,
      page_id: pageId,
      matches,
    });
    return;
  }

  log("info", "routing event", {
    event_type: eventType,
    page_id: pageId,
    page_title: page?.title,
    matches,
  });

  const payload = formatEventMessage(eventType, pageId, page, comment);
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

function formatEventMessage(
  eventType: string,
  pageId: string,
  page: NotionPage | null,
  comment: NotionComment | null,
): string {
  const urlId = pageId.replace(/-/g, "");
  const url = `https://www.notion.so/${urlId}`;
  const title = page?.title ?? "(unknown page)";

  if (eventType.startsWith("comment.")) {
    const header =
      eventType === "comment.created"
        ? "💬 Notion comment"
        : eventType === "comment.updated"
          ? "✏️ Notion comment updated"
          : "🗑️ Notion comment deleted";
    const lines = [header, `Page: ${title}`, `URL: ${url}`];
    if (comment) {
      lines.push(`Commenter: ${comment.author_name}`);
      lines.push(`Time: ${comment.created_at}`);
      lines.push("");
      lines.push(comment.text || "(empty comment body)");
    } else if (eventType === "comment.deleted") {
      lines.push("(comment deleted — body unavailable)");
    }
    return lines.join("\n");
  }

  // Page event
  const emoji = pageEmoji(eventType);
  const label = pageLabel(eventType);
  return [`${emoji} Notion page ${label}`, `Page: ${title}`, `URL: ${url}`].join(
    "\n",
  );
}

function pageEmoji(eventType: string): string {
  if (eventType === "page.created") return "🆕";
  if (eventType === "page.deleted") return "🗑️";
  if (eventType === "page.undeleted") return "♻️";
  if (eventType === "page.moved") return "📦";
  if (eventType === "page.locked") return "🔒";
  if (eventType === "page.unlocked") return "🔓";
  if (eventType === "page.content_updated") return "📝";
  if (eventType === "page.properties_updated") return "🏷️";
  return "📄";
}

function pageLabel(eventType: string): string {
  return eventType.replace(/^page\./, "").replace(/_/g, " ");
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

void registerWithHive();

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
