import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "YANG Browser Engine - RESTCONF Console",
  description: "A browser-first YANG 1.1 engine with RESTCONF console",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
