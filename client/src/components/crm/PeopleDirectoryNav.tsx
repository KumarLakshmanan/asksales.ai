import Link from "next/link";
import { cn } from "@/lib/utils";

interface PeopleDirectoryNavProps {
  current: "leads" | "contacts";
}

export function PeopleDirectoryNav({ current }: PeopleDirectoryNavProps) {
  return (
    <nav aria-label="People directories" className="flex w-fit gap-1 rounded-[10px] border border-border bg-muted/50 p-1">
      {[
        { key: "leads", label: "Leads", href: "/dashboard/leads" },
        { key: "contacts", label: "CRM Contacts", href: "/dashboard/crm/contacts" },
      ].map(({ key, label, href }) => (
        <Link key={key} href={href} aria-current={current === key ? "page" : undefined}
          className={cn("flex min-h-10 items-center rounded-[7px] px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            current === key ? "bg-card text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground")}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
