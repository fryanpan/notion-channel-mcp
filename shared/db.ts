/**
 * SQLite-backed subscription store.
 *
 * Both the receiver daemon and the per-session MCP server open the same
 * database file in WAL mode. Safe concurrent access: multiple readers +
 * one writer at a time, which is plenty for the expected volume
 * (dozens of events per day).
 */

import { Database } from "bun:sqlite";
import type { Subscription } from "./types.ts";

const DB_PATH =
  process.env.NOTION_CHANNEL_DB ??
  `${process.env.HOME ?? ""}/.notion-channel.db`;

export const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer_stable_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    include_descendants INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(peer_stable_id, page_id)
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_page ON subscriptions(page_id)`);

const upsertStmt = db.prepare(`
  INSERT INTO subscriptions (peer_stable_id, page_id, include_descendants, created_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(peer_stable_id, page_id) DO UPDATE SET
    include_descendants = excluded.include_descendants
`);
const deleteStmt = db.prepare(`
  DELETE FROM subscriptions WHERE peer_stable_id = ? AND page_id = ?
`);
const listByPeerStmt = db.prepare(`
  SELECT id, peer_stable_id, page_id, include_descendants, created_at
  FROM subscriptions WHERE peer_stable_id = ?
  ORDER BY created_at ASC
`);
const directMatchStmt = db.prepare(`
  SELECT DISTINCT peer_stable_id FROM subscriptions WHERE page_id = ?
`);
const subtreeMatchStmt = db.prepare(`
  SELECT DISTINCT peer_stable_id FROM subscriptions
  WHERE page_id = ? AND include_descendants = 1
`);

export function addSubscription(
  peerStableId: string,
  pageId: string,
  includeDescendants: boolean,
): void {
  upsertStmt.run(
    peerStableId,
    pageId,
    includeDescendants ? 1 : 0,
    new Date().toISOString(),
  );
}

export function removeSubscription(
  peerStableId: string,
  pageId: string,
): boolean {
  const res = deleteStmt.run(peerStableId, pageId);
  return (res.changes ?? 0) > 0;
}

export function listSubscriptionsFor(peerStableId: string): Subscription[] {
  const rows = listByPeerStmt.all(peerStableId) as Array<{
    id: number;
    peer_stable_id: string;
    page_id: string;
    include_descendants: number;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    peer_stable_id: r.peer_stable_id,
    page_id: r.page_id,
    include_descendants: r.include_descendants === 1,
    created_at: r.created_at,
  }));
}

/**
 * Given a page ID and its ancestor chain, return all peer stable_ids
 * that should receive a comment on this page.
 *
 * Direct subscribers to `pageId` always match (regardless of their
 * include_descendants flag). Subscribers to any ancestor match only if
 * they subscribed with include_descendants=true — otherwise they only
 * care about comments on the ancestor itself, not its descendants.
 */
export function findMatchingPeers(
  pageId: string,
  ancestors: string[],
): string[] {
  const set = new Set<string>();
  for (const row of directMatchStmt.all(pageId) as Array<{
    peer_stable_id: string;
  }>) {
    set.add(row.peer_stable_id);
  }
  for (const ancestor of ancestors) {
    for (const row of subtreeMatchStmt.all(ancestor) as Array<{
      peer_stable_id: string;
    }>) {
      set.add(row.peer_stable_id);
    }
  }
  return Array.from(set);
}
