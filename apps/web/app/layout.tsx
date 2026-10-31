import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'filedeck.ai — A home for your files',
  description: 'A thoughtful personal drive for your Telegram files. Organize originals, find your favorites, and keep everything close.'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#f7faf2'
};

export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="en"><head><link rel="stylesheet" href="/fonts/fonts.css"/></head><body>{children}</body></html>;
}
