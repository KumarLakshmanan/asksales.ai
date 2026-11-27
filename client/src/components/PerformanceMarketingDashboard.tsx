"use client";

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { 
  Loader2, 
  TrendingUp, 
  IndianRupee, 
  Target, 
  BarChart3,
  Eye,
  MousePointer,
  ShoppingCart,
  Sparkles
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import { useOptionalWebSocket } from '@/contexts/WebSocketContext';

interface BudgetPlanResponse {
  budget_plan: BudgetPlan;
}

interface CampaignResponse {
  campaign: Campaign;
}

interface OptimizationResponse {
  optimization: OptimizationResult;
}

interface BudgetPlan {
  daily_budget?: number;
  channel_allocation?: Array<{
    channel: string;
    percentage: number;
    budget?: number;
    rationale?: string;
    expected_metrics?: {
      impressions?: number;
      clicks?: number;
      conversions?: number;
      cpa?: number;
    };
  }>;
  expected_roas?: number;
  recommendations?: string[];
}

interface SavedBudgetPlanRow {
  total_budget: number | string;
  duration_days: number | string;
  currency?: string;
  daily_budget?: number | string;
  channel_allocation?: BudgetPlan['channel_allocation'];
  recommendations?: string[];
  created_at?: string;
}

interface Campaign {
  id: number;
  platform: string;
  campaign_type: string;
  budget?: number;
  currency?: string;
  status: string;
  created_at: string;
  ad_sets?: Array<{
    ad_set_name: string;
    strategy: string;
    budget?: number;
    ads?: Array<unknown>;
  }>;
  targeting?: {
    locations?: string[];
    age_range?: string;
    interests?: string[];
  };
  kpis?: {
    target_impressions?: number;
    target_clicks?: number;
    target_conversions?: number;
    target_roas?: number;
  };
}

interface OptimizationResult {
  recommendations?: Array<{
    recommendation: string;
    priority: 'high' | 'medium' | 'low';
    category?: string;
    action_required?: string;
    expected_impact?: string;
  }>;
  budget_adjustments?: Array<{
    channel: string;
    current_budget: number;
    recommended_budget: number;
    reason: string;
  }>;
  targeting_suggestions?: string[];
  creative_insights?: string[];
}

interface PerformanceMarketingDashboardProps {
  icpId: number;
}

type MetricKey = 'impressions' | 'clicks' | 'conversions' | 'spend' | 'ctr' | 'cpa' | 'roas';
const metricFields: Array<{ key: MetricKey; label: string; integer?: boolean; max?: number; money?: boolean }> = [
  { key: 'impressions', label: 'Impressions', integer: true },
  { key: 'clicks', label: 'Clicks', integer: true },
  { key: 'conversions', label: 'Conversions' },
  { key: 'spend', label: 'Amount spent', money: true },
  { key: 'ctr', label: 'Click-through rate (%)', max: 100 },
  { key: 'cpa', label: 'Cost per acquisition', money: true },
  { key: 'roas', label: 'Return on ad spend (×)' },
];

export default function PerformanceMarketingDashboard({ icpId }: PerformanceMarketingDashboardProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('budget');

  // Budget Plan State
  const [totalBudget, setTotalBudget] = useState<number>(30000);
  const [budgetDuration, setBudgetDuration] = useState<number>(30);
  const [currency, setCurrency] = useState<string>('INR');
  const [generatedBudgetPlan, setGeneratedBudgetPlan] = useState<BudgetPlan | null>(null);
  const [savedPlanDate, setSavedPlanDate] = useState<string | null>(null);
  // Bumped when Sarah saves a plan from chat, so an open tab shows it at once.
  const [savedPlanVersion, setSavedPlanVersion] = useState(0);
  const webSocket = useOptionalWebSocket();
  useEffect(() => {
    if (!webSocket) return;
    return webSocket.subscribe('budget_plan_saved', (event) => {
      if (Number(event.icpId) === icpId) setSavedPlanVersion(version => version + 1);
    });
  }, [webSocket, icpId]);

  // Campaign Builder State
  const [campaignPlatform, setCampaignPlatform] = useState<string>('google');
  const [campaignBudget, setCampaignBudget] = useState<number>(10000);
  const [campaignDuration, setCampaignDuration] = useState<number>(30);
  const [generatedCampaign, setGeneratedCampaign] = useState<Campaign | null>(null);

  // Campaigns List State
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [filterPlatform, setFilterPlatform] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');

  // Optimization State
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>('');
  const [currentMetrics, setCurrentMetrics] = useState<Record<MetricKey, string>>({
    impressions: '', clicks: '', conversions: '', spend: '', ctr: '', cpa: '', roas: '',
  });
  const [metricErrors, setMetricErrors] = useState<Partial<Record<MetricKey | 'campaign' | 'metrics', string>>>({});
  const [optimizationResults, setOptimizationResults] = useState<OptimizationResult | null>(null);

  const loadCampaigns = useCallback(async () => {
    try {
      const data = await api.get(`/api/campaigns/performance/campaigns?icp_id=${icpId}`) as { campaigns?: Campaign[] };
      setCampaigns(data.campaigns || []);
    } catch (_error: unknown) {
      setCampaigns([]);
    }
  }, [icpId]);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  // Start from the plan already saved for this campaign, which Sarah also reads,
  // instead of fixed numbers the chat knows nothing about.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.get(`/api/campaigns/performance/budget-plans?icp_id=${icpId}`) as { budget_plans?: SavedBudgetPlanRow[] };
        const latest = data.budget_plans?.[0];
        if (cancelled || !latest) return;
        const total = Number(latest.total_budget);
        const days = Number(latest.duration_days);
        if (Number.isFinite(total) && total > 0) setTotalBudget(total);
        if (Number.isFinite(days) && days > 0) setBudgetDuration(days);
        if (latest.currency) setCurrency(String(latest.currency).toUpperCase());
        setGeneratedBudgetPlan({
          daily_budget: Number(latest.daily_budget) || undefined,
          channel_allocation: Array.isArray(latest.channel_allocation) ? latest.channel_allocation : [],
          recommendations: Array.isArray(latest.recommendations) ? latest.recommendations : [],
        });
        setSavedPlanDate(latest.created_at ? new Date(latest.created_at).toLocaleDateString() : null);
      } catch {
        // No saved plan yet: keep the starting values.
      }
    })();
    return () => { cancelled = true; };
  }, [icpId, savedPlanVersion]);

  const handleGenerateBudgetPlan = async () => {
    if (totalBudget <= 0) {
      toast({
        title: 'Invalid Budget',
        description: 'Please enter a valid budget amount',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    try {
      const response = await api.post<BudgetPlanResponse>('/api/campaigns/performance/budget-plan', {
        icp_id: icpId,
        total_budget: totalBudget,
        duration_days: budgetDuration,
        currency: currency
      });
      setGeneratedBudgetPlan(response.budget_plan);
      setSavedPlanDate(null);

      toast({
        title: 'Budget Plan Generated!',
        description: `${currency} ${totalBudget.toLocaleString()} allocated across channels`,
      });
    } catch (error: unknown) {
      toast({
        title: 'Generation Failed',
        description: (error as Error)?.message || 'Failed to generate budget plan',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateCampaign = async () => {
    if (campaignBudget <= 0) {
      toast({
        title: 'Invalid Budget',
        description: 'Please enter a valid campaign budget',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    try {
      const data = await api.post<CampaignResponse>('/api/campaigns/performance/generate', {
        icp_id: icpId,
        platform: campaignPlatform,
        budget: campaignBudget,
        duration_days: campaignDuration,
        currency,
      });
      setGeneratedCampaign(data.campaign);
      await loadCampaigns();

      toast({
        title: 'Campaign Generated!',
        description: `${campaignPlatform} campaign created with ${data.campaign.ad_sets?.length || 0} ad sets`,
      });
    } catch (error: unknown) {
      toast({
        title: 'Generation Failed',
        description: (error as Error)?.message || 'Failed to generate campaign',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleOptimizeCampaign = async () => {
    if (loading) return;
    const campaign = campaigns.find(item => String(item.id) === selectedCampaignId);
    const errors: typeof metricErrors = {};
    const metrics: Partial<Record<MetricKey, number>> = {};
    if (!campaign) errors.campaign = 'Choose a campaign to optimize.';
    for (const field of metricFields) {
      const value = currentMetrics[field.key].trim();
      if (!value) continue;
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0)
        errors[field.key] = 'Enter a number of zero or more.';
      else if (field.integer && !Number.isSafeInteger(number))
        errors[field.key] = 'Enter a whole number of zero or more.';
      else if (field.max !== undefined && number > field.max)
        errors[field.key] = `Enter a percentage between 0 and ${field.max}.`;
      else metrics[field.key] = number;
    }
    if (!Object.values(currentMetrics).some(value => value.trim())) errors.metrics = 'Enter at least one current metric.';
    setMetricErrors(errors);
    if (Object.keys(errors).length || !campaign) return;

    setLoading(true);
    try {
      const data = await api.post<OptimizationResponse>('/api/campaigns/performance/optimize', {
        campaign_id: campaign.id,
        current_metrics: metrics
      });

      setOptimizationResults(data.optimization);

      toast({
        title: 'Optimization Complete!',
        description: `${data.optimization.recommendations?.length || 0} recommendations generated`,
      });
    } catch (error: unknown) {
      toast({
        title: 'Optimization Failed',
        description: (error as Error)?.message || 'Failed to optimize campaign',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const filteredCampaigns = campaigns.filter(campaign => {
    if (filterPlatform !== 'all' && campaign.platform !== filterPlatform) return false;
    if (filterStatus !== 'all' && campaign.status !== filterStatus) return false;
    return true;
  });

  const formatMoney = (amount: number | undefined, campaignCurrency?: string) => new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: campaignCurrency || currency,
    maximumFractionDigits: 2,
  }).format(amount || 0);

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-[10px] font-black uppercase tracking-widest flex items-center gap-2 text-muted-foreground/60">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          Performance Marketing
        </CardTitle>
        <CardDescription>
          Plan budgets, build campaigns, and optimize performance across platforms
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="flex h-auto w-full flex-wrap gap-1">
            <TabsTrigger value="budget" className="min-h-10 min-w-[8.5rem] flex-1 whitespace-normal">
              <IndianRupee className="h-4 w-4 mr-2" />
              Budget Plan
            </TabsTrigger>
            <TabsTrigger value="campaign" className="min-h-10 min-w-[8.5rem] flex-1 whitespace-normal">
              <Target className="h-4 w-4 mr-2" />
              Campaign Builder
            </TabsTrigger>
            <TabsTrigger value="campaigns" className="min-h-10 min-w-[8.5rem] flex-1 whitespace-normal">
              <BarChart3 className="h-4 w-4 mr-2" />
              Campaigns
            </TabsTrigger>
            <TabsTrigger value="optimize" className="min-h-10 min-w-[8.5rem] flex-1 whitespace-normal">
              <Sparkles className="h-4 w-4 mr-2" />
              Optimize
            </TabsTrigger>
          </TabsList>

          {/* Budget Plan Tab */}
          <TabsContent value="budget" className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="total-budget">Total Budget</Label>
                <Input
                  id="total-budget"
                  type="number"
                  min="0"
                  value={totalBudget}
                  onChange={(e) => setTotalBudget(parseFloat(e.target.value) || 0)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="budget-duration">Duration (days)</Label>
                <Input
                  id="budget-duration"
                  type="number"
                  min="1"
                  max="365"
                  value={budgetDuration}
                  onChange={(e) => setBudgetDuration(parseInt(e.target.value) || 30)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="currency">Currency</Label>
                <Select value={currency} onValueChange={setCurrency}>
                  <SelectTrigger id="currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD ($)</SelectItem>
                    <SelectItem value="EUR">EUR (€)</SelectItem>
                    <SelectItem value="GBP">GBP (£)</SelectItem>
                    <SelectItem value="INR">INR (₹)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button
              onClick={handleGenerateBudgetPlan}
              disabled={loading}
              className="w-full"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <IndianRupee className="mr-2 h-4 w-4" />
                  Generate Budget Plan
                </>
              )}
            </Button>

            {generatedBudgetPlan && (
              <div className="space-y-4">
                {savedPlanDate && (
                  <p className="text-xs text-muted-foreground">
                    Your saved plan from {savedPlanDate}. The chat uses this budget too.
                  </p>
                )}
                <div className="grid gap-4 md:grid-cols-3">
                  <Card>
                    <CardContent className="pt-6">
                      <div className="flex items-center gap-2 mb-2">
                        <IndianRupee className="h-4 w-4 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">Daily Budget</p>
                      </div>
                      <p className="text-2xl font-black tracking-tighter">
                        {currency} {generatedBudgetPlan.daily_budget?.toLocaleString() || 0}
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="pt-6">
                      <div className="flex items-center gap-2 mb-2">
                        <Target className="h-4 w-4 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">Channels</p>
                      </div>
                      <p className="text-2xl font-black tracking-tighter">
                        {generatedBudgetPlan.channel_allocation?.length || 0}
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardContent className="pt-6">
                      <div className="flex items-center gap-2 mb-2">
                        <BarChart3 className="h-4 w-4 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">Expected ROAS</p>
                      </div>
                      <p className="text-2xl font-black tracking-tighter">
                        {generatedBudgetPlan.expected_roas || 'N/A'}
                      </p>
                    </CardContent>
                  </Card>
                </div>

                <div>
                  <h4 className="font-medium mb-3">Channel Allocation</h4>
                  <div className="space-y-3">
                    {generatedBudgetPlan.channel_allocation?.map((channel, idx: number) => (
                      <div key={idx} className="p-3 border rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <p className="font-medium">{channel.channel}</p>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">{channel.percentage}%</Badge>
                            <p className="font-medium">
                              {currency} {channel.budget?.toLocaleString()}
                            </p>
                          </div>
                        </div>
                        <Progress value={channel.percentage} className="h-2 mb-2" />
                        <p className="text-xs text-muted-foreground">{channel.rationale}</p>
                        
                        {channel.expected_metrics && (
                          <div className="grid grid-cols-4 gap-2 mt-2 text-xs">
                            <div>
                              <p className="text-muted-foreground">Impressions</p>
                              <p className="font-medium">{channel.expected_metrics.impressions?.toLocaleString()}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Clicks</p>
                              <p className="font-medium">{channel.expected_metrics.clicks?.toLocaleString()}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Conversions</p>
                              <p className="font-medium">{channel.expected_metrics.conversions?.toLocaleString()}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">CPA</p>
                              <p className="font-medium">{currency} {channel.expected_metrics.cpa}</p>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {generatedBudgetPlan.recommendations && (
                  <div className="p-4 bg-secondary rounded-lg">
                    <h4 className="font-medium mb-2">Recommendations</h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      {generatedBudgetPlan.recommendations.map((rec: string, idx: number) => (
                        <li key={idx}>• {rec}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          {/* Campaign Builder Tab */}
          <TabsContent value="campaign" className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="campaign-platform">Platform</Label>
                <Select value={campaignPlatform} onValueChange={setCampaignPlatform}>
                  <SelectTrigger id="campaign-platform">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="facebook">Meta Ads</SelectItem>
                    <SelectItem value="linkedin">LinkedIn Ads</SelectItem>
                    <SelectItem value="twitter">Twitter Ads</SelectItem>
                    <SelectItem value="google">Google Ads</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="campaign-budget">Budget</Label>
                <Input
                  id="campaign-budget"
                  type="number"
                  min="0"
                  value={campaignBudget}
                  onChange={(e) => setCampaignBudget(parseFloat(e.target.value) || 0)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="campaign-duration">Duration (days)</Label>
                <Input
                  id="campaign-duration"
                  type="number"
                  min="1"
                  max="365"
                  value={campaignDuration}
                  onChange={(e) => setCampaignDuration(parseInt(e.target.value) || 30)}
                />
              </div>
            </div>

            <Button
              onClick={handleGenerateCampaign}
              disabled={loading}
              className="w-full"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Target className="mr-2 h-4 w-4" />
                  Generate Campaign
                </>
              )}
            </Button>

            {generatedCampaign && (
              <ScrollArea className="h-96 rounded-md border p-4">
                <div className="space-y-4">
                  <div>
                    <h4 className="font-medium mb-2">Campaign Overview</h4>
                    <div className="grid gap-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Platform:</span>
                        <span className="font-medium">{generatedCampaign.platform}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Campaign Type:</span>
                        <span className="font-medium">{generatedCampaign.campaign_type}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Budget:</span>
                        <span className="font-medium">{formatMoney(generatedCampaign.budget, generatedCampaign.currency)}</span>
                      </div>
                    </div>
                  </div>

                  {generatedCampaign.targeting && (
                    <div className="p-3 bg-secondary rounded-lg">
                      <h4 className="font-medium mb-2">Targeting</h4>
                      <div className="grid gap-2 text-sm">
                        {generatedCampaign.targeting.locations && (
                          <div>
                            <span className="text-muted-foreground">Locations: </span>
                            {generatedCampaign.targeting.locations.join(', ')}
                          </div>
                        )}
                        {generatedCampaign.targeting.age_range && (
                          <div>
                            <span className="text-muted-foreground">Age: </span>
                            {generatedCampaign.targeting.age_range}
                          </div>
                        )}
                        {generatedCampaign.targeting.interests && (
                          <div>
                            <span className="text-muted-foreground">Interests: </span>
                            {generatedCampaign.targeting.interests.slice(0, 3).join(', ')}
                            {generatedCampaign.targeting.interests.length > 3 && ' ...'}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {generatedCampaign.ad_sets && (
                    <div>
                      <h4 className="font-medium mb-2">Ad Sets ({generatedCampaign.ad_sets.length})</h4>
                      <div className="space-y-3">
                        {generatedCampaign.ad_sets.map((adSet, idx: number) => (
                          <div key={idx} className="p-3 border rounded-lg">
                            <p className="font-medium mb-1">{adSet.ad_set_name}</p>
                            <p className="text-sm text-muted-foreground mb-2">{adSet.strategy}</p>
                            <div className="flex gap-2">
                              <Badge variant="outline">
                                {formatMoney(adSet.budget, generatedCampaign.currency)} budget
                              </Badge>
                              <Badge variant="secondary">
                                {adSet.ads?.length || 0} ads
                              </Badge>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {generatedCampaign.kpis && (
                    <div className="p-3 bg-secondary rounded-lg">
                      <h4 className="font-medium mb-2">Target KPIs</h4>
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div className="flex items-center gap-2">
                          <Eye className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-muted-foreground">Impressions</p>
                            <p className="font-medium">{generatedCampaign.kpis.target_impressions?.toLocaleString()}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <MousePointer className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-muted-foreground">Clicks</p>
                            <p className="font-medium">{generatedCampaign.kpis.target_clicks?.toLocaleString()}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <ShoppingCart className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-muted-foreground">Conversions</p>
                            <p className="font-medium">{generatedCampaign.kpis.target_conversions?.toLocaleString()}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <TrendingUp className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-muted-foreground">ROAS</p>
                            <p className="font-medium">{generatedCampaign.kpis.target_roas}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </ScrollArea>
            )}
          </TabsContent>

          {/* Campaigns List Tab */}
          <TabsContent value="campaigns" className="space-y-4">
            <div className="flex gap-4">
              <Select value={filterPlatform} onValueChange={setFilterPlatform}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="All Platforms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Platforms</SelectItem>
                  <SelectItem value="google">Google</SelectItem>
                  <SelectItem value="meta">Meta</SelectItem>
                  <SelectItem value="linkedin">LinkedIn</SelectItem>
                  <SelectItem value="twitter">Twitter</SelectItem>
                  <SelectItem value="instagram">Instagram</SelectItem>
                </SelectContent>
              </Select>

              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                </SelectContent>
              </Select>

              <Button
                variant="outline"
                size="sm"
                onClick={loadCampaigns}
                className="ml-auto"
              >
                Refresh
              </Button>
            </div>

            <ScrollArea className="h-96 rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Platform</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Budget</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Ad Sets</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCampaigns.length > 0 ? (
                    filteredCampaigns.map((campaign) => (
                      <TableRow key={campaign.id}>
                        <TableCell className="font-medium capitalize">
                          {campaign.platform}
                        </TableCell>
                        <TableCell className="text-sm">
                          {campaign.campaign_type}
                        </TableCell>
                        <TableCell>
                          {formatMoney(campaign.budget, campaign.currency)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              campaign.status === 'active' ? 'default' :
                              campaign.status === 'draft' ? 'secondary' :
                              'outline'
                            }
                          >
                            {campaign.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {campaign.ad_sets?.length || 0}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(campaign.created_at).toLocaleDateString()}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        No campaigns found
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          </TabsContent>

          {/* Optimize Tab */}
          <TabsContent value="optimize" className="space-y-4">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="select-campaign">Select Campaign</Label>
                <Select value={selectedCampaignId} onValueChange={value => {
                  setSelectedCampaignId(value);
                  setMetricErrors(previous => ({ ...previous, campaign: undefined }));
                }}>
                  <SelectTrigger id="select-campaign" aria-invalid={!!metricErrors.campaign} aria-describedby={metricErrors.campaign ? 'optimize-campaign-error' : undefined}>
                    <SelectValue placeholder="Choose a campaign to optimize" />
                  </SelectTrigger>
                  <SelectContent>
                    {campaigns.map((campaign) => (
                      <SelectItem key={campaign.id} value={campaign.id.toString()}>
                        {campaign.platform} - {campaign.campaign_type} ({formatMoney(campaign.budget, campaign.currency)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {metricErrors.campaign && <p id="optimize-campaign-error" role="alert" className="text-sm text-destructive">{metricErrors.campaign}</p>}
              </div>

              <fieldset disabled={loading} className="space-y-3">
                <legend className="text-sm font-medium">Current performance</legend>
                <p className="text-xs text-muted-foreground">Enter the metrics you have for the same reporting period. Leave unavailable metrics blank.</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  {metricFields.map(field => {
                    const id = `optimize-${field.key}`;
                    const campaignCurrency = campaigns.find(item => String(item.id) === selectedCampaignId)?.currency || currency;
                    return <div key={field.key} className="space-y-2">
                      <Label htmlFor={id}>{field.label}{field.money ? ` (${campaignCurrency})` : ''}</Label>
                      <Input id={id} type="number" min="0" max={field.max} step={field.integer ? '1' : 'any'}
                        value={currentMetrics[field.key]} aria-invalid={!!metricErrors[field.key]}
                        aria-describedby={metricErrors[field.key] ? `${id}-error` : undefined}
                        onChange={event => {
                          setCurrentMetrics(previous => ({ ...previous, [field.key]: event.target.value }));
                          setMetricErrors(previous => ({ ...previous, [field.key]: undefined, metrics: undefined }));
                        }} />
                      {metricErrors[field.key] && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{metricErrors[field.key]}</p>}
                    </div>;
                  })}
                </div>
                {metricErrors.metrics && <p role="alert" className="text-sm text-destructive">{metricErrors.metrics}</p>}
              </fieldset>

              <Button
                onClick={handleOptimizeCampaign}
                disabled={loading || !selectedCampaignId}
                className="w-full"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Analyzing...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" />
                    Generate Optimization Recommendations
                  </>
                )}
              </Button>

              {optimizationResults && (
                <ScrollArea className="h-96 rounded-md border p-4">
                  <div className="space-y-4">
                    {optimizationResults.recommendations && (
                      <div>
                        <h4 className="font-medium mb-3">Recommendations</h4>
                        <div className="space-y-2">
                          {optimizationResults.recommendations.map((rec, idx: number) => (
                            <div
                              key={idx}
                              className="p-3 border rounded-lg hover:bg-secondary/50 transition-colors"
                            >
                              <div className="flex items-start justify-between mb-1">
                                <p className="font-medium text-sm">{rec.recommendation}</p>
                                <Badge
                                  variant={
                                    rec.priority === 'high' ? 'destructive' :
                                    rec.priority === 'medium' ? 'default' :
                                    'secondary'
                                  }
                                >
                                  {rec.priority}
                                </Badge>
                              </div>
                              {rec.category && <p className="text-xs text-muted-foreground">{rec.category}</p>}
                              {rec.expected_impact && (
                                <p className="text-xs text-primary mt-1">
                                  Impact: {rec.expected_impact}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {optimizationResults.budget_adjustments && (
                      <div className="p-4 bg-secondary rounded-lg">
                        <h4 className="font-medium mb-2">Budget Adjustments</h4>
                        <ul className="text-sm space-y-1">
                          {optimizationResults.budget_adjustments.map((adj, idx: number) => (
                            <li key={idx} className="text-muted-foreground">
                              <span className="font-medium text-foreground">{adj.channel}:</span>{' '}
                              {formatMoney(adj.current_budget)} → {formatMoney(adj.recommended_budget)} — {adj.reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {optimizationResults.targeting_suggestions && (
                      <div className="p-4 bg-secondary rounded-lg">
                        <h4 className="font-medium mb-2">Targeting Suggestions</h4>
                        <ul className="text-sm space-y-1">
                          {optimizationResults.targeting_suggestions.map((sug: string, idx: number) => (
                            <li key={idx} className="text-muted-foreground">• {sug}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {optimizationResults.creative_insights && (
                      <div className="p-4 bg-secondary rounded-lg">
                        <h4 className="font-medium mb-2">Creative Insights</h4>
                        <ul className="text-sm space-y-1">
                          {optimizationResults.creative_insights.map((insight: string, idx: number) => (
                            <li key={idx} className="text-muted-foreground">• {insight}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </ScrollArea>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
