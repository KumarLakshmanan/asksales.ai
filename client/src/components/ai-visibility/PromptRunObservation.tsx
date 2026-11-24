'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { aiVisibilityApi, type ProviderPromptRun } from '@/lib/ai-visibility';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { SafeMarkdown } from './SafeMarkdown';
import { refreshVisibility, useMeasurement } from './workspace-context';
import { safeCitationUrl, statusBadge } from './workspace-ui';
export function PromptRunObservation({
  projectId,
  run,
}: {
  projectId: number;
  run: ProviderPromptRun;
}) {
  const { auditId, can, historical } = useMeasurement();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [brandMentioned, setBrandMentioned] = useState(Boolean(run.brandMentioned));
  const [brandRank, setBrandRank] = useState(run.brandRank ? String(run.brandRank) : '');
  const [sentiment, setSentiment] = useState(run.sentiment || 'neutral');
  const [competitors, setCompetitors] = useState((run.competitors || []).join(', '));
  const [reason, setReason] = useState(run.recommendationReason || run.exclusionReason || '');
  const citations = Array.isArray(run.citations) ? run.citations : [];
  const answer = run.answer || '';
  const answerPreview = answer.length > 420 ? `${answer.slice(0, 420).trimEnd()}…` : answer;
  const correction = useMutation({
    mutationFn: () =>
      aiVisibilityApi.correctPromptRun(run.id, {
        brandMentioned,
        brandRank: brandMentioned && brandRank ? Number(brandRank) : null,
        sentiment: sentiment as 'positive' | 'neutral' | 'negative',
        competitors: competitors
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        recommendationReason: brandMentioned ? reason.trim() || null : null,
        exclusionReason: brandMentioned ? null : reason.trim() || null,
      }),
    onSuccess: () => {
      void refreshVisibility(queryClient, projectId);
      setEditing(false);
      queryClient.invalidateQueries({
        queryKey: ['ai-visibility-prompts', projectId, 'geo'],
      });
      toast({
        title: 'Extraction correction saved',
        description:
          'The correction is visible now and will be reused for the same provider and normalized prompt.',
      });
    },
    onError: (error) =>
      toast({
        title: 'Could not save correction',
        description: error instanceof Error ? error.message : '',
        variant: 'destructive',
      }),
  });

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{run.provider}</Badge>
        <Badge variant="outline">API observation</Badge>
        {run.cachedFromRunId ? <Badge variant="secondary">same-day cache</Badge> : null}
        {statusBadge(run.status)}
        {run.extractionStatus === 'failed' && (
          <Badge variant="destructive">Derived metrics unavailable</Badge>
        )}
        {run.extractionStatus === 'corrected' && (
          <Badge variant="secondary">Manually corrected</Badge>
        )}
        {run.brandMentioned === true && (
          <Badge variant="secondary">
            Brand mentioned{run.brandRank ? ` #${run.brandRank}` : ''}
          </Badge>
        )}
      </div>
      {run.error ? (
        <p className="mt-2 text-sm text-destructive">{run.error}</p>
      ) : (
        <>
          <div className="mt-2">
            <SafeMarkdown>{answerPreview || 'No answer text returned.'}</SafeMarkdown>
          </div>
          {answer.length > 420 && (
            <details className="mt-3 rounded-md border bg-background">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                Read full provider answer
              </summary>
              <div className="max-h-96 overflow-auto border-t p-3">
                <SafeMarkdown>{answer}</SafeMarkdown>
              </div>
            </details>
          )}
        </>
      )}
      <div className="mt-2 text-xs text-muted-foreground">
        {citations.length} citations · observation model {run.model}
        {run.extractionModel
          ? ` · extracted by ${run.extractionProvider}/${run.extractionModel}`
          : ''}
      </div>
      {run.extractionStatus === 'failed' && (
        <p className="mt-2 text-xs text-destructive">
          The raw answer is preserved, but brand rank, sentiment, and competitor metrics were not
          scored because structured extraction failed.
          {run.extractionError ? ` ${run.extractionError}` : ''}
        </p>
      )}
      {citations.length > 0 && (
        <details className="mt-3 rounded-md bg-muted/60 p-3">
          <summary className="cursor-pointer text-sm font-medium">View citation sources</summary>
          <ol className="mt-2 space-y-2 pl-5 text-sm">
            {citations.map((citation, index) => {
              const href = safeCitationUrl(citation.url);
              return (
                <li key={`${citation.url}-${index}`} className="break-words">
                  {href ? (
                    <a
                      className="text-primary underline-offset-4 hover:underline"
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {citation.title || citation.url}
                    </a>
                  ) : (
                    <span>{citation.title || citation.url}</span>
                  )}
                  <div className="text-xs text-muted-foreground">{citation.url}</div>
                </li>
              );
            })}
          </ol>
        </details>
      )}
      {can.edit && run.status === 'completed' && (
        <div className="mt-3 border-t pt-3">
          {editing ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor={`brand-mentioned-${run.id}`}>Brand mentioned</Label>
                <Switch
                  id={`brand-mentioned-${run.id}`}
                  checked={brandMentioned}
                  onCheckedChange={setBrandMentioned}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`brand-rank-${run.id}`}>Brand rank</Label>
                  <Input
                    id={`brand-rank-${run.id}`}
                    type="number"
                    min="1"
                    disabled={!brandMentioned}
                    value={brandRank}
                    onChange={(event) => setBrandRank(event.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Sentiment</Label>
                  <Select value={sentiment} onValueChange={setSentiment}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="positive">Positive</SelectItem>
                      <SelectItem value="neutral">Neutral</SelectItem>
                      <SelectItem value="negative">Negative</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`competitors-${run.id}`}>Competitors (comma-separated)</Label>
                <Input
                  id={`competitors-${run.id}`}
                  value={competitors}
                  onChange={(event) => setCompetitors(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`reason-${run.id}`}>
                  {brandMentioned ? 'Recommendation reason' : 'Exclusion reason'}
                </Label>
                <Input
                  id={`reason-${run.id}`}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  loading={correction.isPending}
                  disabled={Boolean(brandMentioned && brandRank !== '' && Number(brandRank) < 1)}
                  onClick={() => correction.mutate()}
                >
                  Save correction
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" size="sm" className="px-0" onClick={() => setEditing(true)}>
              Correct extracted fields
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
