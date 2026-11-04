"use client";
import { useActionState } from "react";
import { retryJobAction } from "@/app/(workspace)/job-actions";
export function JobRetryForm({ id, finishedAt }: { id: string; finishedAt: string }) {
  const [result, action, pending] = useActionState(retryJobAction, { ok: false, message: "" });
  return <form action={action} className="settings-form feedback-form"><input type="hidden" name="id" value={id} /><input type="hidden" name="finishedAt" value={finishedAt} />
    <label>Optional retry note<textarea name="reason" maxLength={500} rows={2} disabled={pending} /></label>
    <label className="setting-option"><input type="checkbox" name="confirmed" required disabled={pending} /><span><strong>Retry this saved job</strong><span>The worker may contact providers and run AI according to the job’s existing payload. Fix the reported cause first.</span></span></label>
    <div className="form-actions"><button className="button primary" type="submit" disabled={pending}>{pending ? "Queuing…" : "Queue retry"}</button><span role="status" className={result.ok ? "muted" : "action-error"}>{result.message}</span></div></form>;
}
