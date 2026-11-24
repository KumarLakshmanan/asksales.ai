"use client";
/**
 * Saved Templates - Category Navigation Page
 * Shows cards for each content type that navigate to dedicated sub-pages
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useContentCounts } from "@/hooks/use-content-counts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sparkles,
  Mail,
  MessageSquare,
  MessageCircle,
  Share2,
  Megaphone,
  Image,
  Video,
  FileText,
  ArrowRight,
  Plus,
} from "lucide-react";
import api from "@/lib/api";
import { PageHeader } from "@/components/ui/page-header";

interface CategoryCard {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  route: string;
  generateRoute: string;
  availabilityNote?: string;
  /** Where the user configures the provider that the availability note refers to. */
  providerSettingsRoute?: string;
  countLabel?: string;
}

const categories: CategoryCard[] = [
  {
    id: "image",
    label: "Images",
    description: "AI-generated images and photos",
    icon: <Image className="w-8 h-8" />,
    route: "/dashboard/saved-templates/image",
    generateRoute: "/dashboard/saved-templates/image/generate",
    availabilityNote: "Generation requires a configured image provider",
    providerSettingsRoute: "/dashboard/integrations",
  },
  {
    id: "video",
    label: "Videos",
    description: "AI-generated video content",
    icon: <Video className="w-8 h-8" />,
    route: "/dashboard/saved-templates/video",
    generateRoute: "/dashboard/saved-templates/video/generate",
    availabilityNote: "Generation requires a configured video provider",
    providerSettingsRoute: "/dashboard/integrations",
  },
  {
    id: "email",
    label: "Email templates",
    description: "Professional email templates for outreach",
    icon: <Mail className="w-8 h-8" />,
    route: "/dashboard/saved-templates/email",
    generateRoute: "/dashboard/saved-templates/email/generate",
  },
  {
    id: "sms",
    label: "SMS templates",
    description: "Short message templates for SMS campaigns",
    icon: <MessageSquare className="w-8 h-8" />,
    route: "/dashboard/saved-templates/sms",
    generateRoute: "/dashboard/saved-templates/sms/generate",
  },
  {
    id: "whatsapp",
    label: "WhatsApp templates",
    description: "Saved WhatsApp templates and their approval status",
    icon: <MessageCircle className="w-8 h-8" />,
    route: "/dashboard/integrations/whatsapp/templates",
    generateRoute: "/dashboard/integrations/whatsapp/templates/create",
    countLabel: "Managed in WhatsApp",
    availabilityNote: "WhatsApp approval is required before using a template for new outreach",
  },
  {
    id: "social",
    label: "Social media posts",
    description: "Create social captions and publish to Instagram, Facebook, or YouTube",
    icon: <Share2 className="w-8 h-8" />,
    route: "/dashboard/saved-templates/social",
    generateRoute: "/dashboard/saved-templates/social/generate",
    availabilityNote: "LinkedIn and X templates are copy-only in this library",
  },
  {
    id: "social_message",
    label: "Social DM templates",
    description: "Direct message templates for outreach on social platforms",
    icon: <MessageSquare className="w-8 h-8" />,
    route: "/dashboard/saved-templates/dm",
    generateRoute: "/dashboard/saved-templates/dm/generate",
  },
  {
    id: "ad_copy",
    label: "Ad creative drafts",
    description: "Draft ad copy and creative for Meta, Google, and other platforms",
    icon: <Megaphone className="w-8 h-8" />,
    route: "/dashboard/saved-templates/ads",
    generateRoute: "/dashboard/saved-templates/ads/generate",
    availabilityNote: "Creates draft creative; publishing requires a connected ad account",
  },
  {
    id: "blog",
    label: "Blog posts",
    description: "Long-form content for your blog",
    icon: <FileText className="w-8 h-8" />,
    route: "/dashboard/saved-templates/blog",
    generateRoute: "/dashboard/saved-templates/blog/generate",
  },
];

export default function SavedTemplatesPage() {
  const router = useRouter();
  const assets = useContentCounts();
  const templates = useQuery({ queryKey: ['content-template-counts'], queryFn: () => api.get<Record<string, number>>('/api/content/templates/counts'), staleTime: 30_000 });
  const contentCounts = assets.data || {};
  const templateCounts = templates.data || {};
  const loading = assets.isLoading || templates.isLoading;
  const countsError = assets.isError || templates.isError;

  const handleCardClick = (route: string) => {
    router.push(route);
  };

  const getCount = (id: string): number => {
    if (id === "all") {
      return Object.values(contentCounts).reduce((sum, count) => sum + count, 0);
    }
    // Map category id to API type
    const typeMap: Record<string, string> = {
      image: "image",
      video: "video",
      email: "email_template",
      sms: "sms_template",
      social: "social_post",
      social_message: "social_dm",
      ad_copy: "ad_copy",
      blog: "blog_post",
    };
    const apiType = typeMap[id];
    return (contentCounts[apiType] || 0) + (templateCounts[id] || 0);
  };

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-5 sm:px-6 lg:px-8">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <PageHeader icon={Sparkles} title="Content library" subtitle="Create, organize, and reuse content by format" />
        {countsError && <p className="text-xs text-warning">Saved-item counts are temporarily unavailable.</p>}
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="grid border-border md:grid-cols-2 xl:grid-cols-4">
          {categories.map((category) => (
            <article
              key={category.id}
              className="group flex min-h-[17rem] flex-col border-b border-border p-5 transition-colors hover:bg-muted/35 md:border-r xl:[&:nth-child(4n)]:border-r-0 xl:[&:nth-last-child(-n+4)]:border-b-0"
            >
              <div className="flex items-start justify-between gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background text-foreground [&>svg]:h-5 [&>svg]:w-5">
                    {category.icon}
                  </div>
                  {loading && !category.countLabel ? (
                    <Skeleton className="h-6 w-12 rounded-full" />
                  ) : (
                    <span className="text-sm text-muted-foreground">{category.countLabel || (getCount(category.id) > 0 ? `${getCount(category.id)} saved` : "None saved")}</span>
                  )}
              </div>
              <div className="mt-5 flex-1">
                <h2 className="flex items-center justify-between text-base font-semibold tracking-tight">
                  {category.label}
                  <ArrowRight aria-hidden="true" className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </h2>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  {category.description}
                </p>
                {!loading && !category.countLabel && getCount(category.id) === 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Nothing saved yet. Create your first {category.label.toLowerCase()} to reuse it here.
                  </p>
                )}
                {category.availabilityNote && (
                  <p className="mt-4 border-l-2 border-primary/50 pl-3 text-xs leading-5 text-muted-foreground">
                    {category.availabilityNote}
                    {category.providerSettingsRoute && (
                      <>
                        {" "}
                        <Link
                          href={category.providerSettingsRoute}
                          className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Configure {category.label.toLowerCase()} provider
                        </Link>
                      </>
                    )}
                  </p>
                )}
              </div>
                <div className="mt-5 flex gap-2 border-t border-border pt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    aria-label={`Open library: ${category.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCardClick(category.route);
                    }}
                  >
                    Open library
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1"
                    aria-label={`Create: ${category.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCardClick(category.generateRoute);
                    }}
                  >
                    <Plus aria-hidden="true" className="w-4 h-4 mr-1" />
                    Create
                  </Button>
                </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
