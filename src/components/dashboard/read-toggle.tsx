"use client";
import { useActionState } from "react";
import { updateReadState } from "@/app/(workspace)/actions";
export function ReadToggle({ kind, id, version, isRead }: { kind: "announcement" | "movement" | "briefing"; id: string; version: string; isRead: boolean }) {
  const [result, action, pending] = useActionState(updateReadState, { ok: false, message: "" });
  return <form action={action} className="read-controls">
    <input type="hidden" name="kind" value={kind} /><input type="hidden" name="id" value={id} />
    <input type="hidden" name="version" value={version} /><input type="hidden" name="state" value={isRead ? "unread" : "read"} />
    <span className={`review-label ${isRead ? "" : "unread"}`}>{isRead ? "Read" : "Unread"}</span>
    <button className="button secondary" type="submit" disabled={pending} aria-busy={pending}>{pending ? "Saving…" : isRead ? "Mark unread" : "Mark read"}</button>
    <span role="status" className={result.ok ? "muted" : "action-error"}>{result.message}</span>
  </form>;
}
