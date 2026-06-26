#!/usr/bin/env node
// Tweet -> PDF *document* (selectable text, embedded images, archive metadata).
// Not a screenshot: text stays real text, images are embedded as data URIs, and a
// footer records source URL + archive timestamp for citation/archival use.
//
// Usage:
//   node tweet-to-pdf.mjs <url-or-id> [<url2> ...] [-o <output.pdf>] [--no-enrich]
//
// Multiple URLs -> a single multi-page PDF (one tweet per page).
// Renders via the system's headless Google Chrome (no npm dependencies).

import { fetchTweet, TweetError, extractTweetId } from "../lib/tweet.mjs";
import { esc, richText, fmtNum, fmtDate, embedAssets } from "../lib/render.mjs";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const oIdx = args.indexOf("-o");
const out = oIdx !== -1 ? args[oIdx + 1] : null;
const inputs = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-o");
const enrich = flags.has("--no-enrich") ? "none" : "full";

function safeId(x) {
  try { return extractTweetId(x); } catch { return "post"; }
}

if (!inputs.length) {
  console.error("Usage: node tweet-to-pdf.mjs <url-or-id> [...] [-o output.pdf]");
  process.exit(1);
}

const STYLE = `
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font: 14px/1.55 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #0f1419; margin: 0; }
  .tweet + .tweet { page-break-before: always; }
  .doc-tag { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #536471; border-bottom: 1px solid #eff3f4; padding-bottom: 8px; margin-bottom: 18px; }
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .avatar { width: 52px; height: 52px; border-radius: 50%; object-fit: cover; }
  .avatar.placeholder { background: #cfd9de; }
  .name { font-weight: 700; font-size: 16px; }
  .badge { color: #1d9bf0; font-weight: 700; }
  .handle { color: #536471; font-size: 14px; }
  .text { font-size: 17px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; margin: 6px 0 16px; }
  .text a, .q-text a { color: #1d9bf0; text-decoration: none; }
  .media { display: flex; flex-direction: column; gap: 10px; margin: 0 0 16px; align-items: center; }
  .media img { max-width: 100%; max-height: 155mm; width: auto; border-radius: 14px; border: 1px solid #eff3f4; }
  figure { margin: 0; text-align: center; break-inside: avoid; page-break-inside: avoid; }
  figure.is-video { position: relative; display: inline-block; }
  figure.is-video::after { content: "▶"; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 60px; height: 60px; border-radius: 50%; background: rgba(0,0,0,.55); color: #fff; font-size: 26px; display: flex; align-items: center; justify-content: center; }
  figcaption { font-size: 11px; color: #536471; margin-top: 4px; }
  .quoted { border: 1px solid #cfd9de; border-radius: 14px; padding: 10px 14px; margin: 0 0 16px; }
  .q-author { font-weight: 600; font-size: 13px; } .q-handle { color: #536471; font-weight: 400; }
  .q-text { font-size: 14px; white-space: pre-wrap; margin-top: 4px; }
  .when { color: #536471; font-size: 13px; margin-bottom: 14px; }
  .metrics { display: flex; gap: 26px; border-top: 1px solid #eff3f4; border-bottom: 1px solid #eff3f4; padding: 12px 0; break-inside: avoid; page-break-inside: avoid; }
  .when, footer { break-inside: avoid; page-break-inside: avoid; }
  .metric b { font-size: 15px; } .metric span { color: #536471; font-size: 12px; display: block; }
  footer { margin-top: 20px; font-size: 11px; color: #536471; line-height: 1.5; }
  footer a { color: #536471; }`;

function buildSection(t, assets) {
  const m = t.metrics;
  const verified = t.author?.verified
    ? `<span class="badge" title="${esc(t.author.verified_type)}">✓</span>`
    : "";
  const avatar = assets.avatar
    ? `<img class="avatar" src="${assets.avatar}" alt="">`
    : `<div class="avatar placeholder"></div>`;

  const mediaHtml = assets.media.length
    ? `<div class="media">${assets.media
        .map((mm) => {
          const isVid = mm.type !== "photo";
          const label = mm.type === "animated_gif" ? "GIF" : "Video";
          const cap = isVid
            ? `<figcaption>▶ ${label}${mm.alt ? " · " + esc(mm.alt) : ""}</figcaption>`
            : mm.alt
            ? `<figcaption>${esc(mm.alt)}</figcaption>`
            : "";
          return `<figure class="${isVid ? "is-video" : ""}"><img src="${mm.src}" alt="${esc(
            mm.alt || ""
          )}">${cap}</figure>`;
        })
        .join("")}</div>`
    : "";

  const quoted = t.quoted_tweet
    ? `<blockquote class="quoted">
         <div class="q-author">${esc(t.quoted_tweet.author?.name ?? "")}
           <span class="q-handle">@${esc(t.quoted_tweet.author?.handle ?? "")}</span></div>
         <div class="q-text">${richText(t.quoted_tweet.text ?? "")}</div>
       </blockquote>`
    : "";

  return `<section class="tweet">
  <div class="doc-tag">Archived from X (Twitter)</div>
  <div class="head">${avatar}
    <div><div class="name">${esc(t.author?.name ?? "Unknown")} ${verified}</div>
    <div class="handle">@${esc(t.author?.handle ?? "")}</div></div>
  </div>
  <div class="text">${richText(t.text ?? "")}</div>
  ${mediaHtml}
  ${quoted}
  <div class="when">${fmtDate(t.created_at)}${t.is_long_form ? " · long-form post" : ""}</div>
  <div class="metrics">
    <div class="metric"><b>${fmtNum(m.likes)}</b><span>Likes</span></div>
    <div class="metric"><b>${fmtNum(m.retweets)}</b><span>Reposts</span></div>
    <div class="metric"><b>${fmtNum(m.replies)}</b><span>Replies</span></div>
    <div class="metric"><b>${fmtNum(m.quotes)}</b><span>Quotes</span></div>
    <div class="metric"><b>${fmtNum(m.bookmarks)}</b><span>Bookmarks</span></div>
    <div class="metric"><b>${fmtNum(m.views)}</b><span>Views</span></div>
  </div>
  <footer>
    Source: <a href="${esc(t.url)}">${esc(t.url)}</a><br>
    Tweet ID: ${esc(t.id)} · Archived: ${esc(new Date().toISOString())}
  </footer>
  </section>`;
}

function buildDoc(sections, title) {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>${STYLE}</style></head><body>${sections.join("\n")}</body></html>`;
}

// --- run ------------------------------------------------------------------
const sections = [];
for (const input of inputs) {
  try {
    const tweet = await fetchTweet(input, { enrich });
    const assets = await embedAssets(tweet);
    sections.push(buildSection(tweet, assets));
  } catch (e) {
    console.error(`✗ ${safeId(input)}: ${e instanceof TweetError ? e.message : e.message}`);
  }
}
if (!sections.length) {
  console.error("Nothing to render.");
  process.exit(1);
}

const outPath = out || `tweet-${safeId(inputs[0])}${inputs.length > 1 ? "-batch" : ""}.pdf`;
const html = buildDoc(sections, `X posts (${sections.length})`);

const dir = await mkdtemp(join(tmpdir(), "tweet-pdf-"));
const htmlPath = join(dir, "tweet.html");
await writeFile(htmlPath, html, "utf8");

try {
  await run(CHROME, [
    "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
    `--print-to-pdf=${outPath}`, `file://${htmlPath}`,
  ]);
  console.log(`Wrote ${outPath} (${sections.length} page${sections.length > 1 ? "s" : ""})`);
} catch (e) {
  console.error("Chrome failed to render PDF:", e.message);
  process.exit(1);
} finally {
  await unlink(htmlPath).catch(() => {});
}
