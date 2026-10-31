import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'filedeck.ai — A home for your files',
  description: 'A thoughtful personal drive for your Telegram files. Organize originals, find your favorites, and keep everything close.',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.png', type: 'image/png', sizes: '32x32' },
      { url: '/icon.png', type: 'image/png', sizes: '512x512' }
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }
    ]
  }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#f7faf2'
};

export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" sizes="any"/>
        <link rel="icon" href="/favicon.png" type="image/png" sizes="32x32"/>
        <link rel="icon" href="/icon.png" type="image/png" sizes="512x512"/>
        <link rel="apple-touch-icon" href="/apple-touch-icon.png"/>
        <link rel="stylesheet" href="/fonts/fonts.css"/>
      </head>
      <body>{children}</body>
    </html>
  );
}
