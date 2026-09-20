import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { CSPostHogProvider, PostHogPageview } from "./providers";
import { Suspense } from "react";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TangleClaw | AI-Native SDLC Orchestration",
  description: "An open-source, local-first AI-native SDLC orchestration platform. Automate and manage your software development lifecycle securely.",
  openGraph: {
    title: "TangleClaw",
    description: "An open-source, local-first AI-native SDLC orchestration platform.",
    url: "https://tangleclaw.dev",
    siteName: "TangleClaw",
    images: [
      {
        url: "/logo.png",
        width: 800,
        height: 600,
        alt: "TangleClaw Logo",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "TangleClaw",
    description: "An open-source, local-first AI-native SDLC orchestration platform.",
    images: ["/logo.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <CSPostHogProvider>
        <body className="min-h-full flex flex-col">
          <Suspense fallback={null}>
            <PostHogPageview />
          </Suspense>
          {children}
        </body>
      </CSPostHogProvider>
    </html>
  );
}
