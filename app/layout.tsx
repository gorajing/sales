import './globals.css';
import type { ReactNode } from 'react';
import Link from 'next/link';

export const metadata = { title: 'Sales', description: 'Grounded sales tool' };

/**
 * Root shell. Simple top nav that lists the major v2 surfaces:
 *
 *   - "/"        accounts list (existing v1 landing)
 *   - "/inbound" top scores + recent signals (Task 1.10)
 *   - "/alerts"  alert feed with Acknowledge action (Task 2.3)
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
            <Link href="/alerts" className="hover:underline">Alerts</Link>
          </nav>
        </header>
        <div className="mx-auto max-w-6xl p-6">{children}</div>
      </body>
    </html>
  );
}
