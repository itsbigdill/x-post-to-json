#!/usr/bin/env node
// Unroll an X thread into the full ordered chain of the author's own tweets.
//
// How: X's public endpoints don't expose a conversation forward (that needs
// login), but each tweet reliably carries its parent (`in_reply_to`). So we walk
// BACKWARD from the given tweet, collecting consecutive tweets by the SAME
// author, then reverse to chronological order.
//
//   => Pass the LAST tweet of a thread (or any tweet) — it unrolls everything up
//      to and including it. Passing the FIRST tweet yields just that tweet, since
//      we can't walk forward without authentication.
//
// Usage:
//   node unroll-thread.mjs <url-or-id> [--markdown | --ids] [--max N]
//   (default output: JSON array of normalized tweets, root first)

import { fetchTweet, TweetError } from "../lib/tweet.mjs";
import { fmtNum, fmtDate } from "../lib/render.mjs";

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith("--"));
const asMd = args.includes("--markdown");
const asIds = args.includes("--ids");
const maxIdx = args.indexOf("--max");
const MAX = maxIdx !== -1 ? Number(args[maxIdx + 1]) || 50 : 50;

if (!input) {
  console.log(JSON.stringify({ error: "Usage: node unroll-thread.mjs <url-or-id> [--markdown|--ids]" }));
  process.exit(1);
}

const norm = (h) => (h || "").toLowerCase();

try {
  const start = await fetchTweet(input, { enrich: "full" });
  const author = norm(start.author?.handle);
  const chain = [start];
  let cur = start;

  while (cur.in_reply_to && chain.length < MAX) {
    let parent;
    try {
      parent = await fetchTweet(cur.in_reply_to, { enrich: "full" });
    } catch {
      break; // parent deleted/unavailable — stop the walk
    }
    if (norm(parent.author?.handle) !== author) break; // reached someone else = not part of self-thread
    chain.unshift(parent);
    cur = parent;
  }

  if (asIds) {
    console.log(chain.map((t) => t.id).join("\n"));
  } else if (asMd) {
    const a = start.author;
    const head = `## 🧵 Thread by ${a?.name ?? ""} (@${a?.handle ?? ""}) — ${chain.length} tweet${chain.length > 1 ? "s" : ""}\n`;
    const body = chain
      .map((t, i) => `**${i + 1}/${chain.length}**\n\n${t.text}`)
      .join("\n\n---\n\n");
    const last = chain[chain.length - 1].metrics;
    const foot = `\n\n---\n\n*${fmtDate(start.created_at)}* · ❤️ ${fmtNum(last.likes)} · 👁 ${fmtNum(last.views)} · [↗ on X](${chain[chain.length - 1].url})`;
    console.log(head + "\n" + body + foot);
  } else {
    console.log(
      JSON.stringify(
        {
          author: { name: start.author?.name, handle: start.author?.handle },
          count: chain.length,
          complete_backward: !chain[0].in_reply_to || norm(chain[0].author?.handle) === author,
          tweets: chain.map((t) => ({
            id: t.id, url: t.url, text: t.text, created_at: t.created_at,
            is_long_form: t.is_long_form, media: t.media, metrics: t.metrics,
          })),
        },
        null,
        2
      )
    );
  }
} catch (e) {
  console.log(JSON.stringify({ error: e instanceof TweetError ? e.message : String(e?.message ?? e) }));
  process.exit(1);
}
