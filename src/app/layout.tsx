import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Swing | Market research assistant",
  description: "Personal Indian stock research, with evidence and context.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
