import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Rolodeck AI",
  description: "A swipeable deck of Bay Area startup profiles.",
};

/**
 * Nothing here is prerenderable, including the pages Next would otherwise build statically for
 * itself. The Content-Security-Policy in `lib/http/security-headers.ts` nonces the inline
 * scripts Next emits, and a nonce is minted per request: HTML baked at build time carries a
 * nonce from a request that never happened, so every script on it is refused. `(app)` already
 * says this for the Deck, which reads a session; this says it for `/login` and for `_not-found`
 * too. See docs/adr/0006.
 */
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
