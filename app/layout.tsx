import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'Sales', description: 'Grounded sales tool' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
        <div className="mx-auto max-w-6xl p-6">{children}</div>
      </body>
    </html>
  );
}
