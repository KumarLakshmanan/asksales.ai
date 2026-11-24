/** Badge classes for support ticket statuses. */
export const SUPPORT_STATUS_CLASSES: Record<string, string> = {
  open: "bg-info/10 text-info",
  in_progress: "bg-warning/10 text-warning",
  waiting_on_customer: "bg-primary/10 text-primary",
  resolved: "bg-success/10 text-success",
  closed: "bg-muted text-muted-foreground",
};

/** Badge classes for support ticket priorities. */
export const SUPPORT_PRIORITY_CLASSES: Record<string, string> = {
  low: "bg-muted text-muted-foreground", medium: "bg-warning/10 text-warning",
  high: "bg-info/10 text-info", urgent: "bg-destructive/10 text-destructive", critical: "bg-destructive/15 text-destructive",
};
