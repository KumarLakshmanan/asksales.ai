import { Badge } from '@/components/ui/badge';
import { campaignEvidenceState, type PresentedCampaign } from '@/lib/performancePresentation';

export function CampaignEvidenceBadge({ campaign }: { campaign: PresentedCampaign }) {
  const state = campaignEvidenceState(campaign);
  const color = state.tone === 'critical' ? 'border-destructive/30 text-destructive' : state.tone === 'warning' ? 'border-amber-500/30 text-amber-700 dark:text-amber-300' : state.tone === 'positive' ? 'border-emerald-500/30 text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground';
  return <Badge variant="outline" title={state.reason} className={color}>{state.label}</Badge>;
}
