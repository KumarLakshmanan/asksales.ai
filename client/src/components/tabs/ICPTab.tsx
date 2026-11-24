import { Target, Save, X, Pencil } from "lucide-react";
import { LoadingState } from "@/components/ui/loading-state";
import { useEffect, useState, useCallback } from "react";
import { useWebSocket } from "@/contexts/WebSocketContext";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface ICPApiResponse {
  id?: number;
  campaignName?: string;
  campaignObjective?: string;
  targetAudience?: string;
  industry?: string;
  subIndustry?: string;
  businessType?: string;
  primaryRegions?: string[];
  primaryJobTitles?: string[];
  primaryChannels?: string[];
  targetCompanySizeRange?: string;
  targetRevenueRange?: string;
  targetBusinessModel?: string;
  companySizeRange?: string;
  revenueRange?: string;
  budgetRange?: string;
  techStack?: string[];
  primaryPainPoint?: string;
  primaryPainPoints?: string[];
  decisionMakers?: string[];
  summary?: string;
  keywords?: string[];
  messagingThemes?: string[];
  fitScore?: number;
  businessId?: number;
  businessName?: string;
  companyName?: string;
  companyAddress?: string;
  businessIndustry?: string;
  businessWebsite?: string;
  businessDescription?: string;
  primaryValueProposition?: string;
  userIntent?: string;
  recommendedAgentScores?: {
    lead_generation?: number;
    content_studio?: number;
    performance_marketing?: number;
    outreach?: number;
  };
}

interface BusinessInfo {
  id?: number;
  name?: string;
  companyName?: string;
  businessType?: string;
  industry?: string;
  website?: string;
  description?: string;
  city?: string;
  country?: string;
}

interface ICPProfile {
  campaign_name?: string;
  campaign_objective?: string;
  target_audience?: string;
  industry?: string;
  sub_industry?: string;
  target_company_size_range?: string;
  target_revenue_range?: string;
  target_business_model?: string;
  primary_regions?: string[];
  primary_job_titles?: string[];
  primary_channels?: string[];
  budget_range?: string;
  primary_value_proposition?: string;
  primary_pain_point?: string;
  summary?: string;
  industry_vertical?: string;
  business_type?: string;
  geography_locations?: string[];
  target_roles_titles?: string[];
  interests?: string[];
  sources?: string[];
  company_size?: string;
  revenue_range?: string;
  technologies?: string[];
  pain_points?: string[];
  company_size_range?: string;
  company_revenue?: string;
  business_model?: string;
}

interface ICPTabProps {
  icp: ICPProfile | null;
  fitScore?: number;
  icpId?: number;
  threadId?: number;
  businessId?: number;
  onFitScoreUpdate?: (fitScore: number) => void;
  onStartLeadGeneration?: () => void;
  onSendMessage?: (message: string) => void;
}

interface Lead {
  id: number;
  name: string;
  title: string;
  company: string;
  email?: string;
  phone?: string;
  platform: string;
  createdAt: string;
}

export default function ICPTab({
  icp,
  fitScore = 0,
  icpId,
  threadId,
  businessId,
  onFitScoreUpdate,
  // eslint-disable-next-line unused-imports/no-unused-vars
  onSendMessage,
}: ICPTabProps) {
  const [liveICP, setLiveICP] = useState<ICPProfile | null>(icp);
  const [liveFitScore, setLiveFitScore] = useState(fitScore);
  const [businessInfo, setBusinessInfo] = useState<BusinessInfo | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [_, setLeadProgress] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editedICP, setEditedICP] = useState<ICPProfile | null>(null);
  const [backendIcpId, setBackendIcpId] = useState<number | null>(icpId || null);
  const [channelInput, setChannelInput] = useState('');
  const { subscribe: wsSubscribe, isConnected: wsConnected } = useWebSocket();
  const { toast } = useToast();

  useEffect(() => {
    if (icpId) setBackendIcpId(icpId);
  }, [icpId]);

  useEffect(() => {
    if (icp && !isEditing) {
      setLiveICP({ ...icp, primary_regions: icp.primary_regions || icp.geography_locations, primary_job_titles: icp.primary_job_titles || icp.target_roles_titles, primary_channels: icp.primary_channels || icp.sources, industry: icp.industry || icp.industry_vertical, target_business_model: icp.target_business_model || icp.business_model || icp.business_type, target_company_size_range: icp.target_company_size_range || icp.company_size_range || icp.company_size, target_revenue_range: icp.target_revenue_range || icp.company_revenue || icp.revenue_range });
    }
  }, [icp, isEditing]);

  // Sync liveFitScore when parent updates fitScore prop (e.g., via WebSocket icp_update)
  useEffect(() => {
    if (!isEditing) {
      setLiveFitScore(fitScore);
    }
  }, [fitScore, isEditing]);

  useEffect(() => {
    if (!businessId || businessInfo?.id === businessId) return;
    const loadBusinessInfo = async () => {
      try {
        const response = await api.get<{ id: number; name: string; companyName: string; industry: string; website: string; description: string; }>(`/api/settings/business-profiles/${businessId}`);
        if (response) setBusinessInfo({ id: response.id, name: response.name, companyName: response.companyName, industry: response.industry, website: response.website, description: response.description });
      } catch (error) { console.error('[ICPTab] Error loading business info:', error); }
    };
    loadBusinessInfo();
  }, [businessId, businessInfo?.id]);

  const loadLeads = useCallback(async () => {
    if (!icpId) return;
    try {
      const _response = await api.get<Lead[]>(`/api/leads?icpId=${icpId}&limit=50`);
    } catch (error) { console.error('[ICPTab] Error loading leads:', error); }
  }, [icpId]);

  useEffect(() => {
    if (!threadId) return;
    const loadICP = async () => {
      setIsLoading(true);
      try {
        const response = await api.get<ICPApiResponse & { businessId?: number; businessName?: string; companyName?: string; businessIndustry?: string; businessWebsite?: string; businessDescription?: string; }>(`/api/icp/thread/${threadId}`);
        if (response) {
          const icpData: ICPProfile = {
            campaign_name: response.campaignName, campaign_objective: response.campaignObjective, target_audience: response.targetAudience,
            industry: response.industry, sub_industry: response.subIndustry,
            target_company_size_range: response.targetCompanySizeRange || response.companySizeRange, target_revenue_range: response.targetRevenueRange || response.revenueRange, target_business_model: response.targetBusinessModel || response.businessType,
            primary_regions: response.primaryRegions, primary_job_titles: response.primaryJobTitles, primary_channels: response.primaryChannels,
            budget_range: response.budgetRange, primary_value_proposition: response.primaryValueProposition, primary_pain_point: response.primaryPainPoint || (response.primaryPainPoints && response.primaryPainPoints[0]) || undefined,
            company_size_range: response.targetCompanySizeRange || response.companySizeRange, company_revenue: response.targetRevenueRange || response.revenueRange, business_model: response.targetBusinessModel || response.businessType,
            technologies: response.techStack, pain_points: response.primaryPainPoint ? [response.primaryPainPoint] : response.primaryPainPoints, summary: response.summary,
            industry_vertical: response.industry, business_type: response.targetBusinessModel || response.businessType, geography_locations: response.primaryRegions,
            target_roles_titles: response.primaryJobTitles, interests: response.keywords, sources: response.primaryChannels,
            company_size: response.targetCompanySizeRange || response.companySizeRange, revenue_range: response.targetRevenueRange || response.revenueRange,
          };
          setLiveICP(icpData);
          setLiveFitScore(response.fitScore || 0);
          setBackendIcpId(response.id || null);
          if (response.businessId) setBusinessInfo({ id: response.businessId, name: response.businessName, companyName: response.companyName, industry: response.businessIndustry, website: response.businessWebsite, description: response.businessDescription });
          if (onFitScoreUpdate && response.fitScore !== undefined) onFitScoreUpdate(response.fitScore);
        }
      } catch (error) { console.error('[ICPTab] Error loading ICP:', error); }
      finally { setIsLoading(false); }
    };
    loadICP();
  }, [threadId, onFitScoreUpdate]);

  const handleEditClick = () => { setEditedICP({ ...liveICP } as ICPProfile); setIsEditing(true); };
  const handleCancelEdit = () => { setEditedICP(null); setIsEditing(false); };

  const handleSaveEdit = async () => {
    if (!editedICP || !backendIcpId) { toast({ title: "Error", description: "Cannot save: ICP data not available", variant: "destructive" }); return; }
    try {
      setIsSaving(true);
      const updatePayload = {
        campaignName: editedICP.campaign_name, campaignObjective: editedICP.campaign_objective, targetAudience: editedICP.target_audience,
        industry: editedICP.industry, subIndustry: editedICP.sub_industry,
        targetCompanySizeRange: editedICP.target_company_size_range || editedICP.company_size_range,
        targetRevenueRange: editedICP.target_revenue_range || editedICP.company_revenue,
        targetBusinessModel: editedICP.target_business_model || editedICP.business_model,
        primaryRegions: editedICP.primary_regions, primaryJobTitles: editedICP.primary_job_titles, primaryChannels: editedICP.primary_channels,
        budgetRange: editedICP.budget_range, primaryValueProposition: editedICP.primary_value_proposition, primaryPainPoint: editedICP.primary_pain_point, summary: editedICP.summary,
      };
      const response = await api.put<{ message: string; fitScore: number }>(`/api/icp/${backendIcpId}`, updatePayload);
      setLiveICP(editedICP);
      setLiveFitScore(response.fitScore);
      setIsEditing(false);
      setEditedICP(null);
      if (onFitScoreUpdate) onFitScoreUpdate(response.fitScore);
      toast({ title: "Saved", description: `Profile updated. Fit score: ${response.fitScore}%` });
    } catch (error) {
      console.error('[ICPTab] Error saving ICP:', error);
      toast({ title: "Error", description: error instanceof Error ? error.message : 'Failed to save ICP', variant: "destructive" });
    } finally { setIsSaving(false); }
  };

  const handleArrayChange = (field: keyof ICPProfile, value: string) => {
    if (!editedICP) return;
    const arrayValue = value.split(',').map(item => item.trim()).filter(item => item.length > 0);
    setEditedICP({ ...editedICP, [field]: arrayValue });
  };

  useEffect(() => {
    setIsConnected(wsConnected);
    const unsubICP = wsSubscribe('icp_update', (event: Record<string, unknown>) => {
      if (event.icp_id === icpId) {
        if (event.fit_score !== undefined) setLiveFitScore(event.fit_score as number);
        if (event.updated_fields && typeof event.updated_fields === 'object') {
          setLiveICP(prevICP => ({ ...prevICP, ...(event.updated_fields as Record<string, unknown>), target_audience: (event.target_audience as string) || prevICP?.target_audience, summary: (event.summary as string) || prevICP?.summary }));
        }
      }
    });
    const unsubWorkflowStarted = wsSubscribe('workflow_started', (_event: Record<string, unknown>) => { setLeadProgress(0); });
    const unsubWorkflowStep = wsSubscribe('workflow_step', (event: Record<string, unknown>) => { if (event.progress !== undefined) setLeadProgress(event.progress as number); });
    const unsubWorkflowCompleted = wsSubscribe('workflow_completed', (_event: Record<string, unknown>) => { if (icpId) loadLeads(); });
    const unsubBatchProgress = wsSubscribe('batch_progress', (event: Record<string, unknown>) => {
      const progress = event.progress as number | undefined;
      const completed = event.completed as number;
      const total = event.total as number;
      setLeadProgress(progress || (completed / total) * 100);
    });
    const unsubExecutionSummary = wsSubscribe('execution_summary', (event: Record<string, unknown>) => {
      const results = event.results as Array<{ leads_count?: number }> | undefined;
      const totalLeads = results?.reduce((sum: number, r) => sum + (r.leads_count || 0), 0) || 0;
      toast({ title: "Lead Generation Complete", description: `Successfully generated ${totalLeads} leads` });
      if (icpId) loadLeads();
    });
    return () => { unsubICP(); unsubWorkflowStarted(); unsubWorkflowStep(); unsubWorkflowCompleted(); unsubBatchProgress(); unsubExecutionSummary(); };
  }, [wsSubscribe, icpId, wsConnected, toast, loadLeads]);

  useEffect(() => {
    if (isConnected || !icpId) return;
    const pollICP = async () => {
      try {
        const icpData = await api.get<ICPApiResponse>(`/api/icp/profile/${icpId}`);
        if (icpData) {
          const updatedICP: ICPProfile = {
            campaign_name: icpData.campaignName, campaign_objective: icpData.campaignObjective, target_audience: icpData.targetAudience,
            industry: icpData.industry, sub_industry: icpData.subIndustry, business_model: icpData.targetBusinessModel || icpData.businessType,
            company_size_range: icpData.targetCompanySizeRange || icpData.companySizeRange, company_revenue: icpData.targetRevenueRange || icpData.revenueRange,
            primary_regions: icpData.primaryRegions, primary_job_titles: icpData.primaryJobTitles, primary_channels: icpData.primaryChannels,
            budget_range: icpData.budgetRange, primary_value_proposition: icpData.primaryValueProposition, primary_pain_point: icpData.primaryPainPoint || (icpData.primaryPainPoints && icpData.primaryPainPoints[0]) || undefined, summary: icpData.summary,
            industry_vertical: icpData.industry, business_type: icpData.targetBusinessModel || icpData.businessType, geography_locations: icpData.primaryRegions,
            target_roles_titles: icpData.primaryJobTitles, interests: icpData.keywords, sources: icpData.primaryChannels,
            company_size: icpData.targetCompanySizeRange || icpData.companySizeRange, revenue_range: icpData.targetRevenueRange || icpData.revenueRange,
            target_company_size_range: icpData.targetCompanySizeRange || icpData.companySizeRange,
            target_revenue_range: icpData.targetRevenueRange || icpData.revenueRange,
            target_business_model: icpData.targetBusinessModel || icpData.businessType,
            pain_points: icpData.primaryPainPoint ? [icpData.primaryPainPoint] : icpData.primaryPainPoints,
          };
          setLiveICP(updatedICP);
          setLiveFitScore(icpData.fitScore || 0);
        }
      } catch (error) { console.error('Error polling ICP:', error); }
    };
    pollICP();
    // A hidden tab skips polls; the next tick after it is shown catches up.
    const interval = setInterval(() => { if (document.visibilityState !== 'hidden') void pollICP(); }, 5000);
    return () => clearInterval(interval);
  }, [icpId, isConnected]);

  const displayICP = isEditing ? editedICP : (liveICP || icp);

  const hasValue = (val: unknown): boolean => {
    if (val === null || val === undefined) return false;
    if (typeof val === 'string') { const t = val.trim().toLowerCase(); return t !== '' && t !== 'null' && t !== 'undefined' && t !== 'n/a'; }
    if (Array.isArray(val)) return val.length > 0;
    return true;
  };

  const VALID_CHANNELS_MAP: Record<string, string> = { linkedin: 'LinkedIn', google_maps: 'Google Maps', facebook: 'Facebook', twitter: 'Twitter', instagram: 'Instagram', justdial: 'JustDial' };
  const CHANNEL_LOGOS: Record<string, string> = { linkedin: '/logos/platforms/linkedin.svg', google_maps: '/logos/platforms/google_maps.svg', facebook: '/logos/platforms/facebook.svg', twitter: '/logos/platforms/twitter.svg', instagram: '/logos/platforms/instagram.svg', justdial: '/logos/platforms/justdial.svg' };
  const getChannelKey = (channel: string): string => channel.toLowerCase().replace(/[\s-]/g, '_');
  const getChannelLogo = (channel: string): string | null => CHANNEL_LOGOS[getChannelKey(channel)] || null;
  const formatChannel = (channel: string): string | null => { const key = getChannelKey(channel); if (key === 'web_scraping' || key === 'webscraping') return null; return VALID_CHANNELS_MAP[key] || channel.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); };

  const businessModel = displayICP?.target_business_model || displayICP?.business_model || '';
  const isB2C = businessModel.toLowerCase().includes('b2c');

  if (isLoading) {
    return (
      <LoadingState label="Loading ICP…" className="h-full" />
    );
  }

  if (!displayICP) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
          <Target className="w-6 h-6 text-primary/50" />
        </div>
        <p className="text-sm font-medium">No Profile Data</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-xs leading-relaxed">Start a conversation to define your Ideal Customer Profile.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b bg-card flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Target className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">Ideal Customer Profile</p>
            {liveFitScore > 0 && <p className="text-xs text-muted-foreground">Completeness: {liveFitScore}%</p>}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {isEditing ? (
            <>
              <Button variant="outline" size="sm" onClick={handleCancelEdit} disabled={isSaving} className="h-8 px-3 rounded-lg text-xs border-border/60 gap-1.5"><X className="w-3.5 h-3.5" /> Discard</Button>
              <Button size="sm" onClick={handleSaveEdit} loading={isSaving} loadingText="Save" className="h-8 px-3 rounded-lg text-xs gap-1.5">
                <Save className="w-3.5 h-3.5" /> Save
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={handleEditClick} className="h-8 px-3 rounded-lg text-xs border-border/60 gap-1.5">
              <Pencil className="w-3.5 h-3.5" /> Edit
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {isEditing ? (
          /* Edit Form */
          <>
            {/* Campaign Overview */}
            <div className="border border-border/40 bg-card rounded-xl p-4 shadow-sm space-y-3">
              <p className="text-xs font-medium text-muted-foreground">Campaign Overview</p>
              <div className="space-y-2">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Campaign Name</Label>
                  <Input className="h-9 rounded-lg border-border/60 text-sm" placeholder="Name your campaign" value={editedICP?.campaign_name || ''} onChange={(e) => setEditedICP({ ...editedICP!, campaign_name: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Campaign Objective</Label>
                  <Input className="h-9 rounded-lg border-border/60 text-sm" placeholder="e.g. Lead generation, Brand awareness" value={editedICP?.campaign_objective || ''} onChange={(e) => setEditedICP({ ...editedICP!, campaign_objective: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Target Audience</Label>
                  <Textarea className="rounded-lg border-border/60 text-sm min-h-[70px] resize-none" placeholder="Describe your target audience" value={editedICP?.target_audience || ''} onChange={(e) => setEditedICP({ ...editedICP!, target_audience: e.target.value })} />
                </div>
              </div>
            </div>

            {/* Industry & Business Model */}
            <div className="border border-border/40 bg-card rounded-xl p-4 shadow-sm space-y-3">
              <p className="text-xs font-medium text-muted-foreground">Industry & Business Model</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Industry</Label>
                  <Input className="h-9 rounded-lg border-border/60 text-sm" placeholder="e.g. SaaS, E-commerce" value={editedICP?.industry || ''} onChange={(e) => setEditedICP({ ...editedICP!, industry: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Sub-Industry</Label>
                  <Input className="h-9 rounded-lg border-border/60 text-sm" placeholder="e.g. Marketing Tech" value={editedICP?.sub_industry || ''} onChange={(e) => setEditedICP({ ...editedICP!, sub_industry: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Business Model</Label>
                  <Input className="h-9 rounded-lg border-border/60 text-sm" placeholder="e.g. B2B, B2C, B2B2C" value={editedICP?.target_business_model || editedICP?.business_model || ''} onChange={(e) => setEditedICP({ ...editedICP!, target_business_model: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Budget Range</Label>
                  <Input className="h-9 rounded-lg border-border/60 text-sm" placeholder="e.g. $10k-$50k/month" value={editedICP?.budget_range || ''} onChange={(e) => setEditedICP({ ...editedICP!, budget_range: e.target.value })} />
                </div>
              </div>
            </div>

            {/* Target Company */}
            <div className="border border-border/40 bg-card rounded-xl p-4 shadow-sm space-y-3">
              <p className="text-xs font-medium text-muted-foreground">Target Company</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{isB2C ? 'Target Market Size' : 'Company Size'}</Label>
                  <Input className="h-9 rounded-lg border-border/60 text-sm" placeholder="e.g. 50-500 employees" value={editedICP?.target_company_size_range || editedICP?.company_size_range || ''} onChange={(e) => setEditedICP({ ...editedICP!, target_company_size_range: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{isB2C ? 'Consumer Spending' : 'Revenue Range'}</Label>
                  <Input className="h-9 rounded-lg border-border/60 text-sm" placeholder="e.g. $1M-$50M" value={editedICP?.target_revenue_range || editedICP?.company_revenue || ''} onChange={(e) => setEditedICP({ ...editedICP!, target_revenue_range: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Primary Regions (comma-separated)</Label>
                <Input className="h-9 rounded-lg border-border/60 text-sm" placeholder="e.g. United States, Canada, UK" value={(editedICP?.primary_regions || []).join(', ')} onChange={(e) => handleArrayChange('primary_regions', e.target.value)} />
              </div>
            </div>

            {/* Decision Makers & Channels */}
            <div className="border border-border/40 bg-card rounded-xl p-4 shadow-sm space-y-3">
              <p className="text-xs font-medium text-muted-foreground">{isB2C ? 'Target Personas & Channels' : 'Decision Makers & Channels'}</p>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{isB2C ? 'Target Demographics' : 'Target Job Titles'} (comma-separated)</Label>
                <Input className="h-9 rounded-lg border-border/60 text-sm" placeholder="e.g. CMO, VP Marketing, Director" value={(editedICP?.primary_job_titles || []).join(', ')} onChange={(e) => handleArrayChange('primary_job_titles', e.target.value)} />
              </div>
              {/* Channels with logo selector */}
              <div className="space-y-2">
                <Label className="text-xs font-medium">Lead Generation Channels</Label>
                <div className="border border-border/60 rounded-lg p-2.5 min-h-[44px] flex flex-wrap gap-1.5 items-center focus-within:border-primary/50 transition-colors">
                  {(editedICP?.primary_channels || []).map((channel, idx) => {
                    const logo = getChannelLogo(channel);
                    const displayName = VALID_CHANNELS_MAP[getChannelKey(channel)] || channel;
                    return (
                      <Badge key={idx} className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-primary/10 text-primary border border-primary/20">
                        {logo && <img src={logo} alt={displayName} className="w-3 h-3 rounded-sm object-contain grayscale opacity-70" />}
                        {displayName}
                        <button type="button" onClick={() => { const updated = [...(editedICP?.primary_channels || [])]; updated.splice(idx, 1); setEditedICP({ ...editedICP!, primary_channels: updated }); }} className="ml-1 hover:text-destructive transition-colors"><X className="w-2.5 h-2.5" /></button>
                      </Badge>
                    );
                  })}
                  <input type="text" value={channelInput} onChange={(e) => setChannelInput(e.target.value)} onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault();
                      const val = channelInput.trim().replace(/,/g, '').toLowerCase();
                      if (val && !(editedICP?.primary_channels || []).includes(val)) setEditedICP({ ...editedICP!, primary_channels: [...(editedICP?.primary_channels || []), val] });
                      setChannelInput('');
                    } else if (e.key === 'Backspace' && !channelInput && (editedICP?.primary_channels || []).length > 0) {
                      const updated = [...(editedICP?.primary_channels || [])]; updated.pop(); setEditedICP({ ...editedICP!, primary_channels: updated });
                    }
                  }} placeholder={!(editedICP?.primary_channels || []).length ? 'Type channel...' : 'Add...'} className="flex-1 min-w-[100px] outline-none text-xs bg-transparent placeholder:text-muted-foreground/50 py-0.5" />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {['linkedin', 'facebook', 'twitter', 'instagram', 'google_maps', 'justdial'].map((ch) => {
                    const isAdded = (editedICP?.primary_channels || []).includes(ch);
                    const logo = getChannelLogo(ch);
                    const displayName = VALID_CHANNELS_MAP[ch] || ch;
                    return (
                      <button key={ch} type="button" onClick={() => {
                        if (isAdded) setEditedICP({ ...editedICP!, primary_channels: (editedICP?.primary_channels || []).filter(c => c !== ch) });
                        else setEditedICP({ ...editedICP!, primary_channels: [...(editedICP?.primary_channels || []), ch] });
                      }} className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border transition-colors', isAdded ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border/40 text-muted-foreground hover:border-primary/30 hover:text-primary')}>
                        {logo && <img src={logo} alt={displayName} className={cn('w-3 h-3 rounded-sm object-contain', isAdded ? 'brightness-0 invert' : 'grayscale opacity-40')} />}
                        {displayName}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Messaging Strategy */}
            <div className="border border-border/40 bg-card rounded-xl p-4 shadow-sm space-y-3">
              <p className="text-xs font-medium text-muted-foreground">Messaging Strategy</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Value Proposition</Label>
                  <Textarea className="rounded-lg border-border/60 text-sm min-h-[80px] resize-none" placeholder="Describe the primary value drivers..." value={editedICP?.primary_value_proposition || ''} onChange={(e) => setEditedICP({ ...editedICP!, primary_value_proposition: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Primary Pain Points</Label>
                  <Textarea className="rounded-lg border-border/60 text-sm min-h-[80px] resize-none" placeholder="Identify key pain points..." value={editedICP?.primary_pain_point || ''} onChange={(e) => setEditedICP({ ...editedICP!, primary_pain_point: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Summary</Label>
                <Textarea className="rounded-lg border-border/60 text-sm min-h-[80px] resize-none" placeholder="ICP profile summary..." value={editedICP?.summary || ''} onChange={(e) => setEditedICP({ ...editedICP!, summary: e.target.value })} />
              </div>
            </div>
          </>
        ) : (
          /* Display Mode */
          <>
            {/* Fit Score */}
            {liveFitScore > 0 && (
              <div className="border border-border/40 bg-card rounded-xl p-4 shadow-sm flex items-center gap-3">
                <div className="relative w-12 h-12 shrink-0">
                  <svg className="w-full h-full -rotate-90" viewBox="0 0 40 40">
                    <circle cx="20" cy="20" r="16" fill="none" stroke="hsl(var(--muted))" strokeWidth="4" />
                    <circle cx="20" cy="20" r="16" fill="none" stroke="hsl(var(--primary))" strokeWidth="4" strokeDasharray={`${(liveFitScore / 100) * 100.5} 100.5`} strokeLinecap="round" />
                  </svg>
                  <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold">{liveFitScore}%</span>
                </div>
                <div>
                  <p className="text-sm font-medium">ICP completeness</p>
                  <p className="text-xs text-muted-foreground">Filled profile fields, not predicted campaign performance</p>
                </div>
              </div>
            )}

            {/* Summary */}
            {hasValue(displayICP?.summary) && (
              <div className="border border-border/40 bg-card rounded-xl p-4 shadow-sm">
                <p className="text-xs font-medium text-muted-foreground mb-2">Summary</p>
                <p className="text-xs text-foreground leading-relaxed">{displayICP?.summary}</p>
              </div>
            )}

            {/* Profile Details */}
            <div className="border border-border/40 bg-card rounded-xl shadow-sm overflow-hidden">
              {[
                { label: 'Campaign', value: displayICP?.campaign_name },
                { label: 'Objective', value: displayICP?.campaign_objective },
                { label: 'Industry', value: displayICP?.industry || displayICP?.industry_vertical },
                { label: 'Business Model', value: displayICP?.target_business_model || displayICP?.business_model || displayICP?.business_type },
                { label: isB2C ? 'Market Size' : 'Company Size', value: displayICP?.target_company_size_range || displayICP?.company_size_range || displayICP?.company_size },
                { label: isB2C ? 'Consumer Spending' : 'Revenue Range', value: displayICP?.target_revenue_range || displayICP?.company_revenue || displayICP?.revenue_range },
                { label: 'Budget Range', value: displayICP?.budget_range },
              ].filter(item => hasValue(item.value)).map((item, idx) => (
                <div key={idx} className="flex items-start gap-3 px-4 py-3 border-b border-border/30 last:border-0 hover:bg-muted/20 transition-colors">
                  <p className="text-xs text-muted-foreground w-28 shrink-0">{item.label}</p>
                  <p className="text-xs font-medium flex-1">{item.value as string}</p>
                </div>
              ))}
            </div>

            {/* Target Audience */}
            {hasValue(displayICP?.target_audience) && (
              <div className="border border-border/40 bg-card rounded-xl p-4 shadow-sm">
                <p className="text-xs font-medium text-muted-foreground mb-2">Target Audience</p>
                <p className="text-xs text-foreground leading-relaxed">{displayICP?.target_audience}</p>
              </div>
            )}

            {/* Regions */}
            {hasValue(displayICP?.primary_regions || displayICP?.geography_locations) && (
              <div className="border border-border/40 bg-card rounded-xl p-4 shadow-sm">
                <p className="text-xs font-medium text-muted-foreground mb-2">Primary Regions</p>
                <div className="flex flex-wrap gap-1.5">
                  {(displayICP?.primary_regions || displayICP?.geography_locations || []).map((r, i) => (
                    <Badge key={i} variant="outline" className="text-[10px] rounded-md border-border/40 h-5 px-2">{r}</Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Job Titles */}
            {hasValue(displayICP?.primary_job_titles || displayICP?.target_roles_titles) && (
              <div className="border border-border/40 bg-card rounded-xl p-4 shadow-sm">
                <p className="text-xs font-medium text-muted-foreground mb-2">{isB2C ? 'Target Demographics' : 'Target Job Titles'}</p>
                <div className="flex flex-wrap gap-1.5">
                  {(displayICP?.primary_job_titles || displayICP?.target_roles_titles || []).map((t, i) => (
                    <Badge key={i} variant="outline" className="text-[10px] rounded-md border-border/40 h-5 px-2">{t}</Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Channels */}
            {hasValue(displayICP?.primary_channels || displayICP?.sources) && (
              <div className="border border-border/40 bg-card rounded-xl p-4 shadow-sm">
                <p className="text-xs font-medium text-muted-foreground mb-2">Lead Generation Channels</p>
                <div className="flex flex-wrap gap-2">
                  {(displayICP?.primary_channels || displayICP?.sources || []).map((channel, i) => {
                    const formatted = formatChannel(channel);
                    if (!formatted) return null;
                    const logo = getChannelLogo(channel);
                    return (
                      <div key={i} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-card border border-border/40 shadow-sm">
                        {logo && <img src={logo} alt={formatted} className="w-4 h-4 rounded-sm object-contain" />}
                        <span className="text-xs font-medium">{formatted}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Messaging */}
            {(hasValue(displayICP?.primary_value_proposition) || hasValue(displayICP?.primary_pain_point)) && (
              <div className="border border-border/40 bg-card rounded-xl p-4 shadow-sm space-y-3">
                <p className="text-xs font-medium text-muted-foreground">Messaging Strategy</p>
                {hasValue(displayICP?.primary_value_proposition) && (
                  <div>
                    <p className="text-[10px] font-medium text-muted-foreground/60 mb-1.5">Value Proposition</p>
                    <p className="text-xs text-foreground leading-relaxed">{displayICP?.primary_value_proposition}</p>
                  </div>
                )}
                {hasValue(displayICP?.primary_pain_point) && (
                  <div>
                    <p className="text-[10px] font-medium text-muted-foreground/60 mb-1.5">Pain Points</p>
                    <p className="text-xs text-foreground leading-relaxed">{displayICP?.primary_pain_point}</p>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
