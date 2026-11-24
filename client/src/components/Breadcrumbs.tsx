"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { aiVisibilityApi } from "@/lib/ai-visibility";
import { ChevronRight, Home } from "lucide-react";
import api from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { selectedBusinessProfileId } from "@/lib/business-profile";
import { integrationDefinitions } from "@/lib/integrations";

/** Route segments that are acronyms or brand names and should not be title-cased. */
const BREADCRUMB_ACRONYMS: Record<string, string> = {
  crm: "CRM",
  sms: "SMS",
  ai: "AI",
  seo: "SEO",
  aeo: "AEO",
  geo: "GEO",
  whatsapp: "WhatsApp",
};

export function Breadcrumbs() {
  const location = usePathname() || "/";
  const leadRoute = location.match(/^\/dashboard\/leads\/(view|edit)\/([^/]+)\/?$/);
  const assistantRoute = /^\/dashboard\/settings\/outreach\/assistants\/[0-9a-f-]{36}\/?$/i.test(location);
  
  const { user } = useAuth();
  const templateId = location.match(/^\/dashboard\/integrations\/whatsapp\/templates\/(\d+)(?:\/edit)?$/)?.[1];
  const template = useQuery({ queryKey: ['whatsapp-template-breadcrumb', user?.id, selectedBusinessProfileId(), templateId], queryFn: () => api.get<{template:{name:string}}>(`/api/whatsapp/templates/${templateId}`), enabled: Boolean(user?.id && templateId), staleTime: 30000, retry: false });
  const pathSegments = location.split("/").filter(Boolean);
  
  const visibilityProjectId = Number(location.match(/^\/dashboard\/ai-visibility\/websites\/(\d+)/)?.[1]);
  const visibilityProject = useQuery({ queryKey: ["ai-visibility-project", visibilityProjectId], queryFn: () => aiVisibilityApi.getProject(visibilityProjectId), enabled: Boolean(visibilityProjectId) });

  // Generate breadcrumb items
  const defaultBreadcrumbs = pathSegments.map((segment, index) => {
    const path = "/" + pathSegments.slice(0, index + 1).join("/");
    let label = segment
      .split("-")
      .map(word => BREADCRUMB_ACRONYMS[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    // Support workspaces use nested numeric identifiers. Raw IDs and the
    // non-existent `/members` collection route are implementation details,
    // not useful wayfinding for an operator.
    const isSupportRoute = pathSegments[0] === "dashboard" && pathSegments[1] === "support";
    const previous = pathSegments[index - 1];
    if (isSupportRoute && /^\d+$/.test(segment)) {
      label = previous === "teams" ? "Team settings" : previous === "members" ? "Member tickets" : "Ticket workspace";
    }
    
    if (templateId && segment === templateId) label = template.data?.template.name || 'Template details';
    if (path === "/dashboard/settings/team") label = "Staff";
    if (path === "/dashboard/settings/outreach") label = "Assistants";
    if (path === "/dashboard/settings/outreach/new") label = "New assistant";
    if (previous === "knowledge-base" && /^\d+$/.test(segment)) label = "Edit entry";
    const isVisibility = pathSegments[1] === "ai-visibility";
    if (pathSegments[1] === "integrations") {
      if (segment === "integrations") label = "All Integrations";
      if (index === 2) label = integrationDefinitions.find(item => item.id === segment)?.name || label;
    }
    if (isVisibility && segment === "ai-visibility") label = "AI Visibility";
    if (isVisibility && ["seo", "aeo", "geo"].includes(segment)) label = segment.toUpperCase();
    if (isVisibility && previous === "audits" && /^\d+$/.test(segment)) label = `Analysis #${segment}`;
    if (isVisibility && previous === "websites" && /^\d+$/.test(segment)) label = visibilityProject.data?.project.name || "Website";
    return { path, label, hidden: (isSupportRoute && segment === "members") || (isVisibility && ["websites", "audits"].includes(segment)) };
  }).filter((crumb) => !crumb.hidden);

  // `view` and `edit` are route structure, not standalone lead pages.
  // Follow the same explicit trail convention as Paid Ads below.
  const breadcrumbs = assistantRoute ? [
    { path: '/dashboard/settings', label: 'Settings' },
    { path: '/dashboard/settings/outreach', label: 'Assistants' },
    { path: location, label: 'Assistant settings' },
  ] : leadRoute ? [
    { path: "/dashboard/leads", label: "Leads" },
    { path: location, label: `${leadRoute[1] === "edit" ? "Edit lead" : "Lead"} #${leadRoute[2]}` },
  ] : pathSegments[1] === "ads" ? [
    { path: "/dashboard/ads", label: "Paid Ads" },
    ...(pathSegments[2] === "campaigns" ? [
      { path: "/dashboard/ads?tab=campaigns", label: "Campaigns" },
      { path: location, label: "Campaign details" },
    ] : pathSegments[2] === "create" ? [{ path: location, label: "Create campaign" }] : []),
  ] : defaultBreadcrumbs;

  // Don't show breadcrumbs on home or root
  if (location === "/" || location === "/dashboard" || location === "/dashboard/home") {
    return null;
  }

  return (
    <nav
      aria-label="Breadcrumb"
      className="mx-4 mt-4 flex w-fit max-w-[calc(100%-2rem)] items-center gap-1 overflow-x-auto whitespace-nowrap rounded-lg border bg-card px-2 py-1 text-sm text-muted-foreground sm:mx-5 sm:mt-5"
    >
      <Link
        href="/dashboard/home"
        className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
        title="Home dashboard"
        aria-label="Home dashboard"
      >
        <Home className="h-3.5 w-3.5" />
      </Link>
      
      {breadcrumbs.map((crumb, index) => {
        const isLast = index === breadcrumbs.length - 1;
        const isDashboard = crumb.label.toLowerCase() === "dashboard";
        
        // Skip rendering "Dashboard" segment if it's the first one and followed by others
        if (isDashboard && index === 0 && breadcrumbs.length > 1) return null;
        
        const crumbPath = isDashboard ? "/dashboard/home" : crumb.path;
        
        return (
          <div key={crumb.path} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" aria-hidden="true" />
            
            {isLast ? (
              <span aria-current="page" className="rounded-md bg-muted px-2 py-1 font-medium text-foreground">
                  {crumb.label}
              </span>
            ) : (
              <Link 
                href={crumbPath} 
                className="rounded-md px-2 py-1 hover:bg-muted hover:text-foreground"
              >
                {crumb.label}
              </Link>
            )}
          </div>
        );
      })}
    </nav>
  );
}
