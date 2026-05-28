// Shared GTM-handoff trace helpers.
//
// One owner of "what is a safe operator link" — used by BOTH the importer's
// Zod refine (write boundary) and the account page (render sink). The page
// re-checks even though the importer already validated, because an <a href> is
// a security sink and `gtm_handoff_imports.payloadJson` is opaque stored text:
// a hand-edited row with a `javascript:` URL must never reach the DOM. We
// dedupe the *rule*, not the two enforcement points.

export function isSafeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export interface GtmTraceOperatorLinks {
  consoleUrl: string | null;
  eventsUrl: string | null;
}

// Parse a stored payloadJson and return only render-safe operator links.
// Any parse failure or unsafe URL degrades to null for that link — the trace
// card simply omits the affected link rather than throwing or rendering an
// unsafe href.
export function parseOperatorLinks(payloadJson: string): GtmTraceOperatorLinks {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return { consoleUrl: null, eventsUrl: null };
  }
  const links =
    parsed && typeof parsed === "object"
      ? (parsed as { operatorLinks?: { consoleUrl?: unknown; eventsUrl?: unknown } })
          .operatorLinks
      : undefined;
  return {
    consoleUrl: isSafeHttpUrl(links?.consoleUrl),
    eventsUrl: isSafeHttpUrl(links?.eventsUrl),
  };
}
