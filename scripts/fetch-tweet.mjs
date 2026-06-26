#!/usr/bin/env node
// Tweet -> JSON. Thin CLI over lib/tweet.mjs.
//
// Usage:
//   node fetch-tweet.mjs <url-or-id> [<url2> ...] [--raw-only] [--compact] [--full] [--no-enrich]
//
//   --full        Always enrich via GraphQL (full metrics even for short tweets).
//   --no-enrich   Never call GraphQL (pure no-auth syndication only).
//   --raw-only    Emit the raw syndication payload as-is.
//   --compact     Single-line JSON.
//
// Multiple URLs -> a JSON array (one element per tweet; failures become
// {error,...} objects so one bad URL doesn't sink the batch).

import { fetchTweet, TweetError, extractTweetId } from "../lib/tweet.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const inputs = args.filter((a) => !a.startsWith("--"));
const compact = flags.has("--compact");

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, compact ? 0 : 2) + "\n");
}

if (!inputs.length) {
  out({ error: "No tweet URL or ID provided. Usage: node fetch-tweet.mjs <url-or-id> [...]" });
  process.exit(1);
}

const enrich = flags.has("--no-enrich") ? "none" : flags.has("--full") ? "full" : "auto";
const rawOnly = flags.has("--raw-only");

async function one(input) {
  try {
    const tweet = await fetchTweet(input, { enrich });
    return rawOnly ? tweet.raw : tweet;
  } catch (e) {
    const id = (() => { try { return extractTweetId(input); } catch { return input; } })();
    return { error: e instanceof TweetError ? e.message : String(e?.message ?? e), input: id, ...(e?.info ?? {}) };
  }
}

const results = await Promise.all(inputs.map(one));
out(inputs.length === 1 ? results[0] : results);
process.exit(results.some((r) => r?.error) && inputs.length === 1 ? 1 : 0);
