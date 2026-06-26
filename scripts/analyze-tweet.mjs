#!/usr/bin/env node
// Tweet -> fact-check SCAFFOLD for an AI to act on.
//
// This script does NOT itself reason or search (no LLM here). It fetches the
// tweet and computes cheap heuristic signals (numbers, stats/causal/sensational
// language, links, author credibility), splits out candidate claims, and drafts
// search queries + a rubric. The consuming AI then runs the searches and writes
// the verdict. This keeps the tool zero-dependency and API-key-free.
//
// Usage:
//   node analyze-tweet.mjs <url-or-id> [--compact]

import { fetchTweet, TweetError } from "../lib/tweet.mjs";

const args = process.argv.slice(2);
const compact = args.includes("--compact");
const input = args.find((a) => !a.startsWith("--"));

if (!input) {
  console.log(JSON.stringify({ error: "Usage: node analyze-tweet.mjs <url-or-id>" }));
  process.exit(1);
}

const RE = {
  percentages: /\b\d+(?:\.\d+)?\s?%/g,
  bigNumbers: /\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s?(?:thousand|million|billion|trillion|k|m|bn)\b/gi,
  statTerms: /\b(study|studies|research|researchers|survey|data|participants?|trial|clinical|peer[- ]reviewed|journal|sample|cohort|meta[- ]analysis|statistics?|percent)\b/gi,
  causal: /\b(causes?|caused|causing|increases?|increased|reduces?|reduced|leads? to|linked to|associated with|results? in|due to|triggers?|prevents?|cures?)\b/gi,
  sensational: /\b(massive(?:ly)?|shocking|bombshell|breaking|exposed?|banned|secret|they don'?t want|the truth|wake up|huge|insane|unbelievable|quadruples?|skyrockets?|explodes?)\b/gi,
  absolutes: /\b(always|never|all|none|every(?:one|body)?|no ?one|nobody|proven|guaranteed|100%|undeniable)\b/gi,
  health: /\b(cancer|melanoma|vaccine|covid|virus|disease|risk|drug|medication|mortality|death|diet|nutrition|cholesterol|sunscreen|fluoride|autism|tumou?r|infection|immune)\b/gi,
  finance: /\b(stock|crypto|bitcoin|market|recession|inflation|interest rate|returns?|profit|crash|bubble)\b/gi,
  quote: /["“”']/,
};

const uniq = (arr) => [...new Set(arr.map((s) => s.trim()))].filter(Boolean);
const matches = (re, t) => uniq([...(t.match(re) || [])]);

// Capitalized multi-word sequences = likely named entities (studies, orgs...).
function entities(text) {
  return uniq([...(text.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){1,3})\b/g) || [])])
    .filter((e) => e.split(/\s+/).length >= 2)
    .slice(0, 6);
}

// Split into candidate claims: sentences / lines, dropping url-only fragments.
function claimCandidates(text) {
  return uniq(
    text
      .replace(/https?:\/\/\S+/g, "")
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
  ).filter((s) => s.length > 25);
}

const STOP = new Set(
  "a an the of to in on for and or but with without from by as at is are was were be been being this that these those it its their his her your you we they he she has have had do does did not no will would can could should may might must major more most than have been according found using used involving about into over under per them then there here just also new study studies".split(" ")
);

// Salient keywords: content words, minus stopwords and the sensational/causal
// noise we already flagged, ranked by length (a cheap specificity proxy).
function keywords(text, exclude, n = 6) {
  const ex = new Set(exclude.map((w) => w.toLowerCase()));
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#@]\w+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w) && !ex.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, n);
}

function buildQueries(text, ents, noise, observational) {
  const kw = keywords(text, noise);
  const core = kw.slice(0, 5).join(" ");
  const anchor = ents[0] ? `${ents[0]} ` : "";
  const q = [
    `${anchor}${kw.slice(0, 4).join(" ")} study`.trim(),
    `${anchor}${core} fact check`.trim(),
  ];
  if (observational) q.push(`${core} reverse causation confounding`.trim());
  q.push(`${ents[0] || kw.slice(0, 4).join(" ")} scientific consensus expert`.trim());
  return uniq(q).filter((s) => s.replace(/\s+/g, "").length > 4);
}

const RUBRIC = `You are fact-checking the tweet above. Do NOT trust the tweet's framing.
Steps:
1. For each item in claim_candidates, decide if it is a checkable factual claim (vs opinion/joke).
2. Run web searches (start from suggested_queries, refine as needed). Prefer primary sources, peer-reviewed studies, and reputable outlets; treat low-quality/partisan blogs as amplifiers, not evidence.
3. Watch for the common manipulations the signals hint at: reverse causation / confounding in observational studies, cherry-picked stats, missing base rates, correlation≠causation, misrepresented study scope, sensational framing.
4. Produce a verdict per claim and an overall verdict.
Output format (markdown card):
- Claim(s) restated plainly
- Verdict: supported | misleading | false | unverifiable | opinion
- Why (2-5 bullets, mechanism of any error)
- What the evidence actually says
- Source credibility (account verified_type is a PAID badge, not identity/expertise; note amplifying domains)
- Sources (markdown links, each tagged reliable / low-quality)`;

try {
  const t = await fetchTweet(input, { enrich: "full" });
  const text = t.text || "";
  const ents = entities(text);

  const signals = {
    percentages: matches(RE.percentages, text),
    big_numbers: matches(RE.bigNumbers, text),
    statistic_terms: matches(RE.statTerms, text),
    causal_language: matches(RE.causal, text),
    sensational_language: matches(RE.sensational, text),
    absolutes: matches(RE.absolutes, text),
    topic_health: RE.health.test(text),
    topic_finance: RE.finance.test(text),
    has_quote: RE.quote.test(text),
    external_links: t.urls.map((u) => u.url),
    named_entities: ents,
  };
  const checkable =
    signals.percentages.length > 0 ||
    signals.big_numbers.length > 0 ||
    signals.statistic_terms.length > 0 ||
    signals.causal_language.length > 0 ||
    signals.external_links.length > 0;

  const sensationalScore =
    signals.sensational_language.length + signals.absolutes.length;

  const out = {
    tweet: {
      id: t.id, url: t.url, text: t.text, created_at: t.created_at,
      author: {
        name: t.author?.name, handle: t.author?.handle,
        verified: t.author?.verified, verified_type: t.author?.verified_type,
      },
      metrics: t.metrics,
      media_types: t.media.map((m) => m.type),
    },
    signals,
    checkable,
    claim_candidates: claimCandidates(text),
    suggested_queries: buildQueries(
      text,
      ents,
      [...signals.sensational_language, ...signals.causal_language, ...signals.absolutes],
      signals.causal_language.length > 0 && signals.statistic_terms.length > 0
    ),
    credibility: {
      verified_type: t.author?.verified_type,
      note:
        t.author?.verified_type === "blue"
          ? "Blue is a PAID checkmark — not identity verification or topical expertise."
          : t.author?.verified_type === "legacy"
          ? "Legacy verified (identity), not a guarantee of expertise."
          : "Unverified account.",
      reach: { views: t.metrics.views, reposts: t.metrics.retweets, likes: t.metrics.likes },
      sensational_score: sensationalScore,
    },
    instructions: RUBRIC,
  };

  console.log(JSON.stringify(out, null, compact ? 0 : 2));
} catch (e) {
  console.log(JSON.stringify({ error: e instanceof TweetError ? e.message : String(e?.message ?? e) }));
  process.exit(1);
}
