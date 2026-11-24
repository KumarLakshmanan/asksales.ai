import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import {
  AnalyticsSkeleton,
  ContentCalendarSkeleton,
  DashboardPageSkeleton,
  FormSkeleton,
  LeadDetailSkeleton,
  SettingsSectionSkeleton,
} from "@/components/skeletons";

/** Layout archetypes used by the per-route loading.tsx files. */
export type RouteSkeletonVariant =
  | "table"
  | "cards"
  | "form"
  | "detail"
  | "analytics"
  | "chat"
  | "calendar"
  | "split"
  | "settings"
  | "auth"
  | "article";

/** Header line used by the archetypes that do not bring their own. */
function PageHeader() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Skeleton className="h-9 w-32" />
    </div>
  );
}

function CardsGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="space-y-3 pt-5">
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-lg shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-3 w-2/5" />
              </div>
            </div>
            <Skeleton className="h-24 w-full rounded-md" />
            <div className="flex justify-end gap-2">
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-8 w-20" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function CardsSkeleton() {
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <PageHeader />
      <CardsGrid />
    </div>
  );
}

function ChatSkeleton() {
  return (
    <div className="grid h-full min-h-[60vh] grid-cols-1 gap-4 p-4 md:grid-cols-[280px_1fr] sm:p-6">
      <div className="hidden space-y-2 md:block">
        <Skeleton className="mb-3 h-9 w-full" />
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="rounded-lg border p-3">
            <Skeleton className="mb-2 h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className={`flex gap-3 ${i % 2 ? "justify-end" : ""}`}>
            {i % 2 === 0 && <Skeleton className="h-8 w-8 rounded-full shrink-0" />}
            <Skeleton className={`h-16 ${i % 2 ? "w-2/5" : "w-3/5"} rounded-2xl`} />
          </div>
        ))}
        <Skeleton className="mt-auto h-12 w-full rounded-xl" />
      </div>
    </div>
  );
}

function SplitSkeleton() {
  return (
    <div className="grid min-h-[60vh] grid-cols-1 gap-4 p-4 lg:grid-cols-[360px_1fr] sm:p-6">
      <div className="space-y-2">
        <Skeleton className="mb-3 h-9 w-full" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg border p-3">
            <Skeleton className="h-9 w-9 rounded-full shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
      <Card>
        <CardContent className="space-y-4 pt-6">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="mt-6 h-40 w-full rounded-md" />
        </CardContent>
      </Card>
    </div>
  );
}

/** Centred sign-in / verification card: logo, title, fields and a button. */
function AuthSkeleton() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-5 pt-8">
          <div className="flex flex-col items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-xl" />
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full" />
          </div>
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="mx-auto h-3 w-40" />
        </CardContent>
      </Card>
    </div>
  );
}

/** Long-form text page: a title, an intro and several paragraphs. */
function ArticleSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
      <Skeleton className="h-9 w-2/3" />
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      ))}
    </div>
  );
}

/**
 * Renders the skeleton that matches a page's layout. Used by each
 * route's loading.tsx so the placeholder has the same shape as the page.
 */
export function RouteSkeleton({ variant, label = "Loading page…" }: { variant: RouteSkeletonVariant; label?: string }) {
  const body = (() => {
    switch (variant) {
      case "table": return <DashboardPageSkeleton />;
      case "cards": return <CardsSkeleton />;
      case "form": return <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6"><PageHeader /><FormSkeleton fields={6} /></div>;
      case "detail": return <LeadDetailSkeleton />;
      case "analytics": return <AnalyticsSkeleton />;
      case "chat": return <ChatSkeleton />;
      case "calendar": return <ContentCalendarSkeleton />;
      case "split": return <SplitSkeleton />;
      case "settings": return <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6"><PageHeader /><SettingsSectionSkeleton /></div>;
      case "auth": return <AuthSkeleton />;
      case "article": return <ArticleSkeleton />;
    }
  })();
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {body}
    </div>
  );
}
