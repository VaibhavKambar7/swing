"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";

type Activity = { revision: string; unreadAlerts: number; checkedAt: string };
function validActivity(value: unknown): value is Activity {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.revision === "string" && /^[a-f0-9]{64}$/.test(v.revision)
    && typeof v.unreadAlerts === "number" && Number.isSafeInteger(v.unreadAlerts) && v.unreadAlerts >= 0
    && typeof v.checkedAt === "string" && Number.isFinite(Date.parse(v.checkedAt));
}
export function ActivityMonitor() {
  const router = useRouter();
  const path = usePathname();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [connection, setConnection] = useState<"checking" | "up" | "down">("checking");
  const [hasUpdates, setHasUpdates] = useState(false);
  const [pending, start] = useTransition();
  const revision = useRef<string | null>(null);
  const dirty = useRef(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let running = false;
    let failures = 0;
    dirty.current = false;
    const markDirty = (event: Event) => {
      if (event.target instanceof HTMLElement && event.target.closest("form")) dirty.current = true;
    };
    const submitted = () => { dirty.current = false; };
    const poll = async () => {
      if (stopped || running) return;
      if (document.visibilityState !== "visible" || !navigator.onLine) {
        if (!navigator.onLine) setConnection("down");
        return;
      }
      running = true;
      request = new AbortController();
      try {
        const response = await fetch("/api/workspace/activity", { cache: "no-store", credentials: "same-origin", redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]) });
        if (!response.ok) throw new Error("Unavailable");
        const data: unknown = await response.json();
        if (!validActivity(data)) throw new Error("Invalid activity");
        if (stopped) return;
        const changed = revision.current !== null && revision.current !== data.revision;
        revision.current = data.revision;
        setActivity(data); setConnection("up"); failures = 0;
        if (changed) {
          setHasUpdates(true);
          const listPage = ["/", "/alerts", "/inbox", "/briefings", "/feedback"].includes(path);
          if (listPage && !dirty.current && !document.activeElement?.closest("form")) {
            start(() => router.refresh()); setHasUpdates(false);
          }
        }
      } catch {
        if (!stopped) { failures++; setConnection("down"); }
      } finally {
        running = false;
        if (!stopped) timer = setTimeout(() => void poll(), Math.min(120000, 30000 * 2 ** Math.min(failures, 2)));
      }
    };
    const resume = () => {
      if (timer) clearTimeout(timer);
      if (!running) void poll();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    document.addEventListener("input", markDirty);
    document.addEventListener("change", markDirty);
    document.addEventListener("submit", submitted);
    void poll();
    return () => {
      stopped = true; request?.abort(); if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume); window.removeEventListener("offline", resume);
      document.removeEventListener("input", markDirty); document.removeEventListener("change", markDirty); document.removeEventListener("submit", submitted);
    };
  }, [path, retry, router]);
  return <div className="activity-monitor" aria-live="polite">
    <Link className="text-link" href="/alerts?read=unread">{activity ? `${activity.unreadAlerts} unread alerts` : "Alerts"}</Link>
    <span className="activity-state">{connection === "checking" ? "Checking updates…" : connection === "down" ? "Update checks unavailable" : pending ? "Refreshing…" : "Checking every 30s"}</span>
    {hasUpdates && <button className="button secondary" disabled={pending} onClick={() => { start(() => router.refresh()); setHasUpdates(false); dirty.current = false; }}>Refresh to see updates</button>}
    {connection === "down" && <button className="button secondary" onClick={() => setRetry((v) => v + 1)}>Retry updates</button>}
  </div>;
}
