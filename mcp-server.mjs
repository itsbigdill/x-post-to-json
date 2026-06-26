#!/usr/bin/env node
// Zero-dependency MCP server exposing the X-post tools to any MCP client
// (Claude Desktop, Claude Code, Cursor, Cline, ...). Speaks JSON-RPC 2.0 over
// stdio (newline-delimited), the MCP stdio transport. No npm install needed.
//
// Register (Claude Code):
//   claude mcp add x-post -- node /ABS/PATH/.claude/skills/x-post-to-json/mcp-server.mjs
// Or in claude_desktop_config.json:
//   "x-post": { "command": "node", "args": ["/ABS/PATH/.../mcp-server.mjs"] }
//
// Tools reuse the already-tested CLI scripts via child processes.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "scripts");
const SERVER = { name: "x-post-to-json", version: "1.0.0" };

// Run a CLI script; never reject on non-zero exit — the scripts print a clean
// JSON/text error to stdout/stderr and exit 1, which we want to surface.
async function script(name, args) {
  try {
    const { stdout, stderr } = await run("node", [join(SCRIPTS, name), ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "", code: e.code ?? 1 };
  }
}

const textResult = (r) => ({
  content: [{ type: "text", text: (r.stdout || r.stderr || "").trim() }],
  ...(r.code !== 0 ? { isError: true } : {}),
});

// --- Tool definitions -----------------------------------------------------
const TOOLS = [
  {
    name: "tweet_to_json",
    description:
      "Fetch an X (Twitter) post and return structured JSON: text (incl. full long-form), author, timestamp, metrics (likes/replies/reposts/quotes/bookmarks/views), media, links, hashtags, mentions, quoted/reply info. No API key needed; public tweets only.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Tweet URL (x.com/twitter.com) or bare tweet ID" },
        enrich: { type: "string", enum: ["auto", "full", "none"], description: "auto=enrich long-form only (default); full=always; none=no-auth syndication only" },
        raw: { type: "boolean", description: "Return X's raw payload instead of the normalized shape" },
      },
      required: ["url"],
    },
  },
  {
    name: "analyze_tweet",
    description:
      "Fact-check / explain an X post. Returns a SCAFFOLD: the tweet, heuristic signals (stats, causal & sensational language, numbers, links, named entities), candidate claims, suggested web-search queries, author credibility, and a rubric. After calling this you MUST run web searches (start from suggested_queries, plus your own), prefer primary/peer-reviewed sources, watch for reverse-causation/confounding/cherry-picking, then output the verdict card described in the returned 'instructions'. Use whenever the user wants a tweet verified, debunked, explained, or researched.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Tweet URL or ID" } },
      required: ["url"],
    },
  },
  {
    name: "unroll_thread",
    description:
      "Unroll an X thread into the author's full ordered chain of tweets. Pass the LAST tweet of the thread (or any tweet in it) — it walks backward collecting consecutive same-author tweets and returns them root-first. Passing the first tweet returns just that one (forward expansion needs login). format: 'json' (default) or 'markdown'.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Tweet URL or ID (ideally the last tweet of the thread)" },
        format: { type: "string", enum: ["json", "markdown"], description: "Output format (default json)" },
      },
      required: ["url"],
    },
  },
  {
    name: "tweet_to_markdown",
    description: "Fetch an X post and return portable Markdown (blockquote) for Notion/Obsidian/blogs — linkified text, media links, metrics, source link.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Tweet URL or ID" } },
      required: ["url"],
    },
  },
  {
    name: "tweet_to_png_card",
    description: "Render an X post as a shareable tweet-style PNG card and return the image itself (avatar, verified badge, media, metrics). 2x retina, transparent background.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Tweet URL or ID" } },
      required: ["url"],
    },
  },
  {
    name: "tweet_to_pdf",
    description: "Render one or more X posts as a PDF document (selectable text, embedded media, archival footer with source + timestamp). Multiple URLs become a multi-page PDF. Writes a file and returns its path.",
    inputSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "One or more tweet URLs/IDs" },
        output_path: { type: "string", description: "Where to write the PDF (absolute path recommended)" },
      },
      required: ["urls"],
    },
  },
  {
    name: "post_tweet_to_chat",
    description: "Post an X post as a rich card to Slack or Discord via an incoming webhook. Use dry_run to preview the payload without posting.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Tweet URL or ID" },
        webhook: { type: "string", description: "Slack or Discord incoming webhook URL" },
        platform: { type: "string", enum: ["slack", "discord"], description: "Override auto-detection" },
        dry_run: { type: "boolean", description: "Print the payload instead of posting" },
      },
      required: ["url"],
    },
  },
];

// --- Tool dispatch --------------------------------------------------------
async function callTool(name, a = {}) {
  switch (name) {
    case "tweet_to_json": {
      const args = [a.url];
      if (a.enrich === "full") args.push("--full");
      else if (a.enrich === "none") args.push("--no-enrich");
      if (a.raw) args.push("--raw-only");
      return textResult(await script("fetch-tweet.mjs", args));
    }
    case "analyze_tweet":
      return textResult(await script("analyze-tweet.mjs", [a.url]));
    case "unroll_thread": {
      const args = [a.url];
      if (a.format === "markdown") args.push("--markdown");
      return textResult(await script("unroll-thread.mjs", args));
    }
    case "tweet_to_markdown":
      return textResult(await script("tweet-to-md.mjs", [a.url]));
    case "tweet_to_png_card": {
      const dir = await mkdtemp(join(tmpdir(), "mcp-png-"));
      const out = join(dir, "card.png");
      const r = await script("tweet-to-png.mjs", [a.url, "-o", out]);
      const png = await readFile(out).catch(() => null);
      await unlink(out).catch(() => {});
      if (!png) return { content: [{ type: "text", text: (r.stderr || "Failed to render card").trim() }], isError: true };
      return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
    }
    case "tweet_to_pdf": {
      const urls = Array.isArray(a.urls) ? a.urls : [a.urls];
      const args = [...urls];
      if (a.output_path) args.push("-o", a.output_path);
      return textResult(await script("tweet-to-pdf.mjs", args));
    }
    case "post_tweet_to_chat": {
      const args = [a.url];
      if (a.webhook) args.push("--webhook", a.webhook);
      if (a.platform) args.push(`--${a.platform}`);
      if (a.dry_run) args.push("--dry-run");
      return textResult(await script("tweet-to-chat.mjs", args));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- JSON-RPC over stdio --------------------------------------------------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(req) {
  const { id, method, params } = req;
  // Notifications (no id) get no response.
  if (id === undefined) return;

  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: SERVER,
        },
      });
    }
    if (method === "tools/list") {
      return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }
    if (method === "tools/call") {
      try {
        const result = await callTool(params?.name, params?.arguments);
        return send({ jsonrpc: "2.0", id, result });
      } catch (e) {
        // Tool-level error: report inside result so the model can react.
        return send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true },
        });
      }
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    // Unknown method.
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    handle(req);
  }
});
