# x-post-to-json

Turn any **X (Twitter) post** into **JSON**, a **PDF document**, a **PNG card**, **Markdown**, or a **Slack/Discord post** — with **no API key and no login**.

Zero npm dependencies. Works on Node 18+ (uses built-in `fetch`). PDF/PNG rendering uses your local headless Google Chrome.

```bash
node scripts/fetch-tweet.mjs "https://x.com/jack/status/20"
```

## Why

X degrades its own content outside the platform (login walls, broken previews, deleted tweets vanish). This toolkit extracts a tweet's data through X's public **syndication** endpoint (the same one Vercel's `react-tweet` uses) and enriches it via the public **GraphQL** endpoint with a guest token — recovering full long-form text and complete metrics — then renders it however you need.

## Outputs

| Tool | Command | Notes |
|------|---------|-------|
| **JSON** | `scripts/fetch-tweet.mjs <url>` | normalized + `raw`; batch → array |
| **PDF** | `scripts/tweet-to-pdf.mjs <url> -o out.pdf` | real document, selectable text, archival footer; batch → multi-page |
| **PNG card** | `scripts/tweet-to-png.mjs <url> -o out.png` | shareable card, 2× retina, transparent bg |
| **Markdown** | `scripts/tweet-to-md.mjs <url>` | for Notion/Obsidian/blogs; batch → joined |
| **Slack/Discord** | `scripts/tweet-to-chat.mjs <url> --webhook <url>` | rich card via incoming webhook; `--dry-run` to preview |

All accept a tweet URL (`x.com` / `twitter.com`, with `?query`/`/photo/1`) or a bare tweet ID, and one or more inputs (batch).

### Common flags
- `--full` — always enrich via GraphQL (full metrics even for short tweets)
- `--no-enrich` — pure no-auth syndication only (fastest)
- `-o <path>` — output file (PDF/PNG/MD)

## What it extracts

Text (including **full long-form**), author (name, handle, avatar, `verified_type`), timestamp, metrics (likes / reposts / replies / quotes / bookmarks / views), media (photos + **video/GIF** with poster & link), links, hashtags, mentions, and quoted/reply info. Deleted / protected / age-gated / suspended tweets return a clean error.

## MCP server

`mcp-server.mjs` exposes everything as MCP tools so any MCP client (Claude Desktop, Claude Code, Cursor, Cline, …) can call them directly. Zero dependencies (JSON-RPC over stdio). `tweet_to_png_card` returns the rendered image inline.

**Claude Code:**
```bash
claude mcp add x-post -- node "$(pwd)/mcp-server.mjs"
```

**Claude Desktop / Cursor / Cline** (`claude_desktop_config.json`):
```json
{ "mcpServers": {
  "x-post": { "command": "node", "args": ["/absolute/path/to/x-post-to-json/mcp-server.mjs"] }
} }
```

Tools: `tweet_to_json`, `tweet_to_markdown`, `tweet_to_png_card`, `tweet_to_pdf`, `post_tweet_to_chat`.

## Architecture

```
lib/tweet.mjs              shared fetch + normalize engine (fetchTweet)
lib/render.mjs             shared render helpers (esc, richText, fmt*, embedAssets)
scripts/fetch-tweet.mjs    JSON
scripts/tweet-to-pdf.mjs   PDF document
scripts/tweet-to-png.mjs   PNG card
scripts/tweet-to-md.mjs    Markdown
scripts/tweet-to-chat.mjs  Slack/Discord
mcp-server.mjs             MCP wrapper
```

To add an output format, import the engine + `lib/render.mjs` and reuse the normalized object — don't re-implement fetching.

## Caveats

- Uses X's **undocumented public endpoints**. They can change; GraphQL enrichment is best-effort and degrades gracefully (falls back to the syndication preview, flags `truncated`). If enrichment stops working, the `GQL_QUERY_ID` in `lib/tweet.mjs` likely rotated and needs updating.
- Public tweets only. Respect X's Terms of Service and applicable laws for your use case.
- PDF/PNG require Google Chrome installed (path is `/Applications/Google Chrome.app/...` on macOS — adjust in the scripts for other OSes).

## License

MIT © [itsbigdill](https://github.com/itsbigdill)
