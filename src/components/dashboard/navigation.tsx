"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
const links = [["/", "Overview", "◫"], ["/inbox", "Research inbox", "▤"], ["/briefings", "Daily briefings", "▥"], ["/system", "System status", "◉"]];
export function Navigation() {
  const path = usePathname();
  return <nav aria-label="Main navigation">{links.map(([href, title, icon]) => {
    const active = href === "/" ? path === "/" : path.startsWith(href);
    return <Link key={href} href={href} className={`nav-link ${active ? "active" : ""}`} aria-current={active ? "page" : undefined}><span aria-hidden="true" className="nav-icon">{icon}</span>{title}{active && <span className="nav-marker" />}</Link>;
  })}</nav>;
}
export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return <button className="button secondary" onClick={() => start(() => router.refresh())} disabled={pending} aria-busy={pending}><span aria-hidden="true">↻</span> {pending ? "Refreshing…" : "Refresh"}</button>;
}
