"use client";
import { useActionState } from "react";
import { updateFeedback } from "@/app/(workspace)/feedback-actions";
export function FeedbackForm({ kind, id, version, feedback }: {
  kind: "announcement" | "movement" | "briefing"; id: string; version: string;
  feedback: { useful: boolean; reason: string | null } | null;
}) {
  const [result, action, pending] = useActionState(updateFeedback, { ok: false, message: "" });
  return <form action={action} className="settings-form feedback-form"><input type="hidden" name="kind" value={kind} /><input type="hidden" name="id" value={id} /><input type="hidden" name="version" value={version} />
    <p>{feedback ? `Your feedback: ${feedback.useful ? "Useful" : "Not useful"}` : "Was this version useful to you?"}</p>
    <label>Optional note<textarea name="reason" maxLength={500} rows={3} defaultValue={feedback?.reason ?? ""} placeholder="What made this helpful or unhelpful?" disabled={pending} /></label>
    <div className="form-actions"><button className="button secondary" type="submit" name="choice" value="useful" aria-pressed={feedback?.useful === true} disabled={pending}>👍 Useful</button><button className="button secondary" type="submit" name="choice" value="not-useful" aria-pressed={feedback?.useful === false} disabled={pending}>👎 Not useful</button>{feedback && <button className="button secondary" type="submit" name="choice" value="clear" disabled={pending}>Clear feedback</button>}</div>
    <p role="status" className={result.ok ? "muted" : "action-error"}>{pending ? "Saving…" : result.message}</p></form>;
}
