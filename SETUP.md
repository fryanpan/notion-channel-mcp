# notion-channel-mcp setup

End-to-end install. Assumes macOS, bun, Claude Code, and a running claude-hive broker.

## 1. Clone + install

```bash
git clone https://github.com/fryanpan/notion-channel-mcp.git ~/dev/notion-channel-mcp
cd ~/dev/notion-channel-mcp
bun install
```

## 2. Create a Notion integration

1. Go to https://www.notion.so/my-integrations
2. Click **+ New integration**
3. Name: `Notion Channel Bridge` (or whatever you want)
4. Associated workspace: pick the workspace you want to bridge
5. Type: **Internal**
6. Capabilities:
   - ✅ Read content
   - ✅ Read comments
7. Save, then copy the **Internal Integration Secret** — you'll need it in step 3
8. Share the Notion pages you want to watch with the integration. On each top-level parent page:
   - Click **...** → **Connections** → **Connect to** → your integration
   - This grants read access to that page and all its descendants
   - Repeat for each canonical parent per agent (e.g., "Draft Blog Posts", "CRM", "Weekly Plans")

## 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and paste the **Internal Integration Secret** into `NOTION_INTEGRATION_TOKEN`. Leave the rest at defaults unless you have a reason.

## 4. Install Cloudflare Tunnel

`cloudflared` creates an outbound tunnel from your Mac to Cloudflare's edge, so Notion can POST to a stable public URL that terminates on your Mac.

```bash
brew install cloudflared
cloudflared tunnel login                        # opens a browser; authorize
cloudflared tunnel create notion-bridge
```

This prints a tunnel UUID and creates `~/.cloudflared/<tunnel-id>.json` (the credentials file). Note the UUID.

Route a stable hostname:

```bash
# If you have a domain on Cloudflare:
cloudflared tunnel route dns notion-bridge notion-bridge.YOUR-DOMAIN.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: notion-bridge
credentials-file: /Users/YOUR_USERNAME/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: notion-bridge.YOUR-DOMAIN.com
    service: http://localhost:8787
  - service: http_status:404
```

Replace `YOUR_USERNAME`, `<tunnel-id>`, and `YOUR-DOMAIN.com`.

## 5. Install the cloudflared launchd service

The tunnel needs to auto-start so the public hostname stays stable. The receiver does NOT need its own launchd service — it's spawned on demand by the per-session MCP server (singleton pattern).

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs

sed "s|HOME_DIR|$HOME|g" launchd/notion-channel.cloudflared.plist \
  > ~/Library/LaunchAgents/notion-channel.cloudflared.plist

launchctl load ~/Library/LaunchAgents/notion-channel.cloudflared.plist
```

Verify:

```bash
launchctl list | grep notion-channel
curl https://notion-bridge.YOUR-DOMAIN.com/health   # will 502 until the MCP server starts the receiver; that's OK
```

The receiver is spawned automatically by the MCP server on first use (step 7 below). The spawning is idempotent — the first spawn wins the port, subsequent ones detect it and exit cleanly. Log path: `~/Library/Logs/notion-channel-receiver.log`.

## 6. Create the Notion webhook subscription

**This step is UI-only.** Notion has no API for creating webhook subscriptions as of April 2026 — you have to click through the integration settings.

1. https://www.notion.so/my-integrations → your integration
2. **Webhooks** tab → **+ Create a subscription**
3. Endpoint URL: `https://notion-bridge.YOUR-DOMAIN.com/webhook`
4. Event types: check `comment.created` (and anything else you want later)
5. Click **Verify endpoint**. Notion POSTs a verification challenge to the URL; the receiver echoes the token and Notion marks the subscription active. Tail the receiver log — you should see a `"notion verification handshake"` line.
6. Copy the **Webhook secret** shown on the page and paste it into `.env` as `NOTION_WEBHOOK_SECRET`. (Not used for signature verification yet; stored for future hardening.)

## 7. Install the MCP server in Claude Code

```bash
claude mcp add --scope user --transport stdio notion-channel -- bun ~/dev/notion-channel-mcp/server.ts
```

Restart any Claude Code session that should have access to the new tools (`notion_watch_page`, `notion_unwatch_page`, `notion_list_my_watches`).

## 8. First subscription

In any Claude Code session with the new MCP server, ask:

```
Please subscribe me to comments on this Notion page: <paste URL>
```

The agent calls `notion_watch_page` (with `include_descendants: true` if it's a parent). Verify:

```bash
sqlite3 ~/.notion-channel.db "SELECT * FROM subscriptions;"
```

## 9. End-to-end smoke test

1. Open the subscribed page (or a descendant) in Notion.
2. Leave a comment as yourself.
3. Within a few seconds, the comment should appear in the subscribed Claude Code session as a `<channel source="claude-hive">` event.
4. Tail the receiver log if it doesn't:

```bash
tail -f ~/Library/Logs/notion-channel-receiver.log
```

## Troubleshooting

**Receiver can't reach claude-hive broker.** Make sure any claude-hive session is running; the broker is auto-launched by the first claude-hive MCP client.

**Notion verification challenge fails.** The tunnel isn't routing to the receiver. Check:

- `cloudflared tunnel list` — shows a healthy tunnel
- `cloudflared tunnel info notion-bridge` — shows the active connector
- `cat ~/.cloudflared/config.yml` — ingress rule points at `http://localhost:8787`
- `curl http://localhost:8787/health` — receiver is alive locally

**Comments arrive but the agent doesn't see them.** The peer's `stable_id` is registered in claude-hive but no `notion_watch_page` subscription exists for that `stable_id`. In the session, call `notion_list_my_watches` to confirm — if it's empty, the subscription was never made (or was made in a different workspace with a different stable_id).

**Tunnel hostname isn't stable.** Make sure you created a **named tunnel** (`cloudflared tunnel create`), not a quick tunnel (`cloudflared tunnel --url ...`). Named tunnels have persistent hostnames; quick tunnels get a random `.trycloudflare.com` subdomain every run.
