import { useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { ArrowUpDown, Download } from 'lucide-react';

interface CampaignRow {
  id: number;
  threadTitle: string;
  icpScore: number;
  leadsCount: number;
  outreachCount: number;
  adSetsCount: number;
  publishedAdsCount: number;
  status: 'active' | 'completed' | 'draft';
  createdAt: string;
}

interface CampaignsListViewProps {
  campaigns?: CampaignRow[];
}

export default function CampaignsListView({ campaigns = [] }: CampaignsListViewProps) {
  const [sortBy, setSortBy] = useState<keyof CampaignRow>('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const handleSort = (column: keyof CampaignRow) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('desc');
    }
  };

  const sortedCampaigns = [...campaigns].sort((a, b) => {
    const aVal = a[sortBy];
    const bVal = b[sortBy];

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortOrder === 'asc'
        ? aVal.localeCompare(bVal)
        : bVal.localeCompare(aVal);
    }

    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
    }

    return 0;
  });


  const handleExport = () => {
    // Export to CSV
    const headers = ['Thread', 'ICP Score', 'Leads', 'Outreach', 'Ad Sets', 'Published', 'Status', 'Created'];
    const rows = sortedCampaigns.map(c => [
      c.threadTitle,
      c.icpScore,
      c.leadsCount,
      c.outreachCount,
      c.adSetsCount,
      c.publishedAdsCount,
      c.status,
      new Date(c.createdAt).toLocaleDateString()
    ]);

    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'campaigns.csv';
    a.click();
  };

  return (
    <div className="p-5 space-y-4 bg-background/50 h-full overflow-auto">
      <div className="flex items-center justify-between px-1">
        <div className="space-y-0.5">
          <h2 className="text-xl font-black text-foreground uppercase tracking-tight leading-none">All Campaigns</h2>
          <p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60">
            {sortedCampaigns.length} campaign{sortedCampaigns.length !== 1 ? 's' : ''} total
          </p>
        </div>
        <Button
          onClick={handleExport}
          variant="outline"
          size="sm"
          className="h-8 text-[9px] font-black uppercase tracking-widest px-4 rounded-lg border-border/40 hover:bg-muted active:scale-95 transition-all"
        >
          <Download className="w-3.5 h-3.5 mr-2" />
          Export CSV
        </Button>
      </div>

      <Card className="rounded-xl border border-border/40 bg-card/30 backdrop-blur-xl shadow-sm overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSort('threadTitle')}
                  className="h-7 text-[9px] font-black uppercase tracking-widest hover:bg-transparent"
                >
                  Thread
                  <ArrowUpDown className="ml-1.5 h-2.5 w-2.5 opacity-50" />
                </Button>
              </TableHead>
              <TableHead>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSort('icpScore')}
                  className="h-8 font-semibold"
                >
                  ICP Score
                  <ArrowUpDown className="ml-2 h-3 w-3" />
                </Button>
              </TableHead>
              <TableHead>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSort('leadsCount')}
                  className="h-8 font-semibold"
                >
                  Leads
                  <ArrowUpDown className="ml-2 h-3 w-3" />
                </Button>
              </TableHead>
              <TableHead>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSort('outreachCount')}
                  className="h-8 font-semibold"
                >
                  Outreach
                  <ArrowUpDown className="ml-2 h-3 w-3" />
                </Button>
              </TableHead>
              <TableHead>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSort('adSetsCount')}
                  className="h-8 font-semibold"
                >
                  Ad Sets
                  <ArrowUpDown className="ml-2 h-3 w-3" />
                </Button>
              </TableHead>
              <TableHead>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSort('publishedAdsCount')}
                  className="h-8 font-semibold"
                >
                  Published
                  <ArrowUpDown className="ml-2 h-3 w-3" />
                </Button>
              </TableHead>
              <TableHead>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSort('status')}
                  className="h-8 font-semibold"
                >
                  Status
                  <ArrowUpDown className="ml-2 h-3 w-3" />
                </Button>
              </TableHead>
              <TableHead>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSort('createdAt')}
                  className="h-8 font-semibold"
                >
                  Created
                  <ArrowUpDown className="ml-2 h-3 w-3" />
                </Button>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedCampaigns.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                  No campaigns found
                </TableCell>
              </TableRow>
            ) : (
              sortedCampaigns.map((campaign) => (
                <TableRow key={campaign.id} className="hover:bg-muted/30 cursor-pointer transition-colors border-b border-border/40 last:border-0">
                  <TableCell className="py-2.5 text-xs font-bold text-foreground truncate max-w-[200px]">{campaign.threadTitle}</TableCell>
                  <TableCell className="py-2.5">
                    <Badge variant="outline" className="h-4.5 text-[8px] px-1.5 uppercase font-black tracking-widest bg-green-500/10 text-green-500 border-none">
                      {campaign.icpScore}% Score
                    </Badge>
                  </TableCell>
                  <TableCell className="py-2.5 text-xs font-bold">{campaign.leadsCount.toLocaleString()}</TableCell>
                  <TableCell className="py-2.5 text-xs font-bold">{campaign.outreachCount.toLocaleString()}</TableCell>
                  <TableCell className="py-2.5 text-xs font-bold">{campaign.adSetsCount.toLocaleString()}</TableCell>
                  <TableCell className="py-2.5 text-xs font-bold">{campaign.publishedAdsCount.toLocaleString()}</TableCell>
                  <TableCell className="py-2.5">
                    <StatusBadge status={campaign.status} toneOverrides={{ completed: 'info' }} />
                  </TableCell>
                  <TableCell className="py-2.5 text-[10px] font-medium text-muted-foreground/60">
                    {new Date(campaign.createdAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
