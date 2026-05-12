import Link from 'next/link';
import { truncate } from './format';

/**
 * One row in the Inbound page's "Recent signals" table.
 *
 * Server-rendered. Timestamps use `toLocaleString()` for human-readable
 * display — that runs server-side here, so the rendered output is keyed
 * to the *server's* locale, not the operator's browser. For v2 with one
 * operator running locally that's a non-issue; v1.5 might want a client
 * formatter for per-user time zones.
 *
 * The account link is opt-in via `accountId` — when the row's account
 * doesn't have a domain (or the lookup missed), we still render the
 * row without a dangling link. Empty/missing account renders as "—".
 */
export function SignalRow({
  capturedAt, sourceType, signalType, snippet, accountId, accountLabel,
}: {
  capturedAt: string;
  sourceType: string;
  /** schema.evidence.signalType is NOT NULL DEFAULT 'none'; the column
   *  never carries null, so the prop type stays string. The Recent-signals
   *  query in lib/inbound/queries.ts already filters `!= 'none'`, so this
   *  value will be one of the non-'none' enum members at render time. */
  signalType: string;
  snippet: string;
  accountId: string;
  /** Display label for the account (domain or name). Null if unknown. */
  accountLabel: string | null;
}) {
  const ts = new Date(capturedAt).toLocaleString();
  return (
    <tr className="border-b">
      <td className="py-1 px-2 text-xs text-slate-500 whitespace-nowrap">{ts}</td>
      <td className="py-1 px-2 font-mono text-xs">{sourceType}</td>
      <td className="py-1 px-2 font-mono text-xs text-slate-500">{signalType}</td>
      <td className="py-1 px-2 text-xs">
        {accountLabel ? (
          <Link href={`/accounts/${accountId}`} className="text-blue-700 hover:underline">
            {accountLabel}
          </Link>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className="py-1 px-2 text-xs text-slate-700">{truncate(snippet, 120)}</td>
    </tr>
  );
}
