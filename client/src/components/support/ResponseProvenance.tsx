"use client";

type Provenance = {
  assistant?: { assistantId?: string; name?: string; revision?: number; configurationMode?: 'draft' | 'published' };
  traceId?: string; turnId?: string;
  generationStatus?: string; deliveryStatus?: string;
  stages?: Array<{ stage: string; status: string; durationMs: number }>;
  tools?: Array<string | { name?: string; toolName?: string; status?: string }>;
  playbook?: string | { name?: string; id?: number | string; version?: number; node?: string };
  node?: string;
  media?: Array<{ title?: string; name?: string; id?: number | string }>;
  verification?: string | { status?: string; reason?: string; grounding?: string; mayDeliver?: boolean };
  handoffReason?: string;
  knowledgeStatus?: string;
};

export function ResponseProvenance({ provenance }: { provenance?: Provenance | null }) {
  if (!provenance) return null;
  const tools = (provenance.tools || []).map((tool) => typeof tool === "string" ? tool : `${tool.name || tool.toolName || "Tool"}${tool.status ? ` (${tool.status})` : ""}`);
  const playbook = typeof provenance.playbook === "string" ? provenance.playbook : provenance.playbook && `${provenance.playbook.name || `Playbook ${provenance.playbook.id}`}${provenance.playbook.version ? ` · v${provenance.playbook.version}` : ""}`;
  const verification = typeof provenance.verification === "string" ? provenance.verification : provenance.verification && [provenance.verification.status || provenance.verification.grounding, provenance.verification.mayDeliver === false ? "Delivery blocked" : null, provenance.verification.reason].filter(Boolean).join(" · ");
  const rows = [
    ["Assistant", provenance.assistant?.assistantId && `${provenance.assistant.name || provenance.assistant.assistantId} · ${provenance.assistant.revision === 0 || provenance.assistant.configurationMode === 'draft' ? 'Draft' : `Published r${provenance.assistant.revision ?? '?'}`}`],
    ["Response", provenance.generationStatus], ["Delivery", provenance.deliveryStatus?.replaceAll("_", " ")],
    ["Trace", provenance.traceId],
    ["Stages", provenance.stages?.map(stage => `${stage.stage}: ${stage.status} (${stage.durationMs} ms)`).join(" · ")],
    ["Knowledge", provenance.knowledgeStatus?.replaceAll("_", " ")],
    ["Tools", tools.join(", ")], ["Playbook", playbook], ["Step", provenance.node || (typeof provenance.playbook === "object" ? provenance.playbook?.node : null)],
    ["Media", provenance.media?.map((item) => item.title || item.name || `Asset ${item.id}`).join(", ")],
    ["Verification", verification], ["Handoff", provenance.handoffReason],
  ].filter(([, value]) => Boolean(value));
  if (!rows.length) return null;
  return <details className="mt-3 rounded-lg border border-border/60 text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer px-3 py-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">How this answer was produced</summary><dl className="space-y-2 border-t border-border/60 px-3 py-2">{rows.map(([label, value]) => <div key={label} className="grid gap-1 sm:grid-cols-[6rem_minmax(0,1fr)]"><dt className="font-medium text-foreground">{label}</dt><dd className="min-w-0 break-words">{value}</dd></div>)}</dl></details>;
}
