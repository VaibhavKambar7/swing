"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
const links = [["/", "Overview", "◫"], ["/alerts", "Alerts", "◈"], ["/inbox", "Research inbox", "▤"], ["/briefings", "Daily briefings", "▥"], ["/watchlist", "Watchlist", "☆"], ["/settings", "Alert preferences", "⚙"], ["/system", "System status", "◉"]];
export function Navigation({ unread }: { unread?: { research: number; briefings: number } }) {
  const path = usePathname();
  return <nav aria-label="Main navigation">{links.map(([href, title, icon]) => {
    const active = href === "/" ? path === "/" : path.startsWith(href);
    return <Link key={href} href={href} className={`nav-link ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}><span aria-hidden="true" className="nav-icon">{icon}</span>{title}{unread && (href === "/inbox" || href === "/briefings") && <span className="nav-count" aria-label="unread items">{href === "/inbox" ? unread.research : unread.briefings}</span>}{active && <span className="nav-marker" />}</Link>;
  })}</nav>;
}
export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return <button className="button secondary" onClick={() => start(() => router.refresh())} disabled={pending} aria-busy={pending}><span aria-hidden="true">↻</span> {pending ? "Refreshing…" : "Refresh"}</button>;
}
