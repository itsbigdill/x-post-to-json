#!/usr/bin/env node
// Tweet -> a rich post in Slack or Discord via an incoming webhook.
// Auto-detects the platform from the webhook URL (or use --slack / --discord).
//
// Usage:
//   node tweet-to-chat.mjs <url-or-id> --webhook <url> [--slack|--discord] [--dry-run] [--full]
//
// The webhook can also come from env: SLACK_WEBHOOK or DISCORD_WEBHOOK.
//   --dry-run   Print the JSON payload instead of posting (no webhook needed).

import { fetchTweet, TweetError } from "../lib/tweet.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const valOf = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const input = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--webhook");

if (!input) {
  console.error("Usage: node tweet-to-chat.mjs <url-or-id> --webhook <url> [--dry-run]");
  process.exit(1);
}

let webhook = valOf("--webhook") || process.env.DISCORD_WEBHOOK || process.env.SLACK_WEBHOOK;
const dryRun = flags.has("--dry-run");

// Detect platform: explicit flag > URL sniff > env var name.
let platform = flags.has("--slack") ? "slack" : flags.has("--discord") ? "discord" : null;
if (!platform && webhook) {
  if (/hooks\.slack\.com/.test(webhook)) platform = "slack";
  else if (/discord(app)?\.com\/api\/webhooks/.test(webhook)) platform = "discord";
}
if (!platform && process.env.SLACK_WEBHOOK) platform = "slack";
if (!platform && process.env.DISCORD_WEBHOOK) platform = "discord";

if (!platform) {
  console.error("Could not determine platform. Pass --slack or --discord (or a recognizable webhook URL).");
  process.exit(1);
}
if (!dryRun && !webhook) {
  console.error(`No webhook URL. Pass --webhook <url> or set ${platform.toUpperCase()}_WEBHOOK.`);
  process.exit(1);
}

const enrich = flags.has("--no-enrich") ? "none" : "full";

function fmt(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

// --- Discord embed --------------------------------------------------------
function discordPayload(t) {
  const m = t.metrics;
  const media0 = t.media.find((x) => x.poster);
  const isVideo = media0 && media0.type !== "photo";
  const handle = t.author?.handle ?? "";
  const check = t.author?.verified ? " ☑️" : "";
  return {
    username: "X",
    embeds: [
      {
        color: 0x1d9bf0,
        author: {
          name: `${t.author?.name ?? ""} (@${handle})${check}`,
          url: t.author?.url ?? undefined,
          icon_url: t.author?.avatar ?? undefined,
        },
        description: (t.text ?? "").slice(0, 4000),
        url: t.url ?? undefined,
        image: media0 ? { url: media0.poster } : undefined,
        fields: [
          { name: "❤️ Likes", value: fmt(m.likes), inline: true },
          { name: "🔁 Reposts", value: fmt(m.retweets), inline: true },
          { name: "💬 Replies", value: fmt(m.replies), inline: true },
          { name: "👁 Views", value: fmt(m.views), inline: true },
          ...(isVideo
            ? [{ name: "🎥 Video", value: `[Watch](${media0.url})`, inline: true }]
            : []),
        ],
        footer: { text: "X (Twitter)" },
        timestamp: t.created_at ?? undefined,
      },
    ],
  };
}

// --- Slack attachment -----------------------------------------------------
function slackPayload(t) {
  const m = t.metrics;
  const media0 = t.media.find((x) => x.poster);
  const isVideo = media0 && media0.type !== "photo";
  const handle = t.author?.handle ?? "";
  const check = t.author?.verified ? " ✅" : "";
  return {
    text: `New X post from <${t.author?.url}|@${handle}>`,
    attachments: [
      {
        color: "#1d9bf0",
        author_name: `${t.author?.name ?? ""} (@${handle})${check}`,
        author_link: t.author?.url ?? undefined,
        author_icon: t.author?.avatar ?? undefined,
        text: t.text ?? "",
        title: "View on X",
        title_link: t.url ?? undefined,
        image_url: media0 ? media0.poster : undefined,
        fields: [
          { title: "Likes", value: fmt(m.likes), short: true },
          { title: "Reposts", value: fmt(m.retweets), short: true },
          { title: "Replies", value: fmt(m.replies), short: true },
          { title: "Views", value: fmt(m.views), short: true },
          ...(isVideo
            ? [{ title: "🎥 Video", value: `<${media0.url}|Watch>`, short: true }]
            : []),
        ],
        footer: "X (Twitter)",
        ts: t.created_at ? Math.floor(new Date(t.created_at).getTime() / 1000) : undefined,
      },
    ],
  };
}

// --- run ------------------------------------------------------------------
let tweet;
try {
  tweet = await fetchTweet(input, { enrich });
} catch (e) {
  console.error(e instanceof TweetError ? e.message : e);
  process.exit(1);
}

const payload = platform === "slack" ? slackPayload(tweet) : discordPayload(tweet);

if (dryRun) {
  console.log(`[dry-run] platform=${platform}`);
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const res = await fetch(webhook, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

if (res.ok) {
  console.log(`Posted to ${platform}. (HTTP ${res.status})`);
} else {
  console.error(`Failed to post to ${platform}: HTTP ${res.status}`);
  console.error((await res.text()).slice(0, 300));
  process.exit(1);
}
