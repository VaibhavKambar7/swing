import { checkDatabase, checkWorker } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [database, worker] = await Promise.all([checkDatabase(), checkWorker()]);
  const ready = database && worker;
  return Response.json({
    service: "swing-web",
    status: ready ? "ok" : "degraded",
    checks: { database: database ? "up" : "down", worker: worker ? "up" : "down" },
  }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
