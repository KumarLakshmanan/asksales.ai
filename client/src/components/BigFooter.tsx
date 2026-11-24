import Link from "next/link";
import { BRAND_NAME, COMPANY_NAME } from "@/lib/brand";
import { comparisonLinks } from "@/lib/comparisons";

const columns = [
  {
    label: "Product",
    links: [
      ["Agents", "/agents"],
      ["Workspace", "/dashboard"],
      ["Pricing", "/pricing"],
      ["Documentation", "/documentation"],
      ["Lead generation", "/agents/lead-generation"],
      ["Content studio", "/agents/content-studio"],
    ],
  },
  {
    label: "Compare",
    links: [
      ["All comparisons", "/compare"] as const,
      ...comparisonLinks.map(({ name, slug }) => [`vs ${name}`, `/compare/${slug}`] as const),
    ],
  },
  {
    label: "Company",
    links: [
      ["About", "/about"],
      ["Contact", "/contact"],
      ["Privacy", "/privacy"],
      ["Terms", "/terms"],
      ["Account deletion", "/account-deletion"],
    ],
  },
] as const;

export default function BigFooter() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto max-w-[1440px] px-5 py-12 sm:px-8 sm:py-16 lg:px-12">
        <div className="grid gap-12 border-b border-border pb-12 lg:grid-cols-[1.4fr_1fr] lg:gap-24">
          <div className="max-w-xl">
            <Link href="/" className="inline-flex items-center gap-2.5" aria-label={`${BRAND_NAME} home`}>
              <img src="/logos/asksales_logo.svg" alt="" className="h-8 w-8 object-contain" />
              <span className="text-base font-semibold tracking-tight">{BRAND_NAME}</span>
            </Link>
            <p className="mt-6 text-balance text-lg leading-8 text-muted-foreground">
              A coordinated sales and marketing workspace where campaigns, resources, approvals, and provider status stay visible from request to result.
            </p>
            <div className="mt-8 grid grid-cols-2 border-y border-border text-sm sm:grid-cols-4">
              {["Request", "Prepare", "Approve", "Reconcile"].map((step, index) => (
                <div key={step} className="border-r border-border px-3 py-3 last:border-r-0">
                  <span className="font-mono text-[10px] text-muted-foreground">0{index + 1}</span>
                  <p className="mt-1 font-medium">{step}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3">
            {columns.map((column) => (
              <div key={column.label}>
                <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{column.label}</h2>
                <ul className="mt-5 space-y-3">
                  {column.links.map(([label, href]) => (
                    <li key={href}><Link href={href} className="text-sm hover:text-primary">{label}</Link></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-6 pt-7 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} {BRAND_NAME} · {COMPANY_NAME}</p>
          <div className="flex items-center gap-4">
            <span>State is confirmed by durable records and provider receipts.</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
