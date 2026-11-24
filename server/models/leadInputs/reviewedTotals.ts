type ReviewedLeadInput = {
  platform: string;
  workflowId?: string | null;
  schema?: unknown;
};

export function buildReviewedLeadTotals(inputs: ReviewedLeadInput[]): Map<string, number> {
  const reviewedTotals = new Map<string, number>();
  for (const input of inputs) {
    const schema = input.schema && typeof input.schema === 'object'
      ? input.schema as Record<string, unknown>
      : null;
    const total = Number(schema?.requestedLeadTotal);
    if (!Number.isSafeInteger(total) || total <= 0) continue;
    for (const key of [input.platform, input.workflowId]) {
      if (key && !reviewedTotals.has(key)) reviewedTotals.set(key, total);
    }
  }
  return reviewedTotals;
}

export function resolveReviewedLeadTotal(
  input: ReviewedLeadInput,
  reviewedTotals: Map<string, number>,
): number | undefined {
  const schema = input.schema && typeof input.schema === 'object'
    ? input.schema as Record<string, unknown>
    : null;
  const direct = Number(schema?.requestedLeadTotal);
  if (Number.isSafeInteger(direct) && direct > 0) return direct;
  return reviewedTotals.get(input.workflowId || '')
    || reviewedTotals.get(input.platform)
    || undefined;
}
