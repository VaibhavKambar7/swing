import { getDatabase } from "@/lib/db";
import { getWorkspaceActivity } from "@/lib/dashboard/activity";
export const dynamic = "force-dynamic";
export async function GET() {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  try { return Response.json(await getWorkspaceActivity(getDatabase()), { headers }); }
  catch { return Response.json({ code: "WORKSPACE_UNAVAILABLE" }, { status: 503, headers }); }
}
