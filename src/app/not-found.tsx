import Link from "next/link";
export default function NotFound() {
  return <main className="content"><div className="panel"><div className="empty-state"><h1>Record not found</h1><p>This page or record is not available.</p><Link className="button secondary" href="/inbox">Back to research inbox</Link></div></div></main>;
}
