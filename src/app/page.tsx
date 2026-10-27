export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center gap-8 px-6 py-16">
      <div className="flex items-center gap-3 text-sm tracking-wide text-emerald-400">
        <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true" />
        PERSONAL MARKET RESEARCH
      </div>
      <div>
        <h1 className="text-6xl font-semibold tracking-tight sm:text-8xl">Swing<span className="text-emerald-400">.</span></h1>
        <p className="mt-6 max-w-xl text-lg leading-8 text-slate-400">Find the signal. Understand the story. Research Indian stocks with market context and traceable evidence.</p>
      </div>
      <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6" aria-labelledby="foundation-title">
        <p className="text-xs font-medium uppercase tracking-widest text-slate-500">Task 01</p>
        <h2 id="foundation-title" className="mt-2 text-xl font-medium">The foundation is in place</h2>
        <p className="mt-3 leading-7 text-slate-400">Next.js application, a persistent TypeScript worker, and PostgreSQL with Prisma. Market monitoring and alerts are coming in the next tasks.</p>
        <div className="mt-6 flex flex-wrap gap-4 text-sm">
          <a className="rounded-lg bg-emerald-400 px-4 py-2 font-medium text-slate-950 hover:bg-emerald-300 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-400" href="/api/health/ready">Check system readiness</a>
          <a className="rounded-lg border border-slate-700 px-4 py-2 text-slate-200 hover:border-slate-500 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-400" href="/api/health/live">Check web process</a>
        </div>
      </section>
      <p className="text-sm text-slate-500">Research leads for your review. No automated trades.</p>
    </main>
  );
}
