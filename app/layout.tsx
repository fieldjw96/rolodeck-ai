import type { Metadata } from "next";
import { Bricolage_Grotesque, DM_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// The display and body face: a variable font, so the heavy weight needs no extra file.
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
});

// The label face: not variable, so it names the two weights the stylesheets ask for.
const dmMono = DM_Mono({
  variable: "--font-dm-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
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
    <html lang="en" className={`${bricolage.variable} ${dmMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
