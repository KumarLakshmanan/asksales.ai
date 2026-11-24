const workflow = [
  ["Brief", "Define the audience and outcome"],
  ["Prepare", "Agents create reviewable resources"],
  ["Approve", "Authorize the exact action once"],
  ["Execute", "Queue provider work idempotently"],
  ["Reconcile", "Track receipts and partial failure"],
];

export default function LogoMarquee() {
  return (
    <section aria-label="Campaign workflow" className="border-b border-border bg-background">
      <ol className="mx-auto grid max-w-[1440px] sm:grid-cols-2 lg:grid-cols-5">
        {workflow.map(([label, description], index) => (
          <li key={label} className="border-b border-border px-5 py-5 sm:border-r lg:border-b-0 lg:last:border-r-0">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">{label}</span>
              <span aria-hidden="true" className="font-mono text-xs text-muted-foreground">0{index + 1}</span>
            </div>
            <p className="mt-2 text-sm leading-5 text-muted-foreground">{description}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
