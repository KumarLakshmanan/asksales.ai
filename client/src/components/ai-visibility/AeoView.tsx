'use client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { aiVisibilityApi, type AeoQuestionCoverage } from '@/lib/ai-visibility';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Evidence } from './SeoView';
import { useDetailFocus } from './use-detail-focus';
import { refreshVisibility, useMeasurement } from './workspace-context';
import { Empty, InlineError, Loading, statusBadge, websiteWorkspacePath } from './workspace-ui';

type Question = {
  id: number;
  question: string;
  intent: string;
  targetPage: string | null;
  active: boolean;
};
export function AeoView({ projectId }: { projectId: number }) {
  const { auditId, can, historical } = useMeasurement();
  const client = useQueryClient();
  const router = useRouter();
  const { toast } = useToast();
  const [form, setForm] = useState<{
    id?: number;
    question: string;
    intent: string;
    targetPage: string;
  } | null>(null);
  const [search, setSearch] = useState(''),
    [status, setStatus] = useState('all');
  const [selectedId, setSelectedId] = useState<number>();
  const [page, setPage] = useState(0);
  const questions = useQuery({
    queryKey: ['ai-visibility-aeo-questions', projectId],
    queryFn: () => aiVisibilityApi.aeoQuestions(projectId),
  });
  const coverage = useQuery({
    queryKey: ['ai-visibility-aeo-coverage', projectId, auditId],
    queryFn: () => aiVisibilityApi.aeoCoverage(projectId, auditId),
  });
  const ideas = useQuery({
    queryKey: ['ai-visibility-prompts', projectId, 'aeo', auditId],
    queryFn: () => aiVisibilityApi.prompts(projectId, 'aeo', auditId),
  });
  const pages = useQuery({
    queryKey: ['ai-visibility-seo', projectId, auditId],
    queryFn: () => aiVisibilityApi.seo(projectId, auditId),
  });
  const refresh = () => refreshVisibility(client, projectId);
  const save = useMutation({
    mutationFn: () =>
      form!.id
        ? aiVisibilityApi.updateAeoQuestion(projectId, form!.id, {
            question: form!.question,
            intent: form!.intent,
            targetPage: form!.targetPage || null,
          })
        : aiVisibilityApi.addAeoQuestion(projectId, {
            question: form!.question,
            intent: form!.intent,
            targetPage: form!.targetPage || undefined,
          }),
    onSuccess: () => {
      setForm(null);
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (question: Question) =>
      aiVisibilityApi.updateAeoQuestion(projectId, question.id, {
        active: !question.active,
      }),
    onSuccess: refresh,
  });
  const asset = useMutation({
    mutationFn: ({
      id,
      type,
    }: {
      id: number;
      type: 'answer_block' | 'faq_page' | 'research_brief';
    }) => aiVisibilityApi.generateAeoAsset(projectId, id, type),
    onSuccess: (result) => {
      refresh();
      router.push(websiteWorkspacePath(projectId, 'assets') + `?contentAsset=${result.asset.id}`);
    },
  });
  const byId = new Map((coverage.data?.coverage || []).map((item) => [item.questionId, item]));
  const filtered = (questions.data?.questions || []).filter(
    (item) =>
      [item.question, item.targetPage, item.intent]
        .join(' ')
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (status === 'all' || byId.get(item.id)?.status === status),
  );
  const selected = questions.data?.questions.find((item) => item.id === selectedId);
  const evidence = selected && byId.get(selected.id);
  const summary = coverage.data?.summary;
  const start = (question?: Question) =>
    setForm(
      question
        ? { ...question, targetPage: question.targetPage || '' }
        : { question: '', intent: 'informational', targetPage: '' },
    );
  const detailRef = useDetailFocus(selectedId);
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        The AEO score measures structural page readiness. Question coverage uses automated term
        matching against the selected crawl. Review each passage to confirm it answers the question;
        it does not prove an AI provider used the answer.{' '}
        {historical && 'You are reviewing an older crawl against current questions.'}
      </p>
      {coverage.isLoading ? (
        <p role="status">Loading question coverage…</p>
      ) : coverage.isError ? (
        <InlineError
          message="Question coverage is unavailable. Tracked questions remain available below."
          onRetry={() => coverage.refetch()}
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-6 border-b pb-4">
            {(['answered', 'partial', 'uncovered'] as const).map((value) => (
              <button
                key={value}
                className="text-left"
                aria-pressed={status === value}
                onClick={() => {
                  setStatus(status === value ? 'all' : value);
                  setPage(0);
                }}
              >
                <strong className="font-mono text-2xl">{summary?.[value] ?? 0}</strong>
                <p className="text-xs capitalize text-muted-foreground">{value}</p>
              </button>
            ))}
          </div>
          {coverage.data?.unavailableReason && (
            <p className="text-sm text-muted-foreground">{coverage.data.unavailableReason}</p>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-3">
        <Input
          className="sm:max-w-sm"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
          placeholder="Search question or target page"
          aria-label="Search tracked questions"
        />
        <label className="text-sm">
          Coverage
          <select
            className="ml-2 rounded border bg-background p-2"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(0);
            }}
          >
            <option value="all">All</option>
            <option value="answered">Answered</option>
            <option value="partial">Partial</option>
            <option value="uncovered">Uncovered</option>
          </select>
        </label>
        {can.edit && (
          <Button size="sm" className="sm:ml-auto" onClick={() => start()}>
            Add question
          </Button>
        )}
      </div>
      {form && (
        <form
          className="space-y-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <h2 className="font-semibold">
            {form.id ? 'Edit tracked question' : 'Track a question'}
          </h2>
          <label className="block text-sm">
            Question
            <Input
              autoFocus
              value={form.question}
              onChange={(event) => setForm({ ...form, question: event.target.value })}
              minLength={5}
              required
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              Intent
              <Input
                value={form.intent}
                list="aeo-intents"
                onChange={(event) => setForm({ ...form, intent: event.target.value })}
                required
              />
              <datalist id="aeo-intents">
                {['informational', 'comparison', 'transactional', 'local', 'evaluation'].map(
                  (value) => (
                    <option key={value} value={value} />
                  ),
                )}
              </datalist>
            </label>
            <label className="block text-sm">
              Target page (optional)
              <Input
                type="url"
                value={form.targetPage}
                list="aeo-target-pages"
                onChange={(event) => setForm({ ...form, targetPage: event.target.value })}
                placeholder="Choose a crawled page or enter URL"
              />
              <datalist id="aeo-target-pages">
                {pages.data?.pages
                  .filter((item) => item.crawlStatus === 'completed')
                  .map((item) => (
                    <option key={item.id} value={item.url}>
                      {item.title}
                    </option>
                  ))}
              </datalist>
            </label>
          </div>
          {pages.isError && (
            <p className="text-xs text-muted-foreground">
              Page suggestions are unavailable; you can enter a target URL.
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={!can.edit || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save question'}
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
          {save.isError && (
            <InlineError message={save.error.message} onRetry={() => save.mutate()} />
          )}
        </form>
      )}
      {questions.isLoading ? (
        <Loading />
      ) : questions.isError ? (
        <InlineError
          message="Tracked questions could not be loaded."
          onRetry={() => questions.refetch()}
        />
      ) : (
        <div className={`grid gap-5 ${selected ? 'lg:grid-cols-[minmax(0,1fr)_360px]' : ''}`}>
          <div className="min-w-0">
            <div className="overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3">Question / target page</th>
                    <th className="p-3">Coverage</th>
                    <th className="p-3">Next action</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.slice(page * 20, (page + 1) * 20).map((item) => {
                    const match = byId.get(item.id);
                    return (
                      <tr key={item.id}>
                        <td className="max-w-lg p-3">
                          <button
                            className="text-left font-medium hover:underline"
                            onClick={() => setSelectedId(item.id)}
                          >
                            {item.question}
                          </button>
                          <p className="mt-1 break-all text-xs text-muted-foreground">
                            {item.intent} · {item.targetPage || 'Any matching page'}
                            {!item.active && ' · Inactive'}
                          </p>
                        </td>
                        <td className="p-3">
                          {coverage.isError
                            ? 'Unavailable'
                            : match
                              ? statusBadge(match.status)
                              : 'Not measured'}
                        </td>
                        <td className="min-w-40 p-3">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSelectedId(item.id)}
                          >
                            {match?.bestMatch?.answerExcerpt ? 'Review answer' : 'Plan content'}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <Empty
                message={
                  questions.data?.questions.length
                    ? 'No questions match these filters.'
                    : 'No questions tracked yet. Add one or choose a generated idea below.'
                }
              />
            )}
            <div className="mt-4 flex items-center justify-between text-xs">
              <span>{filtered.length} matching questions</span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page === 0}
                  onClick={() => setPage((value) => value - 1)}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={(page + 1) * 20 >= filtered.length}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
          {selected && (
            <aside
              ref={detailRef}
              tabIndex={-1}
              aria-label="Question evidence and actions"
              className="min-w-0 rounded-lg border bg-muted/20 p-4 lg:sticky lg:top-4 lg:max-h-[80vh] lg:self-start lg:overflow-auto"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold">{selected.question}</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedId(undefined)}
                  aria-label="Close question evidence"
                >
                  ×
                </Button>
              </div>
              {coverage.isError ? (
                <InlineError
                  message="Answer evidence is unavailable."
                  onRetry={() => coverage.refetch()}
                />
              ) : (
                <QuestionEvidence evidence={evidence} />
              )}
              {can.edit && (
                <div className="mt-4 space-y-3">
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => start(selected)}>
                      Edit question
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate(selected)}
                    >
                      {selected.active ? 'Pause tracking' : 'Enable tracking'}
                    </Button>
                  </div>
                  {!historical &&
                    !coverage.isError &&
                    (evidence?.bestMatch?.answerExcerpt ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          disabled={asset.isPending}
                          onClick={() =>
                            asset.mutate({
                              id: selected.id,
                              type: 'answer_block',
                            })
                          }
                        >
                          Draft answer block
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={asset.isPending}
                          onClick={() => asset.mutate({ id: selected.id, type: 'faq_page' })}
                        >
                          Draft FAQ schema
                        </Button>
                      </div>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground">
                          No verified answer passage is available. A research brief lists the
                          evidence and work needed to author an answer.
                        </p>
                        <Button
                          size="sm"
                          disabled={asset.isPending}
                          onClick={() =>
                            asset.mutate({
                              id: selected.id,
                              type: 'research_brief',
                            })
                          }
                        >
                          Create research brief
                        </Button>
                      </>
                    ))}
                </div>
              )}
              {historical && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Select the latest measurement to generate a draft from current evidence.
                </p>
              )}
              {asset.isError && <InlineError message={asset.error.message} />}
              {toggle.isError && <InlineError message={toggle.error.message} />}
              {asset.isSuccess && (
                <p className="mt-3 text-sm">
                  <Link
                    className="text-primary underline"
                    href={websiteWorkspacePath(projectId, 'assets')}
                  >
                    Open generated assets
                  </Link>
                </p>
              )}
            </aside>
          )}
        </div>
      )}
      <details className="border-t pt-4">
        <summary className="cursor-pointer text-sm font-medium">Generated question ideas</summary>
        <div className="mt-3">
          {ideas.isLoading ? (
            <p role="status">Loading ideas…</p>
          ) : ideas.isError ? (
            <InlineError
              message="Generated ideas could not be loaded."
              onRetry={() => ideas.refetch()}
            />
          ) : ideas.data?.prompts.length ? (
            <div className="divide-y">
              {ideas.data.prompts.map((prompt) => (
                <div
                  key={prompt.id}
                  className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm">{prompt.prompt}</p>
                    <p className="text-xs text-muted-foreground">
                      {prompt.intent} · {prompt.locale}
                    </p>
                  </div>
                  {can.edit && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setForm({
                          question: prompt.prompt,
                          intent: prompt.intent,
                          targetPage: '',
                        })
                      }
                    >
                      Track question
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <Empty message="A completed analysis generates question ideas based on this business." />
          )}
        </div>
      </details>
    </div>
  );
}
function QuestionEvidence({ evidence }: { evidence?: AeoQuestionCoverage }) {
  if (!evidence)
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        No coverage measurement is available for this question.
      </p>
    );
  return (
    <div className="mt-3 space-y-3">
      {statusBadge(evidence.status)}
      {evidence.bestMatch ? (
        <>
          <Evidence
            value={{
              source: evidence.bestMatch.url,
              match: `${Math.round(evidence.bestMatch.score * 100)}%`,
              answerExcerpt: evidence.bestMatch.answerExcerpt,
              signals: evidence.bestMatch.signals,
            }}
          />
          {evidence.matches.length > 1 && (
            <details>
              <summary className="cursor-pointer text-sm">Other matching pages</summary>
              <Evidence
                value={evidence.matches.slice(1).map((item) => ({
                  source: item.url,
                  answerExcerpt: item.answerExcerpt,
                }))}
              />
            </details>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No verified answer was found in this crawl.</p>
      )}
    </div>
  );
}
