#!/usr/bin/env node
// Tweet -> PNG card (a shareable image of the tweet).
//
// Usage:
//   node tweet-to-png.mjs <url-or-id> [<url2> ...] [-o <out.png>] [--no-enrich]
//
// Renders a tweet-style card via headless Chrome. Uses a 2-pass trick: first
// measure the card's height (dump-dom), then screenshot at the exact size so the
// image is cropped tight with no extra whitespace. Card has a transparent
// margin so the drop shadow isn't clipped. Multiple URLs -> one PNG each.

import { fetchTweet, TweetError, extractTweetId } from "../lib/tweet.mjs";
import { embedAssets, esc, richText, fmtNum, fmtDate } from "../lib/render.mjs";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CARD_W = 600; // content card width
const PAGE_PAD = 24; // transparent margin around the card (for the shadow)
const PAGE_W = CARD_W + PAGE_PAD * 2;

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("-")));
const oIdx = args.indexOf("-o");
const out = oIdx !== -1 ? args[oIdx + 1] : null;
const inputs = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-o");
const enrich = flags.has("--no-enrich") ? "none" : "full";

if (!inputs.length) {
  console.error("Usage: node tweet-to-png.mjs <url-or-id> [...] [-o out.png]");
  process.exit(1);
}

function cardHtml(t, assets) {
  const m = t.metrics;
  const verified = t.author?.verified ? `<span class="ck">✓</span>` : "";
  const avatar = assets.avatar
    ? `<img class="av" src="${assets.avatar}">`
    : `<div class="av ph"></div>`;
  const media = assets.media
    .map((mm) => {
      const vid = mm.type !== "photo";
      return `<div class="mwrap ${vid ? "vid" : ""}"><img class="m" src="${mm.src}">${
        vid ? '<div class="play">▶</div>' : ""
      }</div>`;
    })
    .join("");
  const metric = (icon, n) => `<span class="met">${icon} ${fmtNum(n)}</span>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent}
  body{padding:${PAGE_PAD}px;font:16px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#0f1419}
  .card{width:${CARD_W}px;box-sizing:border-box;background:#fff;border:1px solid #eff3f4;border-radius:18px;
        padding:20px 22px;box-shadow:0 8px 30px rgba(0,0,0,.12)}
  .top{display:flex;align-items:center;gap:12px}
  .av{width:48px;height:48px;border-radius:50%;object-fit:cover}.av.ph{background:#cfd9de}
  .name{font-weight:700;font-size:16px;line-height:1.2}
  .ck{color:#1d9bf0}.handle{color:#536471;font-size:14px}
  .logo{margin-left:auto;color:#0f1419;font-weight:800;font-size:22px}
  .text{font-size:18px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word;margin:14px 0}
  .text a{color:#1d9bf0;text-decoration:none}
  .mwrap{position:relative;margin:12px 0 0}
  .m{width:100%;max-height:420px;object-fit:cover;border-radius:14px;border:1px solid #eff3f4;display:block}
  .vid .play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:64px;height:64px;
        border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:26px;display:flex;align-items:center;justify-content:center}
  .foot{margin-top:16px;padding-top:12px;border-top:1px solid #eff3f4;color:#536471;font-size:13px;
        display:flex;flex-wrap:wrap;gap:16px;align-items:center}
  .met{font-variant-numeric:tabular-nums}
  </style></head><body>
  <div class="card">
    <div class="top">${avatar}
      <div><div class="name">${esc(t.author?.name ?? "Unknown")} ${verified}</div>
      <div class="handle">@${esc(t.author?.handle ?? "")}</div></div>
      <div class="logo">𝕏</div>
    </div>
    <div class="text">${richText(t.text ?? "")}</div>
    ${media}
    <div class="foot">
      <span>${fmtDate(t.created_at)}</span>
      ${metric("❤️", m.likes)} ${metric("🔁", m.retweets)} ${metric("💬", m.replies)} ${metric("👁", m.views)}
    </div>
  </div>
  <script>document.documentElement.setAttribute('data-h', document.body.scrollHeight)</script>
  </body></html>`;
}

async function renderOne(input) {
  const tweet = await fetchTweet(input, { enrich });
  const assets = await embedAssets(tweet);
  const html = cardHtml(tweet, assets);

  const dir = await mkdtemp(join(tmpdir(), "tweet-png-"));
  const htmlPath = join(dir, "card.html");
  await writeFile(htmlPath, html, "utf8");

  // Pass 1: measure height.
  const { stdout } = await run(CHROME, [
    "--headless=new", "--disable-gpu", "--dump-dom",
    "--virtual-time-budget=2000", `--window-size=${PAGE_W},100`,
    `file://${htmlPath}`,
  ]);
  const h = Number((stdout.match(/data-h="(\d+)"/) || [])[1] || 800) + PAGE_PAD * 2;

  // Pass 2: screenshot at exact size, transparent background.
  const target = out || `tweet-${tweet.id}.png`;
  await run(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars",
    "--default-background-color=00000000",
    `--screenshot=${target}`, `--window-size=${PAGE_W},${h}`,
    "--force-device-scale-factor=2", `file://${htmlPath}`,
  ]);
  await unlink(htmlPath).catch(() => {});
  return target;
}

for (const input of inputs) {
  try {
    const path = await renderOne(input);
    console.log(`Wrote ${path}`);
  } catch (e) {
    const id = (() => { try { return extractTweetId(input); } catch { return input; } })();
    console.error(`✗ ${id}: ${e instanceof TweetError ? e.message : e.message}`);
  }
}
