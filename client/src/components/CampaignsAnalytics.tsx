import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Target, IndianRupee, Eye, MousePointerClick, BarChart3, Activity, Users, Send } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar } from 'recharts';

interface MetaCampaign {
  id: string;
  name: string;
  status?: string;
  effective_status?: string;
  objective?: string;
  insights?: {
    impressions?: string;
    clicks?: string;
    spend?: string;
    reach?: string;
    cpc?: string;
    cpm?: string;
    ctr?: string;
  };
}

interface CampaignMetrics {
  totalLeads: number;
  totalOutreach: number;
  totalAdSets: number;
  publishedAds: number;
  avgIcpScore: number;
  conversionRate: number;
}

interface CampaignsAnalyticsProps {
  metrics?: CampaignMetrics;
  campaigns?: MetaCampaign[];
}

export default function CampaignsAnalytics({ metrics, campaigns = [] }: CampaignsAnalyticsProps) {
  const defaultMetrics: CampaignMetrics = metrics || {
    totalLeads: 0,
    totalOutreach: 0,
    totalAdSets: 0,
    publishedAds: 0,
    avgIcpScore: 0,
    conversionRate: 0,
  };

  // Compute totals from real campaign data
  const totals = useMemo(() => {
    return campaigns.reduce(
      (acc, c) => ({
        spend: acc.spend + parseFloat(c.insights?.spend || '0'),
        impressions: acc.impressions + parseInt(c.insights?.impressions || '0'),
        clicks: acc.clicks + parseInt(c.insights?.clicks || '0'),
        reach: acc.reach + parseInt(c.insights?.reach || '0'),
      }),
      { spend: 0, impressions: 0, clicks: 0, reach: 0 }
    );
  }, [campaigns]);

  const avgCtr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : defaultMetrics.conversionRate;
  const avgCpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
  const avgCpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0;

  const formatCurrency = (v: number) => v >= 1000 ? `₹${(v / 1000).toFixed(1)}K` : `₹${v.toFixed(2)}`;
  const formatNumber = (v: number) => v >= 1000000 ? `${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(1)}K` : v.toString();

  // Spend by campaign (bar chart data)
  const spendByCampaign = useMemo(() => {
    return campaigns
      .map(c => ({
        name: c.name.length > 20 ? c.name.slice(0, 20) + '…' : c.name,
        spend: parseFloat(c.insights?.spend || '0'),
        clicks: parseInt(c.insights?.clicks || '0'),
      }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 6);
  }, [campaigns]);

  // Objective distribution (pie chart data)
  const objectiveDistribution = useMemo(() => {
    const objMap = campaigns.reduce((acc, c) => {
      const obj = (c.objective || 'UNKNOWN').replace(/_/g, ' ');
      acc[obj] = (acc[obj] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const colors = ['#6c244c', '#8b5cf6', '#06b6d4', '#f59e0b', '#10b981', '#ef4444'];
    return Object.entries(objMap).map(([name, value], i) => ({
      name: name.charAt(0) + name.slice(1).toLowerCase(),
      value,
      color: colors[i % colors.length],
    }));
  }, [campaigns]);

  // Status distribution
  const statusDistribution = useMemo(() => {
    const statusMap = campaigns.reduce((acc, c) => {
      const s = c.effective_status?.toLowerCase() || 'unknown';
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const colors: Record<string, string> = { active: '#22c55e', paused: '#f59e0b', archived: '#6b7280', unknown: '#94a3b8' };
    return Object.entries(statusMap).map(([name, value]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      value,
      color: colors[name] || '#94a3b8',
    }));
  }, [campaigns]);

  // Per-campaign performance data for trend visualization
  const campaignPerformance = useMemo(() => {
    return campaigns
      .filter(c => c.insights)
      .map(c => ({
        name: c.name.length > 15 ? c.name.slice(0, 15) + '…' : c.name,
        impressions: parseInt(c.insights?.impressions || '0'),
        clicks: parseInt(c.insights?.clicks || '0'),
        spend: parseFloat(c.insights?.spend || '0'),
        ctr: parseFloat(c.insights?.ctr || '0'),
      }))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 7);
  }, [campaigns]);

  const hasRealData = campaigns.length > 0;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold mb-1">Campaign Analytics</h2>
          <p className="text-sm text-muted-foreground">
            {hasRealData ? `Real-time metrics from ${campaigns.length} campaign${campaigns.length !== 1 ? 's' : ''}` : 'Detailed performance metrics and insights'}
          </p>
        </div>
      </div>

      {/* Key Metrics - Real Data */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Card className="p-4 bg-gradient-to-br from-primary/10 to-primary/5 rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <Eye className="w-4 h-4 text-primary" />
            <span className="text-xs text-muted-foreground">Impressions</span>
          </div>
          <p className="text-2xl font-bold text-primary">{formatNumber(totals.impressions)}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Reach: {formatNumber(totals.reach)}
          </p>
        </Card>
        <Card className="p-4 bg-gradient-to-br from-purple-100 to-purple-50 dark:from-purple-950/30 dark:to-purple-900/10 rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <MousePointerClick className="w-4 h-4 text-purple-600" />
            <span className="text-xs text-muted-foreground">Clicks</span>
          </div>
          <p className="text-2xl font-black tracking-tighter text-purple-600">{formatNumber(totals.clicks)}</p>
          <p className="text-xs text-muted-foreground mt-1">
            CTR: {avgCtr.toFixed(2)}%
          </p>
        </Card>
        <Card className="p-4 bg-gradient-to-br from-green-100 to-green-50 dark:from-green-950/30 dark:to-green-900/10 rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <IndianRupee className="w-4 h-4 text-green-600" />
            <span className="text-xs text-muted-foreground">Avg. CPC</span>
          </div>
          <p className="text-2xl font-black tracking-tighter text-green-600">{formatCurrency(avgCpc)}</p>
          <p className="text-xs text-muted-foreground mt-1">
            CPM: {formatCurrency(avgCpm)}
          </p>
        </Card>
        <Card className="p-4 bg-gradient-to-br from-amber-100 to-amber-50 dark:from-amber-950/30 dark:to-amber-900/10 rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <Target className="w-4 h-4 text-amber-600" />
            <span className="text-xs text-muted-foreground">Total Spend</span>
          </div>
          <p className="text-2xl font-black tracking-tighter text-amber-600">{formatCurrency(totals.spend)}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {defaultMetrics.totalAdSets} ad sets
          </p>
        </Card>
        <Card className="p-4 bg-gradient-to-br from-blue-100 to-blue-50 dark:from-blue-950/30 dark:to-blue-900/10 rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <Users className="w-4 h-4 text-blue-600" />
            <span className="text-xs text-muted-foreground">Leads</span>
          </div>
          <p className="text-2xl font-black tracking-tighter text-blue-600">{defaultMetrics.totalLeads.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {defaultMetrics.avgIcpScore > 0 ? `ICP Score: ${defaultMetrics.avgIcpScore}%` : 'From lead generation'}
          </p>
        </Card>
        <Card className="p-4 bg-gradient-to-br from-rose-100 to-rose-50 dark:from-rose-950/30 dark:to-rose-900/10 rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <Send className="w-4 h-4 text-rose-600" />
            <span className="text-xs text-muted-foreground">Outreach</span>
          </div>
          <p className="text-2xl font-black tracking-tighter text-rose-600">{defaultMetrics.totalOutreach.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Messages sent
          </p>
        </Card>
      </div>

      {/* Performance by Campaign Chart */}
      {campaignPerformance.length > 0 && (
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Performance by Campaign</h3>
            <Badge variant="secondary" className="text-xs"><BarChart3 className="w-3 h-3 mr-1" /> Impressions &amp; Clicks</Badge>
          </div>
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={campaignPerformance}>
              <defs>
                <linearGradient id="colorImpressionsReal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorClicksReal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="name" className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
              <YAxis className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))" }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--background))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
              />
              <Area type="monotone" dataKey="impressions" stroke="hsl(var(--primary))" fillOpacity={1} fill="url(#colorImpressionsReal)" name="Impressions" strokeWidth={2} />
              <Area type="monotone" dataKey="clicks" stroke="#8b5cf6" fillOpacity={1} fill="url(#colorClicksReal)" name="Clicks" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Objective Distribution */}
        <Card className="p-6">
          <h3 className="text-lg font-semibold mb-4">Objective Distribution</h3>
          {objectiveDistribution.length > 0 ? (
            <div className="flex items-center gap-6">
              <div className="w-40 h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={objectiveDistribution} cx="50%" cy="50%" innerRadius={40} outerRadius={60} paddingAngle={5} dataKey="value">
                      {objectiveDistribution.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-3 flex-1">
                {objectiveDistribution.map((obj) => (
                  <div key={obj.name} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: obj.color }} />
                      <span className="text-sm">{obj.name}</span>
                    </div>
                    <span className="text-sm font-semibold">{obj.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">No campaign data available</p>
          )}
        </Card>

        {/* Status Distribution */}
        <Card className="p-6">
          <h3 className="text-lg font-semibold mb-4">Status Distribution</h3>
          {statusDistribution.length > 0 ? (
            <div className="flex items-center gap-6">
              <div className="w-40 h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={statusDistribution} cx="50%" cy="50%" innerRadius={40} outerRadius={60} paddingAngle={5} dataKey="value">
                      {statusDistribution.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-3 flex-1">
                {statusDistribution.map((status) => (
                  <div key={status.name} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: status.color }} />
                      <span className="text-sm">{status.name}</span>
                    </div>
                    <span className="text-sm font-semibold">{status.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">No campaign data available</p>
          )}
        </Card>
      </div>

      {/* Spend by Campaign Bar Chart */}
      {spendByCampaign.length > 0 && (
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Spend by Campaign</h3>
            <Badge variant="secondary" className="text-xs"><Activity className="w-3 h-3 mr-1" /> Top {spendByCampaign.length}</Badge>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={spendByCampaign} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
              <XAxis type="number" className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))" }} />
              <YAxis dataKey="name" type="category" width={130} className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "hsl(var(--background))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                }}
                formatter={(value) => [`₹${Number(value ?? 0).toFixed(2)}`, 'Spend']}
              />
              <Bar dataKey="spend" fill="#6c244c" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Campaign Funnel & Ad Sets */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="p-6">
          <h3 className="text-lg font-semibold mb-4">Campaign Funnel</h3>
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Impressions</span>
                <span className="font-semibold">{formatNumber(totals.impressions)}</span>
              </div>
              <div className="h-2 bg-gradient-to-r from-primary to-[hsl(var(--accent))] rounded-full" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Reach</span>
                <span className="font-semibold">{formatNumber(totals.reach)}</span>
              </div>
              <div
                className="h-2 bg-gradient-to-r from-purple-500 to-violet-500 rounded-full"
                style={{ width: totals.impressions > 0 ? `${Math.min(100, (totals.reach / totals.impressions) * 100)}%` : '0%' }}
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Clicks</span>
                <span className="font-semibold">{formatNumber(totals.clicks)}</span>
              </div>
              <div
                className="h-2 bg-gradient-to-r from-amber-500 to-orange-500 rounded-full"
                style={{ width: totals.impressions > 0 ? `${Math.min(100, (totals.clicks / totals.impressions) * 100 * 10)}%` : '0%' }}
              />
            </div>
          </div>
        </Card>

        {/* Top Campaigns by Spend */}
        <Card className="p-6">
          <h3 className="text-lg font-semibold mb-4">Top Campaigns by Spend</h3>
          <div className="space-y-3">
            {campaigns
              .sort((a, b) => parseFloat(b.insights?.spend || '0') - parseFloat(a.insights?.spend || '0'))
              .slice(0, 4)
              .map((c, i) => {
                const spend = parseFloat(c.insights?.spend || '0');
                const maxSpend = parseFloat(campaigns[0]?.insights?.spend || '1') || 1;
                return (
                  <div key={c.id} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground truncate max-w-[200px]">{c.name}</span>
                      <span className="font-semibold">{formatCurrency(spend)}</span>
                    </div>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${i === 0 ? 'bg-gradient-to-r from-[#6c244c] to-[#a855f7]' : i === 1 ? 'bg-purple-400' : i === 2 ? 'bg-cyan-400' : 'bg-amber-400'}`}
                        style={{ width: `${(spend / maxSpend) * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            {campaigns.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No campaign data available</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
