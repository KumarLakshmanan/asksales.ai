import { useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Plus, BarChart3, Users, MessageSquare, TrendingUp, IndianRupee,
  Search as SearchIcon, Sparkles, Zap, FileText,
  Image, Mail, Share2, Megaphone, MessageCircle, Newspaper,
  LayoutDashboard, ChevronDown, ChevronUp, Video, Headphones, Handshake, ClipboardList
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getTabLabel } from "@/lib/tabConfig";

interface SearchTabProps {
  onAddTab?: (tabType: string) => void;
}

const availableTabs = [
  { id: "icp", name: getTabLabel("icp"), description: "View your Ideal Customer Profile", icon: Users, color: "bg-blue-500" },
  { id: "agentchoose", name: getTabLabel("agentchoose"), description: "Choose and hire specialist agents", icon: Zap, color: "bg-purple-500" },
  { id: "lead-inputs", name: getTabLabel("lead-inputs"), description: "Review and change the lead search settings", icon: FileText, color: "bg-cyan-500" },
  { id: "leads", name: "Leads", description: "Manage and track your leads", icon: Users, color: "bg-emerald-500" },
  { id: "outreach", name: "Outreach", description: "Outreach campaigns and engagement", icon: MessageSquare, color: "bg-orange-500" },
  { id: "performancemarketing", name: getTabLabel("performancemarketing"), description: "Budget plans, paid campaigns and results", icon: BarChart3, color: "bg-indigo-500" },
  { id: "campaigns", name: "Campaigns", description: "Marketing campaign management", icon: TrendingUp, color: "bg-violet-500" },
  { id: "ads", name: getTabLabel("ads"), description: "Write ad copy for paid campaigns", icon: IndianRupee, color: "bg-yellow-500" },
  { id: "content-studio", name: "Content Studio", description: "Create and manage all content types", icon: Sparkles, color: "bg-fuchsia-500" },
  { id: "crm", name: "CRM", description: "Manage customer relationships and pipeline activity", icon: Handshake, color: "bg-sky-500" },
  { id: "support", name: "Support", description: "Review and manage customer support conversations", icon: Headphones, color: "bg-rose-500" },
  { id: "proposals", name: "Proposals", description: "Create and manage sales proposals", icon: ClipboardList, color: "bg-lime-600" },
];

const contentStudioTabs = [
  { id: "content-studio-image", name: "Image Gallery", description: "Browse and manage AI-generated images", icon: Image, color: "bg-blue-500" },
  { id: "content-studio-video", name: "Video Gallery", description: "Browse and manage AI-generated videos", icon: Video, color: "bg-purple-500" },
  { id: "content-studio-email", name: "Email Templates", description: "Craft professional email templates", icon: Mail, color: "bg-emerald-500" },
  { id: "content-studio-sms", name: "SMS Templates", description: "Write concise SMS messages", icon: MessageSquare, color: "bg-amber-500" },
  { id: "content-studio-social", name: "Social Posts", description: "Create engaging social media posts", icon: Share2, color: "bg-violet-500" },
  { id: "content-studio-social-message", name: "Social Messages", description: "DM templates for Facebook, Twitter, LinkedIn and Instagram", icon: MessageCircle, color: "bg-indigo-500" },
  { id: "content-studio-adcopy", name: "Ad Copy", description: "Generate compelling ad copy", icon: Megaphone, color: "bg-orange-500" },
  { id: "content-studio-blog", name: "Blog Posts", description: "Write SEO-optimized blog articles", icon: Newspaper, color: "bg-teal-500" },
];

export default function SearchTab({ onAddTab }: SearchTabProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [showContentStudio, setShowContentStudio] = useState(false);

  const allTabs = [...availableTabs, ...contentStudioTabs];
  const filteredTabs = allTabs.filter(
    (tab) =>
      tab.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tab.description.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const mainTabs = filteredTabs.filter((t) => !t.id.startsWith("content-studio-") && t.id !== "content-studio");
  const contentTabs = filteredTabs.filter((t) => t.id.startsWith("content-studio-"));
  const contentStudioExpanded = showContentStudio || searchQuery.trim().length > 0;

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b bg-card flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <LayoutDashboard className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">Explore Tabs</p>
            <p className="text-xs text-muted-foreground">Open a workspace view</p>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2.5 border-b shrink-0">
        <div className="relative">
          <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search tabs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-8 text-xs rounded-lg border-border/60"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-3 space-y-2">
        {/* Main Tabs */}
        {mainTabs.length > 0 && (
          <div className="space-y-1.5">
            {mainTabs.map((tab) => {
              const Icon = tab.icon;
              const iconColor = tab.color.replace("bg-", "text-");
              const iconBg = tab.color.replace("-500", "-500/10");
              return (
                <button
                  key={tab.id}
                  onClick={() => onAddTab?.(tab.id)}
                  className="w-full flex items-center gap-3 p-3 rounded-xl border border-border/40 bg-card hover:bg-muted/30 hover:border-border hover:shadow-sm transition-all text-left group shadow-sm"
                >
                  <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0", iconBg)}>
                    <Icon className={cn("w-4 h-4", iconColor)} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{tab.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{tab.description}</p>
                  </div>
                  <Plus className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0 group-hover:text-primary transition-colors" />
                </button>
              );
            })}
          </div>
        )}

        {/* Content Studio Section */}
        {(contentTabs.length > 0 || searchQuery === "") && (
          <div className="overflow-hidden rounded-xl border border-border/40 bg-card shadow-sm">
            <div className="flex items-center hover:bg-muted/30">
              <button
                type="button"
                onClick={() => setShowContentStudio(!showContentStudio)}
                aria-expanded={contentStudioExpanded}
                aria-controls="content-studio-tab-options"
                className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
              >
                <div className="w-8 h-8 rounded-lg bg-fuchsia-500/10 flex items-center justify-center shrink-0">
                  <Sparkles className="w-4 h-4 text-fuchsia-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Content Studio</p>
                  <p className="truncate text-xs text-muted-foreground">All content creation tools</p>
                </div>
                {contentStudioExpanded
                  ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              </button>
              <button
                type="button"
                onClick={() => onAddTab?.("content-studio")}
                className="mr-3 h-7 shrink-0 rounded-md border border-border/40 px-2 text-[10px] text-muted-foreground transition-colors hover:border-primary hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                title="Open Content Studio"
                aria-label="Open Content Studio"
              >
                Open
              </button>
            </div>
            {contentStudioExpanded && (
              <div id="content-studio-tab-options" className="divide-y divide-border/30 border-t border-border/40">
                {(searchQuery ? contentTabs : contentStudioTabs).map((tab) => {
                  const Icon = tab.icon;
                  const iconColor = tab.color.replace("bg-", "text-");
                  const iconBg = tab.color.replace("-500", "-500/10");
                  return (
                    <button
                      key={tab.id}
                      onClick={() => onAddTab?.(tab.id)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors text-left group"
                    >
                      <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0", iconBg)}>
                        <Icon className={cn("w-3.5 h-3.5", iconColor)} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium">{tab.name}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{tab.description}</p>
                      </div>
                      <Plus className="h-3 w-3 text-muted-foreground/40 shrink-0 group-hover:text-primary transition-colors" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {filteredTabs.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <p className="text-sm font-medium">No tabs found</p>
            <p className="text-xs text-muted-foreground mt-1">Try a different search term</p>
          </div>
        )}
      </div>
    </div>
  );
}
