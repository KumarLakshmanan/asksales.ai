"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, GitBranch, Workflow } from "lucide-react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import { supportApi } from "@/lib/support-api";
import { useToast } from "@/hooks/use-toast";
import { orderedPlaybookNodes } from "@/lib/support-playbook-ui";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import type { PlaybookGraph } from "@/components/support/PlaybookGraphEditor";

type Assignment = { id: number; channel: string | null; intent: string | null; priority: number };
type Playbook = { id: number; name: string; description: string | null; agentType: string; activeVersion: number; graph: PlaybookGraph; assignments: Assignment[] };

export default function SupportMemberPlaybooksPage() {
  const router = useRouter();
  const { member, isLoading: authLoading } = useSupportAuth();
  const { toast } = useToast();
  const [items, setItems] = useState<Playbook[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try { setItems((await supportApi.get<{ playbooks: Playbook[] }>("/api/support-portal/playbooks")).playbooks || []); }
    catch (error) { setLoadError(error instanceof Error ? error.message : "Playbooks could not be loaded."); toast({ title: "Playbooks unavailable", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" }); }
    finally { setLoading(false); }
  }, [toast]);
  useEffect(() => {
    if (!authLoading && !member) { router.push("/support/login"); return; }
    if (member) void load();
  }, [authLoading, load, member, router]);
  if (authLoading || loading) return <LoadingState className="min-h-72" label="Loading playbooks…" />;
  if (!member) return null;
  return <div className="mx-auto max-w-screen-xl space-y-5">
    <div className="flex items-start gap-3"><div className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10"><Workflow className="h-4 w-4 text-primary" /></div><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold tracking-tight">Support Playbooks</h1><Badge variant="outline" className="text-[10px] uppercase tracking-wide">Read only</Badge></div><p className="mt-0.5 text-sm text-muted-foreground">View published customer journeys and routing rules for your workspace</p></div></div>
    {loadError ? <div role="alert" className="rounded-lg border border-destructive/30 p-4"><p className="text-sm">{loadError}</p><Button variant="outline" className="mt-3" onClick={() => void load()}>Retry playbooks</Button></div> : items.length ? <div className="grid gap-4 lg:grid-cols-2">{items.map((item) => <Card key={item.id} className="shadow-none"><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle className="text-base">{item.name}</CardTitle><CardDescription className="mt-1">{item.description || "Published support journey"}</CardDescription></div><Badge>Version {item.activeVersion}</Badge></div></CardHeader><CardContent className="space-y-4"><div className="flex flex-wrap gap-1.5">{item.assignments.length ? item.assignments.map((assignment) => <Badge key={assignment.id} variant="outline" className="capitalize">{assignment.channel || "All channels"}{assignment.intent ? ` · ${assignment.intent.replaceAll("_", " ")}` : ""}</Badge>) : <Badge variant="outline">All eligible conversations</Badge>}</div><div className="rounded-xl border bg-muted/20 p-3"><div className="flex items-center gap-2 text-xs font-medium"><GitBranch className="h-3.5 w-3.5" />Published flow</div><ol className="mt-3 space-y-3">{orderedPlaybookNodes(item.graph).map(({ node, reachable }) => <li key={node.id} id={`playbook-${item.id}-${node.id}`} className="rounded-lg border bg-background p-3 text-xs"><div className="flex flex-wrap items-center gap-2"><p className="font-medium capitalize">{String(node.data?.label || node.type).replaceAll("_", " ")}</p>{node.id === item.graph.entryNodeId && <Badge variant="outline">Start</Badge>}{!reachable && <Badge variant="outline">Unreachable</Badge>}</div>{(node.data?.instruction || node.data?.message) ? <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{String(node.data.instruction || node.data.message)}</p> : null}<ul className="mt-2 space-y-1">{item.graph.edges.filter((edge) => edge.source === node.id).map((edge, index) => <li key={edge.id || index} className="flex flex-wrap gap-1 text-muted-foreground"><span>{edge.condition?.operator && edge.condition.operator !== "always" ? `If ${edge.condition.operator.replaceAll("_", " ")}${edge.condition.value ? ": " + edge.condition.value : ""}${edge.condition.values?.length ? ": " + edge.condition.values.join(", ") : ""}` : "Next"} →</span><a className="text-primary underline underline-offset-2" href={`#playbook-${item.id}-${edge.target}`}>{String(item.graph.nodes.find((target) => target.id === edge.target)?.data?.label || edge.target)}</a></li>)}{!item.graph.edges.some((edge) => edge.source === node.id) && <li className="text-muted-foreground">End of this branch</li>}</ul></li>)}</ol></div></CardContent></Card>)}</div> : <div className="rounded-xl border border-dashed py-16 text-center"><BookOpen className="mx-auto h-7 w-7 text-muted-foreground" /><p className="mt-3 text-sm font-medium">No published playbooks</p><p className="mt-1 text-xs text-muted-foreground">Ask the workspace owner to publish a support journey.</p></div>}
  </div>;
}
