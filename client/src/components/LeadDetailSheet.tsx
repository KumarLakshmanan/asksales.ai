/**
 * Lead Detail Sheet Component
 * Displays comprehensive lead information with all 100+ fields organized in sections
 */

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { type Lead } from "@/models/lead";
import { socialProfileLink } from '@/lib/social-profile-link';
import { formatLeadStatus, getLeadStatus } from '../../../shared/leadStatus';
import { formatLeadLocation } from '../../../shared/leadDisplayValues';
import { 
  Sheet, 
  SheetContent, 
  SheetHeader, 
  SheetTitle, 
  SheetDescription,
  SheetFooter 
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  User, 
  Building2, 
  Mail, 
  Globe, 
  MapPin,
  Briefcase,
  IndianRupee,
  TrendingUp,
  Target,
  CheckCircle,
  Activity,
  Zap,
  ExternalLink,
  Edit,
  Trash2,
  Instagram,
  Phone,
  Send,
  Sparkles,
  Brain,
  Linkedin,
  Twitter,
  Facebook,
  Youtube,
  Github,
  MessageSquare,
  Pin,
  Music,
  Users,
  DollarSign,
  Calendar,
  Code,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";

interface LeadDetailSheetProps {
  lead: Lead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit?: (lead: Lead) => void;
  onDelete?: (lead: Lead) => void;
  threadId?: number;
  outreachLocked?: boolean;
}

// Helper to determine best outreach channel based on available data
function getAvailableOutreachChannels(lead: Lead): Array<{
  type: 'instagram' | 'email' | 'whatsapp';
  available: boolean;
  value: string | null;
  label: string;
  icon: typeof Instagram;
  path: string;
}> {
  return [
    {
      type: 'instagram',
      available: !!(lead.instagramHandle || lead.instagramUrl || lead.instagram),
      value: lead.instagramHandle || lead.instagramUrl || lead.instagram || null,
      label: 'Instagram DM',
      icon: Instagram,
      path: `/dashboard/outreach/instagram?leadId=${lead.id}`,
    },
    {
      type: 'email',
      available: !!(lead.email && !lead.email.includes('@placeholder.lead')),
      value: lead.email || null,
      label: 'Email',
      icon: Mail,
      path: `/dashboard/outreach/create?channel=email&leadId=${lead.id}`,
    },
    {
      type: 'whatsapp',
      available: !!(lead.whatsapp || lead.phone),
      value: lead.whatsapp || lead.phone || null,
      label: 'WhatsApp',
      icon: Phone,
      path: `/dashboard/outreach/whatsapp?leadId=${lead.id}`,
    },
  ];
}

export function LeadDetailSheet({ 
  lead, 
  open, 
  onOpenChange,
  onEdit,
  onDelete,
  threadId,
  outreachLocked = false,
}: LeadDetailSheetProps) {
  const { toast } = useToast();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("overview");
  const [isGeneratingTemplate, setIsGeneratingTemplate] = useState(false);
  const [isDeepEnriching, setIsDeepEnriching] = useState(false);

  useEffect(() => {
    if (lead) {
      setActiveTab(lead.leadType === 'company' ? 'company' : 'overview');
    }
  }, [lead]);

  if (!lead) return null;

  const availableChannels = getAvailableOutreachChannels(lead);
  const bestChannel = availableChannels.find(c => c.available);

  const handleStartOutreach = async (channel: typeof availableChannels[0]) => {
    if (outreachLocked) {
      toast({
        title: 'Review approval required',
        description: 'Approve the reviewed lead set before starting outreach.',
        variant: 'destructive',
      });
      return;
    }
    // Store the lead data in sessionStorage for the outreach page to access
    sessionStorage.setItem('outreach_selected_leads', JSON.stringify([lead]));
    
    // Store thread ID if available for the outreach page
    if (threadId) {
      sessionStorage.setItem('outreach_thread_id', threadId.toString());
    } else {
      sessionStorage.removeItem('outreach_thread_id');
    }
    
    // Determine template type based on channel
    const templateType = channel.type === 'email' ? 'email_template' : channel.type === 'instagram' ? 'social_dm' : null;
    
    if (templateType) {
      try {
        setIsGeneratingTemplate(true);
        
        // Check if templates exist for this type
        const apiUrl = templateType === 'email_template' 
          ? '/api/content/assets?type=email_template'
          : '/api/content/assets?type=social_dm&channel=instagram';
        
        const existingData = await api.get<Array<Record<string, unknown>>>(apiUrl);
        const existingArr = Array.isArray(existingData) ? existingData : [];
        
        // If no templates exist, generate one
        if (existingArr.length === 0) {
          toast({
            title: "Generating template...",
            description: `Creating ${channel.type === 'email' ? 'email' : 'Instagram DM'} template for your outreach`,
          });
          
          // Generate a template using the content studio API
          const generateUrl = channel.type === 'email'
            ? '/api/content/studio/email'
            : '/api/content/studio/social-message';
          
          const generatePayload = channel.type === 'email'
            ? {
                prompt: `Create a concise initial outreach email for ${lead.fullName || lead.name || 'a potential lead'}${lead.company ? ` at ${lead.company}` : ''}.`,
                tone: 'professional',
              }
            : {
                prompt: `Create a friendly Instagram direct message that starts a conversation with ${lead.fullName || lead.name || 'a potential lead'}${lead.company ? ` at ${lead.company}` : ''}.`,
                platform: 'instagram',
              };
          
          const generatedData = await api.post<{ assetId?: number }>(generateUrl, generatePayload);
          if (generatedData.assetId) {
            sessionStorage.setItem('outreach_generated_template_id', generatedData.assetId.toString());
            sessionStorage.setItem('outreach_template_type', templateType);
            toast({
              title: "Template created",
              description: "A new template has been generated for your outreach",
            });
          }
        }
      } catch (error) {
        console.error('Error checking/generating template:', error);
        // Continue to navigation even if template check fails
      } finally {
        setIsGeneratingTemplate(false);
      }
    }
    
    // Navigate to outreach page with threadId as URL parameter for filtering leads
    let targetPath = channel.path;
    if (threadId) {
      targetPath += targetPath.includes('?') ? `&threadId=${threadId}` : `?threadId=${threadId}`;
    }
    router.push(targetPath);
    onOpenChange(false);
  };


  const getDisplayName = () => {
    return lead.fullName || lead.name || `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || lead.email || 'Potential Lead';
  };

  const getInitials = () => {
    const name = getDisplayName();
    if (!name) return 'PL';
    return name.split(' ').filter(Boolean).map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'PL';
  };


  const formatDate = (date: string | null | undefined) => {
    if (!date) return '-';
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const FieldRow = ({ label, value, copyable = false }: { label: string; value: string | number | null | undefined; copyable?: boolean }) => {
    if (value === null || value === undefined || value === '') return null;
    return (
      <div className="flex items-center justify-between border-b border-border py-1.5 last:border-0">
        <span className="text-sm text-muted-foreground">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-right max-w-[200px] truncate">{String(value)}</span>
          {copyable && (
            <CopyButton
              value={String(value)}
              label={`Copy ${label}`}
              iconOnly
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
            />
          )}
        </div>
      </div>
    );
  };

  const SocialLink = ({ platform, url, handle }: { platform: string; url: string | null | undefined; handle: string | null | undefined }) => {
    const displayUrl = socialProfileLink(platform, url, handle);
    if (!displayUrl) return null;
    return (
      <a 
        href={displayUrl} 
        target="_blank" 
        rel="noopener noreferrer"
        className="flex items-center gap-2 text-sm text-blue-600 hover:underline py-1"
      >
        <ExternalLink className="h-3 w-3" />
        {platform}
        {handle && <span className="text-muted-foreground">@{handle}</span>}
      </a>
    );
  };

  const TagList = ({ tags, variant = "default" }: { tags: string[] | null | undefined; variant?: "default" | "secondary" | "outline" }) => {
    if (!tags || tags.length === 0) return <span className="text-sm text-muted-foreground">-</span>;
    return (
      <div className="flex flex-wrap gap-1">
        {tags.map((tag, i) => (
          <Badge key={i} variant={variant} className="text-xs">{tag}</Badge>
        ))}
      </div>
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl p-0 flex flex-col">
        {/* Header */}
        <SheetHeader className="px-8 py-8 border-b border-border/50 bg-primary/5 min-h-[160px] relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full -mr-32 -mt-32 blur-3xl opacity-50" />
          
          <div className="flex items-start gap-6 relative z-10">
            <div className="shrink-0 relative">
              <Avatar className="h-24 w-24 border-4 border-background shadow-2xl rounded-3xl overflow-hidden">
                <AvatarImage src={lead.profilePicture || lead.photo || undefined} className="object-cover" />
                <AvatarFallback className="text-2xl font-bold bg-gradient-primary text-white">
                  {lead.leadType === 'company' ? <Building2 className="h-8 w-8 text-white" /> : getInitials()}
                </AvatarFallback>
              </Avatar>
              <div className="absolute -bottom-2 -right-2 w-8 h-8 rounded-xl bg-background shadow-lg flex items-center justify-center">
                <div className="w-6 h-6 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Activity className="w-3.5 h-3.5 text-primary" />
                </div>
              </div>
            </div>
            
            <div className="flex-1 min-w-0 pt-2">
              <SheetTitle className="text-xl font-heading font-bold text-foreground tracking-tight leading-none mb-2">
                {getDisplayName()}
              </SheetTitle>
              <SheetDescription className="text-base text-muted-foreground/80 font-medium leading-relaxed max-w-md">
                {lead.leadType === 'company' ? (
                  <span className="text-foreground font-bold capitalize">
                    {lead.industry || 'Company Profile'}{lead.companySize ? ` · ${lead.companySize} employees` : ''}
                  </span>
                ) : (
                  <>
                    {lead.role && <span className="text-foreground font-bold">{lead.role}</span>}
                    {lead.role && (lead.company || lead.companyName) && <span className="mx-2 opacity-50">at</span>}
                    {(lead.company || lead.companyName) && <span className="text-primary font-bold">{lead.company || lead.companyName}</span>}
                  </>
                )}
              </SheetDescription>
              
              <div className="flex flex-wrap items-center gap-2 mt-4">
                <StatusBadge
                  status={getLeadStatus(lead)}
                  label={formatLeadStatus(getLeadStatus(lead))}
                  toneOverrides={{ contacted: 'warning', engaged: 'progress', converted: 'success' }}
                />
                {lead.priority && (
                  <StatusBadge
                    status={lead.priority}
                    label={`${lead.priority} priority`}
                    toneOverrides={{ high: 'danger', medium: 'warning', low: 'success' }}
                  />
                )}
                {lead.verified && (
                  <Badge className="rounded-xl px-3 py-1 text-[10px] font-bold uppercase tracking-widest bg-blue-500/10 text-blue-500 border-none shadow-sm">
                    <CheckCircle className="h-3 w-3 mr-1.5" />
                    Verified Profile
                  </Badge>
                )}
                {lead.tier && (
                  <Badge variant="outline" className="rounded-xl px-3 py-1 text-[10px] font-bold uppercase tracking-widest bg-secondary gap-1.5 border-border/50">
                    <TrendingUp className="w-3 h-3 text-primary/60" />
                    Tier {lead.tier}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </SheetHeader>

        {/* Tabs Navigation */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
          <div className="px-8 pt-6 border-b border-border/50 bg-secondary/20">
            <TabsList className="w-full h-12 glass p-1 gap-1 rounded-2xl border-border/30">
              <TabsTrigger value="overview" className="flex-1 rounded-xl data-[state=active]:bg-background data-[state=active]:text-primary data-[state=active]:shadow-lg font-bold text-xs uppercase tracking-widest transition-all">Overview</TabsTrigger>
              <TabsTrigger value="company" className="flex-1 rounded-xl data-[state=active]:bg-background data-[state=active]:text-primary data-[state=active]:shadow-lg font-bold text-xs uppercase tracking-widest transition-all">Company</TabsTrigger>
              <TabsTrigger value="engagement" className="flex-1 rounded-xl data-[state=active]:bg-background data-[state=active]:text-primary data-[state=active]:shadow-lg font-bold text-xs uppercase tracking-widest transition-all">Engagement</TabsTrigger>
              <TabsTrigger value="enrichment" className="flex-1 rounded-xl data-[state=active]:bg-background data-[state=active]:text-primary data-[state=active]:shadow-lg font-bold text-xs uppercase tracking-widest transition-all">Enrichment</TabsTrigger>
              <TabsTrigger value="scoring" className="flex-1 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">Profile Insights</TabsTrigger>
              <TabsTrigger value="system" className="flex-1 rounded-xl data-[state=active]:bg-background data-[state=active]:bg-background data-[state=active]:text-primary data-[state=active]:shadow-lg font-bold text-xs uppercase tracking-widest transition-all">System</TabsTrigger>
            </TabsList>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-6 space-y-6">
              {/* Overview Tab */}
              <TabsContent value="overview" className="mt-0 space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                {/* Contact Information */}
                <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                   <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <Mail className="h-4 w-4" />
                    </div>
                    <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Contact Information</h4>
                  </div>
                  <div className="divide-y divide-border/30">
                    <FieldRow label="Email" value={lead.email} copyable />
                    <FieldRow label="Email Status" value={lead.emailStatus} />
                    <FieldRow label="Phone" value={lead.phone} copyable />
                    <FieldRow label="Secondary Phone" value={lead.secondaryPhone} />
                    <FieldRow label="WhatsApp" value={lead.whatsapp} copyable />
                    <FieldRow label="Telegram" value={lead.telegram} />
                    <FieldRow label="Skype" value={lead.skype} />
                    <FieldRow label="Discord" value={lead.discord} />
                    <FieldRow label="Website" value={lead.website} />
                    <FieldRow label="Calendar Link" value={lead.calendarLink} />
                  </div>
                </div>

                {/* Personal Information */}
                <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                   <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <User className="h-4 w-4" />
                    </div>
                    <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Personal Information</h4>
                  </div>
                  <div className="divide-y divide-border/30">
                    <FieldRow label="Full Name" value={lead.fullName || `${lead.firstName || ''} ${lead.lastName || ''}`.trim()} />
                    <FieldRow label="Headline" value={lead.headline} />
                    <FieldRow label="Bio" value={lead.bio} />
                    <FieldRow label="Gender" value={lead.gender} />
                    <FieldRow label="Age Group" value={lead.ageGroup} />
                    <FieldRow label="Language" value={lead.language} />
                    <FieldRow label="Timezone" value={lead.timezone} />
                    {lead.location && (
                    <div className="flex justify-between items-center py-3 border-b border-border/30 last:border-0">
                      <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground/60">Location</span>
                      <div className="text-sm font-bold text-foreground flex items-center gap-2">
                        <MapPin className="w-3.5 h-3.5 text-primary/60" />
                        {formatLeadLocation(lead.location) || '—'}
                      </div>
                    </div>
                    )}
                  </div>
                </div>

                {/* Social Profiles */}
                <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                   <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <Globe className="h-4 w-4" />
                    </div>
                    <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Social Profiles</h4>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <SocialLink platform="LinkedIn" url={lead.linkedinUrl || lead.linkedin} handle={lead.linkedinUsername} />
                      <SocialLink platform="Twitter" url={lead.twitterUrl || lead.twitter} handle={typeof lead.rawData?.twitterHandle === 'string' ? lead.rawData.twitterHandle : /^(twitter|x)(_|$)/i.test(String(lead.platformType || lead.source || '')) ? lead.twitterHandle || lead.twitterUsername : undefined} />
                      <SocialLink platform="Instagram" url={lead.instagramUrl || lead.instagram} handle={typeof lead.rawData?.instagramHandle === 'string' ? lead.rawData.instagramHandle : /^instagram(_|$)/i.test(String(lead.platformType || lead.source || '')) ? lead.instagramHandle : undefined} />
                      <SocialLink platform="Facebook" url={lead.facebookUrl || lead.facebook} handle={null} />
                    </div>
                    <div className="space-y-2 text-right">
                      <p className="text-[10px] find-bold uppercase tracking-widest text-muted-foreground/60">Social Stats</p>
                      <div className="space-y-1">
                        {lead.followersCount && <p className="text-sm font-bold text-foreground"><span className="text-primary">{lead.followersCount?.toLocaleString()}</span> Followers</p>}
                        {lead.connectionsCount && <p className="text-sm font-bold text-foreground"><span className="text-primary">{lead.connectionsCount?.toLocaleString()}</span> Connections</p>}
                        {lead.engagementRate && <p className="text-sm font-bold text-foreground"><span className="text-primary">{lead.engagementRate}%</span> Engagement</p>}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Professional Information */}
                <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                   <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <Briefcase className="h-4 w-4" />
                    </div>
                    <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Professional Information</h4>
                  </div>
                  <div className="divide-y divide-border/30">
                    <FieldRow label="Role/Title" value={lead.role} />
                    <FieldRow label="Seniority" value={lead.seniority} />
                    <FieldRow label="Department" value={lead.department} />
                    <FieldRow label="Years of Experience" value={lead.yearsOfExperience} />
                    <FieldRow label="Current Job Since" value={formatDate(lead.currentJobStartedAt)} />
                    <div className="py-4 last:border-0 border-b border-border/30">
                      <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground/60 block mb-3">Skills</span>
                      <div className="mt-1">
                        <TagList tags={lead.skills} variant="secondary" />
                      </div>
                    </div>
                  </div>
                </div>
              </TabsContent>

              {/* Company Tab */}
              <TabsContent value="company" className="mt-0 space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                   <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <Building2 className="h-4 w-4" />
                    </div>
                    <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Company Information</h4>
                  </div>
                  <div className="divide-y divide-border/30">
                    <FieldRow label="Company Name" value={lead.companyName || lead.company} />
                    <FieldRow label="Domain" value={lead.companyDomain} copyable />
                    <FieldRow label="Industry" value={lead.industry} />
                    <FieldRow label="Company Size" value={lead.companySize} />
                    <FieldRow label="Revenue" value={lead.companyRevenue} />
                    <FieldRow label="Founded" value={lead.companyFoundedYear} />
                    <div className="py-4">
                      <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground/60 block mb-3">Market Position</span>
                      <p className="text-sm font-medium text-muted-foreground leading-relaxed">{lead.companyDescription || 'No description available in market records.'}</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                   <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <Zap className="h-4 w-4" />
                    </div>
                    <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Tech Stack</h4>
                  </div>
                  <TagList tags={lead.companyTechStack} variant="outline" />
                </div>

                <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                   <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <IndianRupee className="h-4 w-4" />
                    </div>
                    <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Financial Information</h4>
                  </div>
                  <div className="divide-y divide-border/30">
                    <FieldRow label="Funding Stage" value={lead.fundingStage} />
                    <FieldRow label="Total Funding" value={lead.totalFunding} />
                    <FieldRow label="Last Funding" value={formatDate(lead.lastFundingDate)} />
                  </div>
                </div>
              </TabsContent>

              {/* Engagement Tab */}
              <TabsContent value="engagement" className="mt-0 space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                   <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <Activity className="h-4 w-4" />
                    </div>
                    <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Engagement Stats</h4>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 rounded-2xl bg-primary/5 border border-primary/10">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 mb-1">First Contact</p>
                      <p className="text-sm font-bold text-foreground">{formatDate(lead.firstContactedAt)}</p>
                    </div>
                    <div className="p-4 rounded-2xl bg-primary/5 border border-primary/10">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 mb-1">Last Contact</p>
                      <p className="text-sm font-bold text-foreground">{formatDate(lead.lastContactedAt)}</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                  <div className="flex items-center gap-4">
                    <div className="flex-1 p-4 rounded-2xl bg-primary/5 border border-primary/10 text-center">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 mb-1">Opened</p>
                      <p className="text-2xl font-heading font-bold text-primary">{lead.openedEmails || 0}</p>
                    </div>
                    <div className="flex-1 p-4 rounded-2xl bg-primary/5 border border-primary/10 text-center">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 mb-1">Clicked</p>
                      <p className="text-2xl font-heading font-bold text-primary">{lead.clickedLinks || 0}</p>
                    </div>
                    <div className="flex-1 p-4 rounded-2xl bg-primary/5 border border-primary/10 text-center">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 mb-1">Replied</p>
                      <p className="text-2xl font-heading font-bold text-primary">{lead.repliedEmails || 0}</p>
                    </div>
                  </div>
                </div>
              </TabsContent>

              {/* Enrichment Tab */}
              <TabsContent value="enrichment" className="mt-0 space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                {lead.enrichedData ? (
                  <>
                    {/* Enrichment Summary */}
                    <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                          <Sparkles className="h-4 w-4" />
                        </div>
                        <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Enrichment Summary</h4>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="p-4 rounded-2xl bg-primary/5 border border-primary/10">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 mb-1">Emails Found</p>
                          <p className="text-2xl font-heading font-bold text-primary">{lead.enrichedData?.emails?.length || 0}</p>
                        </div>
                        <div className="p-4 rounded-2xl bg-primary/5 border border-primary/10">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 mb-1">Phones Found</p>
                          <p className="text-2xl font-heading font-bold text-primary">{lead.enrichedData?.phones?.length || 0}</p>
                        </div>
                      </div>
                    </div>

                    {/* Extracted Emails */}
                    {lead.enrichedData?.emails?.length > 0 && (
                      <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                        <div className="flex items-center gap-3 mb-2">
                          <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                            <Mail className="h-4 w-4" />
                          </div>
                          <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Extracted Emails</h4>
                        </div>
                        <div className="space-y-1">
                          {lead.enrichedData.emails.map((email: string, i: number) => (
                            <div key={i} className="flex items-center gap-2 text-sm py-1">
                              <Mail className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                              <span className="text-foreground/80 font-mono">{email}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Extracted Phones */}
                    {lead.enrichedData?.phones?.length > 0 && (
                      <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                        <div className="flex items-center gap-3 mb-2">
                          <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                            <Phone className="h-4 w-4" />
                          </div>
                          <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Extracted Phones</h4>
                        </div>
                        <div className="space-y-1">
                          {lead.enrichedData.phones.map((phone: string, i: number) => (
                            <div key={i} className="flex items-center gap-2 text-sm py-1">
                              <Phone className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                              <span className="text-foreground/80 font-mono">{phone}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Extracted Websites */}
                    {lead.enrichedData?.websites?.length > 0 && (
                      <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                        <div className="flex items-center gap-3 mb-2">
                          <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                            <Globe className="h-4 w-4" />
                          </div>
                          <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Extracted Websites</h4>
                        </div>
                        <div className="space-y-1">
                          {lead.enrichedData.websites.map((site: string, i: number) => (
                            <div key={i} className="flex items-center gap-2 text-sm py-1">
                              <Globe className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                              <a href={site.startsWith('http') ? site : `https://${site}`} target="_blank" rel="noopener noreferrer" className="text-blue-400/80 hover:text-blue-400 truncate">
                                {site.replace(/^https?:\/\/(www\.)?/, '')}
                              </a>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Social Profiles */}
                    {lead.enrichedData?.socialProfiles && Object.keys(lead.enrichedData.socialProfiles).length > 0 && (
                      <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                        <div className="flex items-center gap-3 mb-2">
                          <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                            <Globe className="h-4 w-4" />
                          </div>
                          <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Social Profiles</h4>
                        </div>
                        <div className="space-y-2">
                          {Object.entries(lead.enrichedData.socialProfiles).map(([platform, url]) => {
                            if (!url) return null;
                            const platformLower = platform.toLowerCase();
                            let Icon = Globe;
                            if (platformLower === 'instagram') Icon = Instagram;
                            else if (platformLower === 'linkedin') Icon = Linkedin;
                            else if (platformLower === 'twitter' || platformLower === 'x') Icon = Twitter;
                            else if (platformLower === 'facebook') Icon = Facebook;
                            else if (platformLower === 'youtube') Icon = Youtube;
                            else if (platformLower === 'github') Icon = Github;
                            else if (platformLower === 'tiktok') Icon = Music;
                            else if (platformLower === 'pinterest') Icon = Pin;
                            else if (platformLower === 'whatsapp') Icon = MessageSquare;
                            return (
                              <div key={platform} className="flex items-center gap-2 text-sm py-1">
                                <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                <a href={String(url).startsWith('http') ? String(url) : `https://${url}`} target="_blank" rel="noopener noreferrer" className="text-blue-400/80 hover:text-blue-400 truncate">
                                  @{platform}
                                </a>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Company Info */}
                    {lead.enrichedData?.company && Object.keys(lead.enrichedData.company).length > 0 && (
                      <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                        <div className="flex items-center gap-3 mb-2">
                          <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                            <Building2 className="h-4 w-4" />
                          </div>
                          <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Company Info</h4>
                        </div>
                        <div className="space-y-1">
                          {lead.enrichedData.company.name && (
                            <div className="flex items-center gap-2 text-sm py-1">
                              <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="text-foreground/80">{lead.enrichedData.company.name}</span>
                            </div>
                          )}
                          {lead.enrichedData.company.industry && (
                            <div className="flex items-center gap-2 text-sm py-1">
                              <Briefcase className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="text-foreground/80">{lead.enrichedData.company.industry}</span>
                            </div>
                          )}
                          {lead.enrichedData.company.description && (
                            <p className="text-sm text-muted-foreground/70 pl-5 line-clamp-3">{lead.enrichedData.company.description}</p>
                          )}
                          {lead.enrichedData.company.address && (
                            <div className="flex items-center gap-2 text-sm py-1">
                              <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="text-foreground/80">{lead.enrichedData.company.address}</span>
                            </div>
                          )}
                          {lead.enrichedData.company.domain && (
                            <div className="flex items-center gap-2 text-sm py-1">
                              <Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="text-foreground/80">{lead.enrichedData.company.domain}</span>
                            </div>
                          )}
                          {lead.enrichedData.company.size && (
                            <div className="flex items-center gap-2 text-sm py-1">
                              <Users className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="text-foreground/80">{lead.enrichedData.company.size}</span>
                            </div>
                          )}
                          {lead.enrichedData.company.revenue && (
                            <div className="flex items-center gap-2 text-sm py-1">
                              <DollarSign className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="text-foreground/80">{lead.enrichedData.company.revenue}</span>
                            </div>
                          )}
                          {lead.enrichedData.company.founded && (
                            <div className="flex items-center gap-2 text-sm py-1">
                              <Calendar className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="text-foreground/80">Founded: {lead.enrichedData.company.founded}</span>
                            </div>
                          )}
                          {lead.enrichedData.company.techStack && (
                            <div className="flex items-center gap-2 text-sm py-1 flex-wrap">
                              <Code className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="text-foreground/80">{Array.isArray(lead.enrichedData.company.techStack) ? lead.enrichedData.company.techStack.join(', ') : lead.enrichedData.company.techStack}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Person Info */}
                    {lead.enrichedData?.person && Object.keys(lead.enrichedData.person).length > 0 && (
                      <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                        <div className="flex items-center gap-3 mb-2">
                          <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                            <User className="h-4 w-4" />
                          </div>
                          <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Person Info</h4>
                        </div>
                        <div className="space-y-1">
                          {lead.enrichedData.person.fullName && (
                            <div className="flex items-center gap-2 text-sm py-1">
                              <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="text-foreground/80">{lead.enrichedData.person.fullName}</span>
                              {lead.enrichedData.person.title && <span className="text-muted-foreground/60">· {lead.enrichedData.person.title}</span>}
                            </div>
                          )}
                          {lead.enrichedData.person.location && (
                            <div className="flex items-center gap-2 text-sm py-1">
                              <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="text-foreground/80">{formatLeadLocation(lead.enrichedData.person.location) || '—'}</span>
                            </div>
                          )}
                          {lead.enrichedData.person.headline && (
                            <p className="text-sm text-muted-foreground/70 pl-5 line-clamp-2">{lead.enrichedData.person.headline}</p>
                          )}
                          {lead.enrichedData.person.seniority && (
                            <div className="flex items-center gap-2 text-sm py-1">
                              <Briefcase className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="text-foreground/80">Seniority: {lead.enrichedData.person.seniority}</span>
                            </div>
                          )}
                          {lead.enrichedData.person.skills && (
                            <div className="flex items-center gap-2 text-sm py-1 flex-wrap">
                              <Code className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="text-foreground/80">{Array.isArray(lead.enrichedData.person.skills) ? lead.enrichedData.person.skills.join(', ') : lead.enrichedData.person.skills}</span>
                            </div>
                          )}
                          {lead.enrichedData.person.bio && (
                            <p className="text-sm text-muted-foreground/70 pl-5 line-clamp-3">{lead.enrichedData.person.bio}</p>
                          )}
                        </div>
                      </div>
                    )}

                    {/* LLM Extracted */}
                    {lead.enrichedData?.llmExtracted && Object.keys(lead.enrichedData.llmExtracted).length > 0 && (
                      <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                        <div className="flex items-center gap-3 mb-2">
                          <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                            <Brain className="h-4 w-4" />
                          </div>
                          <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">AI Extracted Data</h4>
                        </div>
                        <div className="space-y-1">
                          {Object.entries(lead.enrichedData.llmExtracted).map(([key, value]) => {
                            if (!value) return null;
                            return (
                              <div key={key} className="flex items-start gap-2 text-sm py-1">
                                <span className="text-muted-foreground/60 font-medium min-w-[120px]">{key}:</span>
                                <span className="text-foreground/80">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Enriched At */}
                    {lead.enrichedData?.enrichedAt && (
                      <div className="text-center text-xs text-muted-foreground/60">
                        Last enriched: {new Date(lead.enrichedData.enrichedAt).toLocaleString()}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-center py-12">
                    <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                      <Sparkles className="w-8 h-8 text-primary/40" />
                    </div>
                    <h4 className="text-sm font-semibold text-foreground mb-2">No Enrichment Data</h4>
                    <p className="text-sm text-muted-foreground max-w-xs mx-auto">
                      Run deep enrichment on this lead to extract emails, phones, social profiles, and company information.
                    </p>
                  </div>
                )}
              </TabsContent>

              {/* Scoring Tab */}
              <TabsContent value="scoring" className="mt-0 space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="glass p-8 rounded-[2.5rem] border-primary/10 shadow-2xl relative overflow-hidden group">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full -mr-16 -mt-16 blur-2xl group-hover:bg-primary/10 transition-all duration-1000" />
                  <div className="relative z-10 grid grid-cols-2 lg:grid-cols-3 gap-6">
                    <div className="space-y-1">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">Overall Score</p>
                      <div className="flex items-end gap-1">
                        <p className="text-2xl font-heading font-bold tracking-tighter text-primary tabular-nums tracking-tighter">{lead.score || '-'}</p>
                        <p className="text-xs font-bold opacity-30 mb-1">/ 100</p>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">ICP Alignment</p>
                      <div className="flex items-end gap-1">
                        <p className="text-2xl font-heading font-bold tracking-tighter text-green-500 tabular-nums tracking-tighter">{lead.fitScore || '-'}</p>
                        <p className="text-xs font-bold opacity-30 mb-1">/ 100</p>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">Intent Level</p>
                      <div className="flex items-end gap-1">
                        <p className="text-2xl font-heading font-bold tracking-tighter text-orange-500 tabular-nums tracking-tighter">{lead.intentScore || '-'}</p>
                        <p className="text-xs font-bold opacity-30 mb-1">/ 100</p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                   <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <Target className="h-4 w-4" />
                    </div>
                    <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Lead Scoring</h4>
                  </div>
                  <div className="divide-y divide-border/30">
                    <FieldRow label="Decision Maker" value={lead.decisionMaker ? 'Yes' : lead.decisionMaker === false ? 'No' : 'Evaluating'} />
                    <FieldRow label="Budget Information" value={lead.budgetRange || 'Evaluating'} />
                    <div className="py-4">
                      <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground/60 block mb-3">Pain Points</span>
                      <TagList tags={lead.painPoints} variant="secondary" />
                    </div>
                  </div>
                </div>
              </TabsContent>

              {/* System Tab */}
              <TabsContent value="system" className="mt-0 space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="space-y-6 glass p-6 rounded-3xl border-border/50 relative overflow-hidden">
                   <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                      <Globe className="h-4 w-4" />
                    </div>
                    <h4 className="text-xs font-bold text-foreground uppercase tracking-widest leading-none">Source Information</h4>
                  </div>
                  <div className="divide-y divide-border/30">
                    <FieldRow label="Source" value={lead.source} />
                    <FieldRow label="Lead Source ID" value={lead.actorId} />
                    <FieldRow label="Platform" value={lead.platformType} />
                    <FieldRow label="Profile UUID" value={lead.uuid} copyable />
                  </div>
                </div>
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>

        {/* Footer Actions */}
        <SheetFooter className="px-8 py-6 border-t border-border/50 bg-secondary/30">
          <div className="flex justify-between items-center w-full gap-4">
            <div className="flex gap-3">
              {onDelete && (
                <Button variant="ghost" size="lg" onClick={() => onDelete(lead)} className="rounded-2xl h-12 text-destructive hover:bg-destructive/10 font-bold px-6">
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              )}
            </div>
            <div className="flex gap-3">
              <Button
                variant="outline"
                size="lg"
                loading={isDeepEnriching}
                loadingText="Enriching..."
                onClick={async () => {
                  setIsDeepEnriching(true);
                  try {
                    await api.post(`/api/leads/${lead.id}/deep-enrich`, { async: true });
                    toast({ title: 'Deep Enrichment Started', description: 'Enrichment is running in the background. Refresh to see updates.' });
                  } catch (err: unknown) {
                    toast({ title: 'Enrichment Failed', description: err instanceof Error ? err.message : 'Could not start enrichment', variant: 'destructive' });
                  } finally {
                    setIsDeepEnriching(false);
                  }
                }}
                className="rounded-2xl h-12 border-violet-500/30 text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-950/30 font-bold px-6 transition-all"
              >
                <Sparkles className="h-4 w-4 mr-2" />
                Deep Enrich
              </Button>
              {onEdit && (
                <Button variant="outline" size="lg" onClick={() => onEdit(lead)} className="rounded-2xl h-12 glass border-border/50 font-bold px-6 hover:bg-primary/5 hover:text-primary hover:border-primary/30 transition-all">
                  <Edit className="h-4 w-4 mr-2" />
                  Edit Lead
                </Button>
              )}
              {bestChannel ? (
                <Button size="lg" onClick={() => handleStartOutreach(bestChannel)} loading={isGeneratingTemplate} loadingText="Loading..." disabled={outreachLocked} className="rounded-2xl h-12 bg-gradient-primary hover:opacity-90 text-white font-bold shadow-xl shadow-primary/20 px-10 transition-all hover:scale-[1.02]">
                  {(() => {
                    const IconComponent = bestChannel.icon;
                    return <IconComponent className="h-4 w-4 mr-2" />;
                  })()}
                  {outreachLocked ? 'Approve leads first' : 'Start Outreach'}
                </Button>
              ) : (
                <Button size="lg" disabled className="rounded-2xl h-12 opacity-40 grayscale cursor-not-allowed px-10">
                  <Send className="h-4 w-4 mr-2" />
                  No Outreach Options
                </Button>
              )}
            </div>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export default LeadDetailSheet;
