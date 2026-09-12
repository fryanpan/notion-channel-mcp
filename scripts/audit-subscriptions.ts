/**
 * Audit — and optionally repair — subscriptions filed under a stable_id that
 * no session can be reached at.
 *
 * A subscription is addressed to `computeStableId(cwd)`, which is
 * sha256(git root) truncated to 12 hex characters. Two spellings of the same
 * directory therefore produce two different addresses:
 *
 *     /Users/<me>/dev/thing          -> 66f0b18d5233
 *     /Volumes/Data/Users/<me>/dev/thing -> 8892a88c39b6
 *
 * A session registered under the second address never receives an event filed
 * against the first. Nothing reports this: the subscribe call succeeded, the
 * row exists, the receiver delivers to an address with no listener, and the
 * session sits there believing it is watching a page. Measured 2026-09-12 on
 * this database: 6 of 9 rows were undeliverable, and two *currently running*
 * projects were receiving none of their page comments.
 *
 * ── Why this is not the Sentry bridge's script ──────────────────────────────
 *
 * The sibling repair in the Sentry channel drops any row whose id is neither
 * live nor alias-fixable. That predicate is wrong for a lean fleet, where most
 * peers are *supposed* to be down: it deletes the subscriptions of legitimate
 * dormant projects, which then come back deaf with nothing saying why. That is
 * a worse failure than the one being repaired, and the same shape — a silent
 * loss that looks like normal operation.
 *
 * So liveness is never a reason to delete here. A row is dropped only when it
 * resolves to a directory you have explicitly declared is not a project, via
 * --projects-file. With no such file, nothing is dropped at all.
 *
 * ── Three states, not two ───────────────────────────────────────────────────
 *
 * "I could not resolve this id" is reported as its own verdict (hold), never
 * folded into either "fine" or "garbage". A hold is left untouched and printed
 * loudly, because an unresolvable id is the case where guessing is most
 * expensive in both directions.
 *
 * Usage:
 *
 *   bun scripts/audit-subscriptions.ts
 *   bun scripts/audit-subscriptions.ts --projects-file ~/known-projects.txt
 *   bun scripts/audit-subscriptions.ts --projects-file ~/known-projects.txt --apply
 *
 * --projects-file takes one absolute directory path per line; blank lines and
 * lines starting with # are ignored. Both spellings of a path are accepted —
 * each entry is also resolved through realpath.
 *
 * Dry run by default. --apply writes, inside a single transaction.
 */

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_PATH =
  process.env.NOTION_CHANNEL_DB ?? `${homedir()}/.notion-channel.db`;
const HIVE_URL = process.env.CLAUDE_HIVE_URL ?? "http://127.0.0.1:7900";
const APPLY = process.argv.includes("--apply");

function flagValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return v;
}

const PROJECTS_FILE = flagValue("--projects-file");

function hash(path: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(path);
  return h.digest("hex").slice(0, 12);
}

function resolve(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Every directory we can name, in both its symlinked and physical spelling,
 * so a row's hash can be traced back to a directory on disk.
 */
function candidatePaths(extraRoots: readonly string[]): string[] {
  const roots = new Set<string>([
    `${homedir()}/dev`,
    ...extraRoots.map((p) => join(p, "..")),
  ]);
  const out = new Set<string>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(root, e);
      try {
        if (!statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      out.add(p);
      const real = resolve(p);
      if (real) out.add(real);
    }
  }
  return [...out];
}

/** Declared project directories, in every spelling, or null if not supplied. */
function knownProjects(): Set<string> | null {
  if (!PROJECTS_FILE) return null;
  let text: string;
  try {
    text = readFileSync(PROJECTS_FILE.replace(/^~/, homedir()), "utf8");
  } catch (err) {
    console.error(`cannot read --projects-file ${PROJECTS_FILE}: ${err}`);
    process.exit(2);
  }
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const p = line.trim();
    if (!p || p.startsWith("#")) continue;
    const abs = p.replace(/^~/, homedir());
    out.add(abs);
    const real = resolve(abs);
    if (real) out.add(real);
  }
  return out;
}

async function livePeers(): Promise<
  Array<{ stable_id: string; cwd: string; git_root: string | null }>
> {
  const res = await fetch(`${HIVE_URL}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "machine" }),
  });
  if (!res.ok) throw new Error(`claude-hive /list-peers ${res.status}`);
  return (await res.json()) as Array<{
    stable_id: string;
    cwd: string;
    git_root: string | null;
  }>;
}

const db = new Database(DB_PATH);
const rows = db
  .query(
    "SELECT id, peer_stable_id, page_id, include_descendants FROM subscriptions ORDER BY id",
  )
  .all() as Array<{
  id: number;
  peer_stable_id: string;
  page_id: string;
  include_descendants: number;
}>;

let peers: Array<{ stable_id: string; cwd: string; git_root: string | null }>;
try {
  peers = await livePeers();
} catch (err) {
  // Liveness is an input to "keep", never to "drop", so losing it degrades the
  // report rather than endangering a row. Say so instead of proceeding quietly.
  console.error(`claude-hive unreachable (${err}) — no row will be dropped.`);
  if (APPLY) {
    console.error("refusing to --apply without the live peer list");
    process.exit(2);
  }
  peers = [];
}
const liveIds = new Set(peers.map((p) => p.stable_id));

const candidates = candidatePaths(peers.map((p) => p.cwd));

/** hash -> the directory that produced it. */
const pathOf = new Map<string, string>();
/** hash -> canonical id for the same directory, when the two differ. */
const aliasFix = new Map<string, { canonicalId: string; path: string } | null>();

for (const p of candidates) {
  const h = hash(p);
  if (!pathOf.has(h)) pathOf.set(h, p);
  const real = resolve(p);
  if (!real || real === p) continue;
  const to = hash(real);
  if (to === h) continue;
  const existing = aliasFix.get(h);
  // Two different directories mapping to one id would be a sha256 collision;
  // guard anyway so an ambiguous case is held rather than guessed.
  if (existing && existing.canonicalId !== to) aliasFix.set(h, null);
  else aliasFix.set(h, { canonicalId: to, path: real });
}

const known = knownProjects();

type Verdict =
  | "keep-live"
  | "keep-registered"
  | "remap"
  | "drop-unregistered"
  | "hold-unresolved";

const plan: Array<{
  id: number;
  page: string;
  from: string;
  to: string | null;
  where: string | null;
  verdict: Verdict;
  why: string;
}> = [];

for (const r of rows) {
  const dir = pathOf.get(r.peer_stable_id) ?? null;
  const base = { id: r.id, page: r.page_id, from: r.peer_stable_id, where: dir };

  if (liveIds.has(r.peer_stable_id)) {
    plan.push({ ...base, to: null, verdict: "keep-live", why: "a session is registered at this id right now" });
    continue;
  }

  const fix = aliasFix.get(r.peer_stable_id);
  if (fix) {
    plan.push({ ...base, to: fix.canonicalId, where: fix.path, verdict: "remap", why: "same directory, symlinked spelling" });
    continue;
  }

  if (dir && known?.has(dir)) {
    plan.push({ ...base, to: null, verdict: "keep-registered", why: "a declared project that simply is not running" });
    continue;
  }

  if (dir && known) {
    plan.push({ ...base, to: null, verdict: "drop-unregistered", why: "resolves to a directory absent from --projects-file" });
    continue;
  }

  if (!dir && known) {
    plan.push({ ...base, to: null, verdict: "drop-unregistered", why: "resolves to no directory on this machine" });
    continue;
  }

  plan.push({
    ...base,
    to: null,
    verdict: "hold-unresolved",
    why: dir ? "no --projects-file, so nothing says whether this is a project" : "resolves to no directory, and no --projects-file to judge it against",
  });
}

const count = (v: Verdict) => plan.filter((p) => p.verdict === v).length;

console.log(`db:   ${DB_PATH}`);
console.log(`hive: ${peers.length} live peer(s)`);
console.log(`list: ${PROJECTS_FILE ?? "(none — nothing will be dropped)"}`);
console.log(`rows before: ${rows.length}\n`);

for (const p of plan) {
  const arrow = p.to ? ` -> ${p.to}` : "";
  const at = p.where ? `  [${p.where}]` : "  [unresolved]";
  console.log(`  row ${String(p.id).padStart(3)}  ${p.from}${arrow}  ${p.verdict}`);
  console.log(`        page ${p.page}${at}`);
  console.log(`        ${p.why}`);
}

const remap = plan.filter((p) => p.verdict === "remap");
const drop = plan.filter((p) => p.verdict === "drop-unregistered");
const hold = plan.filter((p) => p.verdict === "hold-unresolved");

console.log(
  `\nkeep-live ${count("keep-live")}  keep-registered ${count("keep-registered")}  ` +
    `remap ${remap.length}  drop ${drop.length}  HOLD ${hold.length}`,
);

if (hold.length > 0) {
  console.log(
    `\n${hold.length} row(s) HELD — could not be judged, and were not touched.\n` +
      `This is not a clean result. Supply --projects-file so each one is either\n` +
      `a declared project that keeps its subscription, or garbage that is dropped.`,
  );
}

if (!APPLY) {
  console.log("\ndry run — pass --apply to write");
  process.exit(0);
}

db.transaction(() => {
  for (const p of remap) {
    // A row may already exist under the canonical id, and uniqueness is
    // (peer_stable_id, page_id), so collapse onto it rather than fail.
    db.run(
      "DELETE FROM subscriptions WHERE peer_stable_id = ? AND page_id = ? AND id != ?",
      [p.to!, p.page, p.id],
    );
    db.run("UPDATE subscriptions SET peer_stable_id = ? WHERE id = ?", [p.to!, p.id]);
  }
  for (const p of drop) {
    db.run("DELETE FROM subscriptions WHERE id = ?", [p.id]);
  }
})();

const after = db.query("SELECT count(*) AS c FROM subscriptions").get() as { c: number };
console.log(`\nrows after: ${after.c} (remapped ${remap.length}, dropped ${drop.length}, held ${hold.length})`);
