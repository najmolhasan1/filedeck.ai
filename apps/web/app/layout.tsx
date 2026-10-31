import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'CloudNest — A home for your files',
  description: 'A thoughtful personal drive for your Telegram files. Organize originals, find your favorites, and keep everything close.'
};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="en"><head><link rel="stylesheet" href="/fonts/fonts.css"/></head><body>{children}</body></html>;
}
