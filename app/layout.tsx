import type { Metadata, Viewport } from 'next'
import { Fira_Code } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import { ThemeProvider } from 'next-themes'
import './globals.css'

const firaCode = Fira_Code({
  subsets: ['latin'],
  variable: '--font-fira',
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
  preload: true,
})

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#d9d9d9' },
    { media: '(prefers-color-scheme: dark)',  color: '#111111' },
  ],
  userScalable: true,
}

export const metadata: Metadata = {
  title: 'hotelsoap* — Free BPM & Key Detection | Audio Analyzer',
  description:
    'Free online BPM detector and musical key finder. Instantly analyze any audio file — detect tempo, find the key (major/minor), trim silence, and download a properly named WAV. No upload, 100% in-browser. Perfect for DJs, producers, and musicians.',
  keywords: [
    'bpm detection', 'bpm detector', 'bpm finder', 'bpm counter',
    'free bpm detector', 'online bpm detector', 'bpm analyzer',
    'key detection', 'key detector', 'key finder', 'musical key detection',
    'audio key detection', 'song key finder', 'find key of a song',
    'free key detection', 'online key detector', 'camelot key',
    'bpm and key detection', 'bpm key analyzer', 'audio analyzer',
    'tempo detection', 'tempo finder', 'beat detection',
    'silence trimmer', 'audio trim silence', 'wav export',
    'dj tools', 'music production tools', 'audio tools online',
    'free music analysis', 'find song bpm free', 'detect bpm online free',
  ],
  authors: [{ name: 'hotelsoap' }],
  creator: 'hotelsoap',
  openGraph: {
    title: 'hotelsoap* — Free BPM & Key Detection Online',
    description:
      'Instantly detect the BPM and musical key of any audio file, free. No upload required — all processing happens in your browser.',
    type: 'website',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'hotelsoap* — Free BPM & Key Detection Online',
    description:
      'Free in-browser BPM detector and key finder for DJs and producers. Supports WAV, MP3, M4A.',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-snippet': -1 },
  },
  icons: {
    icon: [
      { url: '/icon-light-32x32.png', media: '(prefers-color-scheme: light)' },
      { url: '/icon-dark-32x32.png',  media: '(prefers-color-scheme: dark)'  },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-icon.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={firaCode.variable}>
      <body className="font-mono antialiased lowercase">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <Analytics />
        </ThemeProvider>
      </body>
    </html>
  )
}
