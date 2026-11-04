import Link from "next/link";
import { getDatabase } from "@/lib/db";
import { getUnreadCounts, loadRead } from "@/lib/dashboard/queries";
import { Navigation } from "../../components/dashboard/navigation";
export const dynamic = "force-dynamic";
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const counts = await loadRead(() => getUnreadCounts(getDatabase()));
  return <div className="workspace"><a className="skip-link" href="#main">Skip to content</a><aside className="sidebar"><Link className="brand" href="/" aria-label="Swing overview"><span className="brand-mark" aria-hidden="true">↗</span>Swing<span className="brand-period">.</span></Link><div className="workspace-label">PERSONAL WORKSPACE</div><Navigation unread={counts.ok ? counts.data : undefined} /><div className="sidebar-bottom"><div className="research-note"><span className="small-label">BUILT FOR PERSPECTIVE</span><p>Understand the story<br />behind the movement.</p><span>Evidence first. Always.</span></div><div className="profile"><div className="avatar">S</div><div><strong>Personal workspace</strong><span>Indian equities</span></div></div></div></aside>
    <div className="main-shell"><div className="topbar"><span>Workspace <span className="crumb-separator">/</span> <strong>Research</strong></span><span className="mode-label"><span className="mode-dot" />Frontend inbox</span></div><main id="main" className="content">{children}</main><footer className="app-footer"><span>Swing · Research with context</span><span>Assessments are unverified research notes. Check original sources.</span></footer></div></div>;
}
