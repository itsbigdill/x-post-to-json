// Shared rendering helpers used by the PNG / Markdown / PDF outputs.

export const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// Escape, then linkify urls / @mentions / #hashtags, preserving line breaks.
export function richText(text) {
  let html = esc(text);
  html = html.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>');
  html = html.replace(/(^|\s)@(\w{1,15})/g, '$1<a href="https://x.com/$2">@$2</a>');
  html = html.replace(/(^|\s)#(\w+)/g, '$1<a href="https://x.com/hashtag/$2">#$2</a>');
  return html;
}

export function fmtNum(n) {
  if (n == null) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

export function fmtDate(iso) {
  if (!iso) return "";
  return (
    new Date(iso).toLocaleString("en-US", {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: "UTC",
    }) + " UTC"
  );
}

export async function toDataUri(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await r.arrayBuffer());
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// Download avatar + media posters as data URIs so the output is self-contained.
export async function embedAssets(tweet) {
  const avatarUrl = tweet.author?.avatar?.replace("_normal", "_bigger");
  const mediaItems = tweet.media.filter((m) => m.poster);
  const [avatar, ...posters] = await Promise.all([
    toDataUri(avatarUrl),
    ...mediaItems.map((m) => toDataUri(m.poster)),
  ]);
  const media = posters
    .map((src, i) =>
      src ? { src, alt: mediaItems[i].alt, type: mediaItems[i].type } : null
    )
    .filter(Boolean);
  return { avatar, media };
}
