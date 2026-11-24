import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import styles from "./proposals.module.css";

export function ProposalPageHeader({ title, description, actions, back = false }: {
  title: string;
  description: string;
  actions?: ReactNode;
  back?: boolean;
}) {
  return <div>
    {back && <Link href="/dashboard/proposals" className={styles.back}><ArrowLeft aria-hidden="true" className="h-4 w-4"/>Back to proposals</Link>}
    <header className={styles.header}>
      <div className={styles.heading}><h1 className={styles.title}>{title}</h1><p className={styles.subtitle}>{description}</p></div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  </div>;
}
