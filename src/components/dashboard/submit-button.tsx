"use client";
import { useFormStatus } from "react-dom";
export function SubmitButton({ children, secondary = false }: { children: React.ReactNode; secondary?: boolean }) {
  const { pending } = useFormStatus();
  return <button className={`button${secondary ? " secondary" : ""}`} type="submit" disabled={pending} aria-busy={pending}>{pending ? "Saving request…" : children}</button>;
}
