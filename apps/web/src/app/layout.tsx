import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import { FlashNotice } from '../components/flash-notice.tsx';
import { SiteHeader } from '../components/site-header.tsx';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Shared Game Management', template: '%s – Shared Game Management' },
  description: 'Manage shared games, sessions and payments',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased">
        <SiteHeader />
        <Suspense fallback={null}>
          <FlashNotice />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
