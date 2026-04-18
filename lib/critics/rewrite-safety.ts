/**
 * Structural safety check for critic-suggested rewrites.
 *
 * Rejects rewrites that:
 *  1. Introduce a sender title, role, or authority claim not in the original.
 *  2. Introduce or change numbers, dates, times, or times-of-day.
 *  3. Contain forbidden characters (em dashes).
 *
 * A rejected rewrite returns { ok: false, reason }. The caller should null
 * the suggested_rewrite and optionally prepend the reason to the issue text.
 */

const TITLE_PATTERNS = [
  // Head of X, VP of X, Director of X, Chief X Officer, etc.
  /\b(Head of|VP of|Vice President of|Director of|Manager of|Lead of|Chief [A-Z][a-z]+ Officer|C[A-Z]O)\s+[A-Z][A-Za-z ]+\b/,
  // Bare C-suite acronyms as title assertions
  /\b(CEO|CTO|CFO|COO|CMO|CRO|CHRO|Founder|Co-founder|President|EVP|SVP)\b/,
  // "Title: X" patterns
  /\b(Head|VP|Director|Manager|Lead)\s*,\s*[A-Z]/,
];

const NUMBER_RE = /\b\d+(?:[.,]\d+)?\s*%?\b/g;
const TIME_RE =
  /\b(?:\d{1,2}:\d{2}|\d{1,2}\s*(?:am|pm|AM|PM)|\d{1,2}\s*(?:a\.m\.|p\.m\.)|\d{1,2}-\d{1,2}\s*(?:am|pm))\b/g;
const DAY_RE =
  /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/gi;

const FORBIDDEN_CHARS = ['—']; // em dash

function extractTokens(text: string, re: RegExp): Set<string> {
  const matches = text.match(re) ?? [];
  return new Set(matches.map((m) => m.toLowerCase().replace(/\s+/g, '')));
}

export interface SafetyResult {
  ok: boolean;
  reason?: string;
}

export function validateRewrite(original: string, rewrite: string): SafetyResult {
  // 1. Forbidden characters (style)
  for (const c of FORBIDDEN_CHARS) {
    if (rewrite.includes(c)) {
      return { ok: false, reason: `rewrite uses forbidden character '${c}' (em dash)` };
    }
  }

  // 2. Number check — any number in rewrite that isn't in original
  const origNums = extractTokens(original, NUMBER_RE);
  const rewNums = extractTokens(rewrite, NUMBER_RE);
  for (const n of rewNums) {
    if (!origNums.has(n)) {
      return { ok: false, reason: `rewrite introduces number "${n}" not in original` };
    }
  }

  // 3. Time check
  const origTimes = extractTokens(original, TIME_RE);
  const rewTimes = extractTokens(rewrite, TIME_RE);
  for (const t of rewTimes) {
    if (!origTimes.has(t)) {
      return { ok: false, reason: `rewrite introduces time "${t}" not in original` };
    }
  }

  // 4. Day / month check
  const origDays = extractTokens(original, DAY_RE);
  const rewDays = extractTokens(rewrite, DAY_RE);
  for (const d of rewDays) {
    if (!origDays.has(d)) {
      return { ok: false, reason: `rewrite introduces day/month "${d}" not in original` };
    }
  }

  // 5. Title patterns
  for (const re of TITLE_PATTERNS) {
    const rewMatch = rewrite.match(re);
    if (rewMatch) {
      // The title appears in rewrite. Does it also appear in original (same token)?
      const titleToken = rewMatch[0];
      if (!original.toLowerCase().includes(titleToken.toLowerCase())) {
        return {
          ok: false,
          reason: `rewrite introduces title/role "${titleToken}" not in original`,
        };
      }
    }
  }

  return { ok: true };
}
