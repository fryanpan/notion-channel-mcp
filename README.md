# notion-channel-mcp

A Claude Code channel connector that bridges Notion comment webhooks into Claude Code sessions via [claude-hive](https://github.com/KevinLyxz/claude-hive-mcp).

When someone leaves a comment on a Notion page, this bridge:

1. Receives the `comment.created` webhook from Notion at a local `cloudflared` tunnel
2. Fetches the full comment via the Notion API (the webhook payload is metadata-only)
3. Walks the page's ancestry chain to support subtree subscriptions
4. Looks up which Claude Code sessions have subscribed to the page (directly or via an ancestor subtree watch)
5. Forwards the comment to each subscribed session as a `<channel source="claude-hive">` event through the claude-hive message bus

The result: Claude agents see human comments on the pages they care about in real time, without polling and without needing to be @-mentioned (which isn't possible with Notion integrations anyway — see [Notion's API docs](https://developers.notion.com/changelog/user-mentions-can-only-be-of-people)).

## Architecture

```
Notion ──webhook──▶ Cloudflare Tunnel ──▶ receiver (bun, launchd) ──▶ claude-hive broker ──▶ subscribing Claude Code session
                                                │
                                                ▼
                                         ┌──────────────┐
                                         │ SQLite       │
                                         │ subscriptions│◀── per-session MCP server writes here
                                         └──────────────┘
```

Two processes:

- **`receiver.ts`** — long-running HTTP server. Owns the `/webhook` endpoint. Registers with claude-hive as a pseudo-peer on startup so it can `POST /send-message`. Managed by launchd in production.
- **`server.ts`** — short-lived stdio MCP server. Spawned once per Claude Code session via `claude mcp add`. Exposes `notion_watch_page`, `notion_unwatch_page`, `notion_list_my_watches` tools that write directly to the shared SQLite store.

Both processes open the same database file (`~/.notion-channel.db` by default) in WAL mode for safe concurrent access.

## How agents use it

Each agent subscribes to the pages it cares about. Three modes:

- **Subtree watch** — the agent "owns" a parent page and wants comments on everything inside it. Example: blog-assistant watching "Draft Blog Posts" with `include_descendants: true`. New drafts created later are automatically covered.
- **Point watch** — the agent cares about one specific page. Example: conductor watching this week's weekly-plan page.
- **Both** — subtree watch on the canonical parent + point watches on one-off pages (source docs, external references).

Subscriptions persist across session restarts because they're keyed on the workspace's stable_id (the same `sha256(git_root || cwd)[:12]` claude-hive uses). When a session restarts in the same workspace, its subscriptions are still there — no need to re-subscribe.

## Setup

See [SETUP.md](SETUP.md) for the end-to-end install walk-through.

## Status

v0.1.0 — minimum workable version. Working today:

- Receiver daemon with Notion verification handshake + comment routing
- SQLite subscription store with subtree-aware matching
- MCP tools for per-agent subscribe / unsubscribe / list
- Normalized page_id input (accepts raw UUID, dashed UUID, or Notion URL)
- Structured JSON logging on stderr

Not yet implemented (noted as follow-ups):

- Notion webhook signature verification (token is stored in `.env` for future use)
- Content-based routing (e.g., `[agent:research]` tag in comment body routes to an additional peer)
- Tests (manual end-to-end test via the steps in SETUP.md)
- Propagation of subscriptions across machines (SQLite is local; a Turso-backed store would survive machine moves)

## Related

- [claude-hive-mcp](https://github.com/KevinLyxz/claude-hive-mcp) — the peer-messaging broker that notion-channel-mcp forwards events into. You need this running for notion-channel-mcp to deliver anything.

## License

MIT — see [LICENSE](LICENSE).
