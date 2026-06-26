#!/usr/bin/env node
// Tweet -> Markdown (for Notion / Obsidian / blogs). Portable, no data URIs —
// media is referenced by remote URL. Multiple URLs -> one doc, separated by ---.
//
// Usage:
//   node tweet-to-md.mjs <url-or-id> [<url2> ...] [-o <out.md>] [--no-enrich]
//   (prints to stdout if no -o)

import { fetchTweet, TweetError, extractTweetId } from "../lib/tweet.mjs";
import { fmtNum, fmtDate } from "../lib/render.mjs";
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("-")));
const oIdx = args.indexOf("-o");
const out = oIdx !== -1 ? args[oIdx + 1] : null;
const inputs = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-o");
const enrich = flags.has("--no-enrich") ? "none" : "full";

if (!inputs.length) {
  console.error("Usage: node tweet-to-md.mjs <url-or-id> [...] [-o out.md]");
  process.exit(1);
}

// Linkify urls / @mentions / #hashtags into Markdown links.
function mdText(text) {
  return String(text ?? "")
    .replace(/(https?:\/\/[^\s]+)/g, "[$1]($1)")
    .replace(/(^|\s)@(\w{1,15})/g, "$1[@$2](https://x.com/$2)")
    .replace(/(^|\s)#(\w+)/g, "$1[#$2](https://x.com/hashtag/$2)");
}

function toMarkdown(t) {
  const m = t.metrics;
  const check = t.author?.verified ? " ✓" : "";
  const lines = [];

  // Header
  lines.push(
    `> **[${t.author?.name ?? "Unknown"}](${t.author?.url})** ` +
      `[@${t.author?.handle ?? ""}](${t.author?.url})${check}`
  );
  lines.push(">");
  // Body (blockquote each line)
  for (const ln of mdText(t.text ?? "").split("\n")) lines.push(`> ${ln}`);

  // Media
  for (const md of t.media) {
    lines.push(">");
    if (md.type === "photo") {
      lines.push(`> ![${md.alt || "image"}](${md.url})`);
    } else {
      lines.push(`> [![video thumbnail](${md.poster}) ▶ Watch video](${md.url})`);
    }
  }

  // Footer
  lines.push(">");
  const stats = [
    `❤️ ${fmtNum(m.likes)}`,
    `🔁 ${fmtNum(m.retweets)}`,
    `💬 ${fmtNum(m.replies)}`,
    `👁 ${fmtNum(m.views)}`,
  ].join(" · ");
  lines.push(`> *${fmtDate(t.created_at)}* · ${stats}`);
  lines.push(`>`);
  lines.push(`> [↗ View on X](${t.url})`);
  return lines.join("\n");
}

const blocks = [];
for (const input of inputs) {
  try {
    const tweet = await fetchTweet(input, { enrich });
    blocks.push(toMarkdown(tweet));
  } catch (e) {
    const id = (() => { try { return extractTweetId(input); } catch { return input; } })();
    blocks.push(`> ⚠️ Could not fetch \`${id}\`: ${e instanceof TweetError ? e.message : e.message}`);
  }
}

const md = blocks.join("\n\n---\n\n") + "\n";
if (out) {
  await writeFile(out, md, "utf8");
  console.error(`Wrote ${out}`);
} else {
  process.stdout.write(md);
}
