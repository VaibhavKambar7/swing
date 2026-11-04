import Link from "next/link";
import type { ReactNode } from "react";
import type { InboxItem, InboxFilters } from "../../lib/dashboard/queries";
import { RefreshButton } from "./navigation";
export function time(value: Date | string | null | undefined) {
  if (!value) return "Not recorded";
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return "Unknown time";
  return `${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(at)} IST`;
}
export function Badge({ value, label }: { value: string; label?: string }) {
  const tone = ({ INVESTIGATE: "green", WATCH: "amber", IGNORE: "muted", PENDING: "muted", recent: "green", stale: "amber", unknown: "muted", up: "green", down: "red", degraded: "amber", unavailable: "red", disabled: "muted", failed: "red", routine: "muted", matched: "green", keep: "green", review: "amber", CAUTION: "amber", PENDING_DATA: "amber" } as Record<string, string>)[value] ?? "muted";
  return <span className={`badge ${tone}`}><span className="badge-dot" />{label ?? (value === "PENDING" ? "Unassessed" : value.replaceAll("_", " "))}</span>;
}
export function Header({ title, description, eyebrow }: { title: string; description: string; eyebrow?: string }) {
  return <header className="page-header"><div><div className="eyebrow">{eyebrow ?? "YOUR WORKSPACE"}</div><h1>{title}</h1><p>{description}</p></div><RefreshButton /></header>;
}
export function Panel({ title, subtitle, children, action, className = "" }: { title: string; subtitle?: string; children: ReactNode; action?: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><div className="panel-head"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>{children}</section>;
}
export function Empty({ title, children, error = false }: { title: string; children: ReactNode; error?: boolean }) {
  return <div className={`empty-state ${error ? "error-state" : ""}`} role={error ? "status" : undefined}><div className="empty-icon" aria-hidden="true">{error ? "!" : "↗"}</div><h3>{title}</h3><p>{children}</p></div>;
}
export function Unavailable() {
  return <div className="panel"><Empty title="Stored data is unavailable" error>Check the database connection and apply any pending migrations, then refresh. No sample records are shown in place of your data.</Empty></div>;
}
export function InboxTable({ items, compact = false }: { items: InboxItem[]; compact?: boolean }) {
  if (!items.length) return <Empty title="Nothing here yet">No records match this view. New announcements and recorded price movements will appear here after collection.</Empty>;
  return <div className="table-scroll"><table><thead><tr><th>Stock / source</th><th>Research item</th><th>Priority</th>{!compact && <th>Recorded</th>}<th><span className="sr-only">Details</span></th></tr></thead><tbody>{items.map((item) => <tr key={`${item.kind}:${item.id}`} className={item.isRead ? "" : "unread-row"}>
    <td><span className="stock-symbol">{item.symbol ?? "Unmatched"}</span><span className="cell-caption">{item.kind === "movement" ? "Price movement" : "Announcement"}</span></td>
    <td className="title-cell">{!item.isRead && <span className="review-label unread">Unread</span>}<Link className="item-title" href={`/inbox/${item.kind}/${item.id}`}>{item.title}</Link>{item.summary ? <p className="row-summary">{item.summary}</p> : <span className="cell-caption">{item.relevance === "routine" ? "Routine notice · retained in inbox" : "No stored research assessment"}</span>}{item.changePct && <span className={`change ${Number(item.changePct) >= 0 ? "positive" : "negative"}`}>{Number(item.changePct) >= 0 ? "+" : ""}{Number(item.changePct).toFixed(2)}% observed move</span>}</td>
    <td><Badge value={item.classification} /></td>{!compact && <td className="time-cell">{time(item.recordedAt)}</td>}
    <td><Link className="arrow-link" href={`/inbox/${item.kind}/${item.id}`} aria-label={`Open ${item.title}`}>↗</Link></td>
  </tr>)}</tbody></table></div>;
}
export function inboxUrl(filters: InboxFilters, page: number) {
  return `/inbox?${new URLSearchParams({ kind: filters.kind, classification: filters.classification, stock: filters.stock, read: filters.read, page: String(page) })}`;
}
export function Metric({ label, value, note, accent }: { label: string; value: string | number; note: string; accent?: boolean }) {
  return <div className={`metric ${accent ? "accent" : ""}`}><span className="metric-label">{label}</span><strong>{typeof value === "number" ? value.toLocaleString("en-IN") : value}</strong><span className="metric-note">{note}</span></div>;
}
export function DefinitionList({ values }: { values: Record<string, ReactNode> }) {
  return <dl className="definition-list">{Object.entries(values).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>;
}
export function Note({ children }: { children: ReactNode }) { return <p className="note"><span aria-hidden="true">ⓘ</span> {children}</p>; }
