import { DashboardPageSkeleton } from "@/components/skeletons";

/** Shown while any dashboard page loads. Covers every route in the (main) group. */
export default function DashboardMainLoading() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading page…</span>
      <DashboardPageSkeleton />
    </div>
  );
}
