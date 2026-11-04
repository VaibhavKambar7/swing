import Link from "next/link";
export function pageNumber(value: unknown) { const n = Number(value ?? 1); return Number.isSafeInteger(n) && n >= 1 && n <= 100000 ? n : 1; }
export function Pagination({ page, hasNext, base }: { page: number; hasNext: boolean; base: string }) {
  const href = (n: number) => `${base}${base.includes("?") ? "&" : "?"}page=${n}`;
  return <nav aria-label="History pages" className="pagination">{page > 1 && <Link href={href(page - 1)}>← Newer</Link>}<span>Page {page}</span>{hasNext && <Link href={href(page + 1)}>Older →</Link>}</nav>;
}
