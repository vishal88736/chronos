import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chronos · minimi",
  description:
    "Ambient, promise-aware web research with a live glass-box telemetry inspector.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#090A0F" },
    { media: "(prefers-color-scheme: light)", color: "#F6F7FB" },
  ],
  colorScheme: "dark light",
  width: "device-width",
  initialScale: 1,
};

const themeScript = `(function(){try{var stored=localStorage.getItem("chronos-theme");var theme=(stored==="light"||stored==="dark")?stored:(window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");document.documentElement.dataset.theme=theme;}catch(error){document.documentElement.dataset.theme="dark";}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
