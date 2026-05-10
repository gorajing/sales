import './globals.css';
import type { ReactNode } from 'react';
import Link from 'next/link';

export const metadata = { title: 'Sales', description: 'Grounded sales tool' };

/**
 * Root shell. Simple top nav that links to the major v2 surfaces:
 *
 *   - "/"        accounts list (existing v1 landing)
 *   - "/inbound" top scores + recent signals (Task 1.10)
 *   - "/alerts"  alert feed (404 until Task 2.3 ships — link is harmless
 *                until then; "Coming soon" hint included so an operator
 *                doesn't click expecting a working page)
 *
 * Nothing here owns auth — single-operator local-process deployment, so
 * a tenant-aware shell would be overkill for v2.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
        <header className="border-b bg-white">
          <nav className="mx-auto max-w-6xl px-6 py-3 flex items-center gap-4 text-sm">
            <Link href="/" className="font-semibold">Sales</Link>
            <span className="text-neutral-300" aria-hidden="true">·</span>
            <Link href="/" className="hover:underline">Accounts</Link>
            <Link href="/inbound" className="hover:underline">Inbound</Link>
            {/* /alerts isn't shipped yet; render a non-link placeholder
                so keyboard / screen-reader users aren't promised a
                working page. Pure CSS `text-neutral-400` would only
                convey "disabled" to sighted users — aria-disabled +
                visible "(soon)" suffix announces the state across
                modalities. Swap back to a real <Link> when Task 2.3
                lands. */}
            <span
              className="text-neutral-400 cursor-not-allowed"
              aria-disabled="true"
              title="Coming soon (Task 2.3)"
            >
              Alerts <span className="text-xs">(soon)</span>
            </span>
          </nav>
        </header>
        <div className="mx-auto max-w-6xl p-6">{children}</div>
      </body>
    </html>
  );
}
