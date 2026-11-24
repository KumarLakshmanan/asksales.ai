/**
 * Unified status color mapping for content cards.
 * Returns Tailwind classes for badge/status display.
 */
export function getStatusColor(status: string | undefined): string {
  switch (status?.toLowerCase()) {
    // Generation statuses
    case "generated":
    case "complete":
      return "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300";
    case "pending":
    case "generating":
      return "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300";
    // Content statuses
    case "sent":
    case "published":
      return "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300";
    case "draft":
      return "bg-gray-100 text-gray-800 dark:bg-muted dark:text-muted-foreground";
    case "scheduled":
      return "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300";
    case "active":
      return "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300";
    case "paused":
      return "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
    case "delivered":
      return "bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-300";
    case "failed":
      return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300";
    default:
      return "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300";
  }
}

/**
 * Get source type icon color classes.
 */
export function getSourceColor(sourceType: string | undefined): string {
  switch (sourceType?.toLowerCase()) {
    case "social_post":
      return "bg-violet-100 text-violet-700";
    case "ad_copy":
      return "bg-orange-100 text-orange-700";
    case "social_dm":
      return "bg-cyan-100 text-cyan-700";
    default:
      return "bg-purple-100 text-purple-700";
  }
}
