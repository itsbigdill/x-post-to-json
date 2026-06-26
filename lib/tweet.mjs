// Shared engine: fetch an X (Twitter) post and return a normalized object.
// Used by every tool in this skill (json / pdf / chat).
//
//   import { fetchTweet, TweetError } from "../lib/tweet.mjs";
//   const tweet = await fetchTweet(urlOrId, { enrich: "auto" });
//
// `enrich`: "auto" (enrich long-form only) | "full" (always) | "none".
// Throws TweetError (with .info) when the tweet can't be fetched.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Public web bearer token + a recent TweetResultByRestId query id. Both are
// X internals and can rotate; enrichment degrades gracefully if they break.
const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const GQL_QUERY_ID = "0hWvDhmW8YQ-S_ib3azIrw";

export class TweetError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = "TweetError";
    this.info = info;
  }
}

// --- Parse the tweet ID out of whatever the user passed -------------------
export function extractTweetId(raw) {
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/(?:status(?:es)?)\/(\d+)/i);
  if (m) return m[1];
  throw new TweetError(`Could not find a tweet ID in: ${raw}`);
}

// --- Syndication (no auth) ------------------------------------------------
function syndicationToken(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI)
    .toString(6 ** 2) // radix 36
    .replace(/(0+|\.)/g, "");
}

async function fetchSyndication(tweetId) {
  const url =
    `https://cdn.syndication.twimg.com/tweet-result` +
    `?id=${tweetId}` +
    `&token=${syndicationToken(tweetId)}` +
    `&lang=en` +
    `&features=tfw_timeline_list%3A%3Btfw_follower_count_sunset%3Atrue%3B` +
    `tfw_tweet_edit_backend%3Aon%3Btfw_refsrc_session%3Aon`;

  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
  } catch (e) {
    throw new TweetError(`Network error while fetching tweet ${tweetId}: ${e.message}`);
  }
  const body = await res.text();
  if (!body.trim().startsWith("{")) {
    throw new TweetError(
      `Tweet ${tweetId} is not available via the public endpoint ` +
        `(deleted, protected, age-gated, suspended, or the ID is wrong).`,
      { httpStatus: res.status, tweetId }
    );
  }
  let raw;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    throw new TweetError(`Failed to parse response for tweet ${tweetId}: ${e.message}`);
  }
  if (raw.__typename === "TweetTombstone") {
    throw new TweetError(`Tweet ${tweetId} is unavailable (tombstoned).`, {
      tombstone: raw.tombstone?.text?.text ?? null,
    });
  }
  return raw;
}

// --- GraphQL enrichment (guest token) — best-effort, returns null on fail --
async function fetchGraphql(tweetId) {
  try {
    const gRes = await fetch("https://api.twitter.com/1.1/guest/activate.json", {
      method: "POST",
      headers: { Authorization: `Bearer ${BEARER}`, "User-Agent": UA },
    });
    const guest = (await gRes.json())?.guest_token;
    if (!guest) return null;

    const variables = {
      tweetId,
      withCommunity: false,
      includePromotedContent: false,
      withVoice: false,
    };
    const features = {
      creator_subscriptions_tweet_preview_api_enabled: true,
      tweetypie_unmention_optimization_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      tweet_awards_web_tipping_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_enhance_cards_enabled: false,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      rweb_video_timestamps_enabled: true,
      communities_web_enable_tweet_community_results_fetch: true,
      articles_preview_enabled: true,
      creator_subscriptions_quote_tweet_preview_enabled: false,
    };
    const url =
      `https://api.twitter.com/graphql/${GQL_QUERY_ID}/TweetResultByRestId` +
      `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(features))}`;

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${BEARER}`,
        "x-guest-token": guest,
        "User-Agent": UA,
      },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const result = j?.data?.tweetResult?.result;
    return result?.tweet ?? result ?? null;
  } catch {
    return null;
  }
}

// --- Normalize ------------------------------------------------------------
function bestVideoVariant(m) {
  const variants = (m?.video_info?.variants ?? []).filter(
    (v) => v.content_type === "video/mp4"
  );
  variants.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return variants[0];
}

function normMedia(t) {
  return (t?.mediaDetails ?? []).map((m) => ({
    type: m.type,
    url:
      m.type === "photo"
        ? m.media_url_https
        : bestVideoVariant(m)?.url ?? m.media_url_https,
    poster: m.media_url_https ?? null,
    alt: m.ext_alt_text ?? null,
    width: m.original_info?.width ?? null,
    height: m.original_info?.height ?? null,
  }));
}

function verifiedType(isBlue, isLegacy) {
  if (isLegacy) return "legacy";
  if (isBlue) return "blue";
  return null;
}

function normUser(u) {
  if (!u) return null;
  const isBlue = Boolean(u.is_blue_verified);
  const isLegacy = Boolean(u.verified);
  return {
    id: u.id_str ?? null,
    name: u.name ?? null,
    handle: u.screen_name ?? null,
    url: u.screen_name ? `https://x.com/${u.screen_name}` : null,
    verified: isBlue || isLegacy,
    verified_type: verifiedType(isBlue, isLegacy),
    avatar: u.profile_image_url_https ?? null,
  };
}

function normTweet(t) {
  if (!t) return null;
  const handle = t.user?.screen_name;
  return {
    id: t.id_str ?? null,
    url: handle && t.id_str ? `https://x.com/${handle}/status/${t.id_str}` : null,
    text: t.text ?? null,
    is_long_form: Boolean(t.note_tweet),
    truncated: Boolean(t.note_tweet),
    lang: t.lang ?? null,
    created_at: t.created_at ?? null,
    author: normUser(t.user),
    metrics: {
      likes: t.favorite_count ?? null,
      retweets: t.retweet_count ?? null,
      replies: t.reply_count ?? null,
      quotes: t.quote_count ?? null,
      bookmarks: t.bookmark_count ?? null,
      views: t.view_count_str ? Number(t.view_count_str) : null,
    },
    media: normMedia(t),
    urls: (t.entities?.urls ?? []).map((u) => ({
      url: u.expanded_url ?? u.url,
      display: u.display_url ?? null,
    })),
    hashtags: (t.entities?.hashtags ?? []).map((h) => h.text),
    mentions: (t.entities?.user_mentions ?? []).map((m) => m.screen_name),
    is_reply: Boolean(t.in_reply_to_status_id_str),
    in_reply_to: t.in_reply_to_status_id_str ?? null,
    conversation_id: t.conversation_id_str ?? null,
    quoted_tweet: t.quoted_tweet ? normTweet(t.quoted_tweet) : null,
  };
}

function applyGraphql(n, g) {
  if (!g) return n;
  const legacy = g.legacy ?? {};
  const fullText = g.note_tweet?.note_tweet_results?.result?.text;
  if (fullText) {
    n.text = fullText;
    n.truncated = false;
  } else if (legacy.full_text && !n.is_long_form) {
    n.text = legacy.full_text;
  }

  const num = (v) => (typeof v === "number" ? v : null);
  n.metrics = {
    likes: num(legacy.favorite_count) ?? n.metrics.likes,
    retweets: num(legacy.retweet_count) ?? n.metrics.retweets,
    replies: num(legacy.reply_count) ?? n.metrics.replies,
    quotes: num(legacy.quote_count) ?? n.metrics.quotes,
    bookmarks: num(legacy.bookmark_count) ?? n.metrics.bookmarks,
    views: g.views?.count ? Number(g.views.count) : n.metrics.views,
  };

  // Reply / conversation pointers are reliably present in the GraphQL legacy.
  if (legacy.in_reply_to_status_id_str) {
    n.in_reply_to = legacy.in_reply_to_status_id_str;
    n.is_reply = true;
  }
  if (legacy.conversation_id_str) n.conversation_id = legacy.conversation_id_str;

  const user = g.core?.user_results?.result;
  if (user) {
    const isBlue = Boolean(user.is_blue_verified);
    const isLegacy = Boolean(user.legacy?.verified);
    n.author.verified = isBlue || isLegacy;
    n.author.verified_type = verifiedType(isBlue, isLegacy);
  }
  return n;
}

// --- Public API -----------------------------------------------------------
export async function fetchTweet(input, { enrich = "auto" } = {}) {
  const id = extractTweetId(input);
  const raw = await fetchSyndication(id);
  const tweet = normTweet(raw);

  const shouldEnrich =
    enrich === "full" || (enrich === "auto" && tweet.is_long_form);
  if (shouldEnrich) {
    const g = await fetchGraphql(id);
    applyGraphql(tweet, g);
    if (tweet.is_long_form && !g) tweet.enrich_failed = true;
  }
  tweet.raw = raw;
  return tweet;
}
