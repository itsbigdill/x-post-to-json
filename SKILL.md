---
name: x-post-to-json
description: Convert an X (Twitter) post URL into JSON, a PDF document, a PNG card, Markdown, or a Slack/Discord post. Use whenever the user gives an x.com or twitter.com status URL (or a bare tweet ID) and wants the post's data as JSON, an archived PDF, a shareable image, Markdown for notes/blogs, or shared to Slack/Discord. Extracts text (incl. full long-form), author, timestamp, metrics (likes/replies/reposts/views), media, links, hashtags, quoted/reply info.
---

# X Post → JSON / PDF / PNG / Markdown / Slack-Discord

Five output tools over one shared engine (`lib/tweet.mjs`). No API key or login needed.
Most tools accept **multiple URLs** (batch) — see each below.

## Shared engine (how data is fetched)

1. **Syndication endpoint** (`cdn.syndication.twimg.com`) — no-auth source for
   text, author, media, likes. Caps text at 280 chars (long-form truncated).
2. **GraphQL enrichment** (guest token) — recovers the **full long-form text**
   and the **full metrics** (views/replies/reposts/quotes/bookmarks). Best-effort:
   if X rotates its query id, it falls back to the preview and flags `truncated`.

Only public, non-age-gated tweets are available; deleted/protected/suspended
posts return an error.

---

## 1. Tweet → JSON

```bash
node .claude/skills/x-post-to-json/scripts/fetch-tweet.mjs "<url-or-id>"
```

Flags: `--full` (always enrich), `--no-enrich` (pure no-auth), `--compact`,
`--raw-only`. Emits a normalized object (`id, url, text, is_long_form, truncated,
author{…,verified_type}, metrics, media[], urls[], hashtags[], mentions[],
quoted_tweet`) plus the full `raw` payload. See field notes at the bottom.

## 2. Tweet → PDF document

```bash
node .claude/skills/x-post-to-json/scripts/tweet-to-pdf.mjs "<url-or-id>" -o out.pdf
```

Produces a real **PDF document** (not a screenshot): selectable text, embedded
avatar + media (as data URIs, so the file is self-contained), full metrics, and
an archival footer with the source URL + archive timestamp. Good for citation,
evidence, and preserving tweets before deletion.

- Renders via the system's **headless Google Chrome** (no npm deps).
- Defaults to full enrichment. `-o <path>` sets output (default `tweet-<id>.pdf`).
- Flags: `--no-enrich`.

## 3. Tweet → PNG card

```bash
node .claude/skills/x-post-to-json/scripts/tweet-to-png.mjs "<url-or-id>" [...] [-o out.png]
```

A shareable **tweet-style card image** (rounded card, avatar, verified badge, media
with play overlay for video, metrics footer). 2x retina, transparent background.
Multiple URLs → one PNG each (`tweet-<id>.png`). Flags: `--no-enrich`.

## 4. Tweet → Markdown

```bash
node .claude/skills/x-post-to-json/scripts/tweet-to-md.mjs "<url-or-id>" [...] [-o out.md]
```

Portable Markdown (blockquote) for **Notion / Obsidian / blogs** — linkified
text, media as image/video links, metrics, source link. Prints to stdout if no
`-o`. Multiple URLs → one doc separated by `---`. Flags: `--no-enrich`.

## 5. Tweet → Slack / Discord

```bash
node .claude/skills/x-post-to-json/scripts/tweet-to-chat.mjs "<url-or-id>" --webhook "<url>"
```

Posts a rich card via an **incoming webhook** — a Discord embed or a Slack
attachment with author, avatar, full text, image, metrics, and timestamp.

- **Platform auto-detected** from the webhook URL; override with `--slack` /
  `--discord`. Webhook may also come from `$SLACK_WEBHOOK` / `$DISCORD_WEBHOOK`.
- **`--dry-run`** prints the JSON payload instead of posting (no webhook needed) —
  use this to preview.
- Flags: `--no-enrich`.

Setup: create an incoming webhook in Discord (Channel → Integrations → Webhooks)
or Slack (api.slack.com → Incoming Webhooks), then pass its URL.

---

## 6. Analyze / fact-check a tweet

```bash
node .claude/skills/x-post-to-json/scripts/analyze-tweet.mjs "<url-or-id>"
```

Returns a **fact-check scaffold** (not a verdict — no LLM here): the tweet plus
heuristic signals (percentages, stats/causal/sensational language, numbers,
links, named entities), candidate claims, suggested web-search queries, author
credibility, and a rubric. An AI then runs the searches and writes the verdict.

This is designed for the MCP `analyze_tweet` tool: the host AI calls it, then
web-searches and produces a verdict card (claim → supported/misleading/false/
unverifiable, mechanism of error, evidence, source reliability).

## 7. Unroll a thread

```bash
node .claude/skills/x-post-to-json/scripts/unroll-thread.mjs "<url-or-id>" [--markdown | --ids]
```

Walks **backward** from the given tweet via `in_reply_to`, collecting consecutive
tweets by the same author, and returns the ordered chain (root first). Pass the
**last** tweet of the thread (or any tweet) — forward expansion from the first
tweet isn't possible without login. Output: JSON (default), `--markdown`, or
`--ids` (newline-separated, pipe into the other tools).

## MCP server (use the tools from any AI client)

`mcp-server.mjs` exposes all of the above as MCP tools so any MCP client (Claude
Desktop, Claude Code, Cursor, Cline, …) can call them directly — no `node ...`.
Zero dependencies (JSON-RPC over stdio).

Tools: `tweet_to_json`, `analyze_tweet` (fact-check scaffold), `unroll_thread`,
`tweet_to_markdown`, `tweet_to_png_card` (returns the image inline), `tweet_to_pdf`,
`post_tweet_to_chat`.

Register in Claude Code:
```bash
claude mcp add x-post -- node /Users/dan/xtool/.claude/skills/x-post-to-json/mcp-server.mjs
```
Or in `claude_desktop_config.json`:
```json
{ "mcpServers": {
  "x-post": { "command": "node",
    "args": ["/Users/dan/xtool/.claude/skills/x-post-to-json/mcp-server.mjs"] } } }
```

## Field notes (JSON)

- **`is_long_form`** — composed as a long ("note") tweet.
- **`truncated`** — `true` only when the full text could not be recovered (rare
  with enrichment on).
- **`verified_type`** — `"blue"` | `"legacy"` | `null`; `verified` is the OR.
- **`metrics`** — without enrichment the endpoint usually returns only `likes`.

## Architecture

```
lib/tweet.mjs             ← shared fetch + normalize engine (fetchTweet)
lib/render.mjs            ← shared render helpers (esc, richText, fmt*, embedAssets)
scripts/fetch-tweet.mjs   ← JSON CLI            (batch → array)
scripts/tweet-to-pdf.mjs  ← PDF document        (batch → multi-page)
scripts/tweet-to-png.mjs  ← PNG card            (batch → one file each)
scripts/tweet-to-md.mjs   ← Markdown            (batch → joined with ---)
scripts/tweet-to-chat.mjs ← Slack/Discord webhook
```

All tools call `fetchTweet(input, { enrich })`. To add a new output format,
import the engine + `lib/render.mjs` and reuse the normalized object — don't
re-implement fetching. PNG renders via a 2-pass headless-Chrome trick (measure
height via `--dump-dom`, then `--screenshot` at the exact size).
```
