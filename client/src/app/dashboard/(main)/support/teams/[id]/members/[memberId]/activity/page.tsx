"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Activity, ArrowLeft, Clock3, MessageSquareReply, Radio, UserRoundCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageErrorState, PageLoadingState } from "@/components/ui/page-state";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { memberRoute, type SupportTeam } from "@/lib/supportOperations";
import { SupportActivityCalendar } from "@/components/support/SupportActivityCalendar";

interface PresenceDay { date: string; activeMinutes: number; firstLogin: string; lastActive: string; replies: number; intervals: Array<{ id: number; startedAt: string; endedAt: string }> }
interface MemberPresence { timezone: string; presenceState: "active" | "away"; lastActivity: string | null; todayActiveMinutes: number; todayFirstLogin: string | null; activeSessions: number; unrepliedWorkload: number; daily: PresenceDay[] }


function minutesLabel(minutes: number) { const hours = Math.floor(minutes / 60); const rest = minutes % 60; return hours ? `${hours}h ${rest}m` : `${rest}m`; }

export default function SupportMemberActivityPage() {
  const params = useParams();
  const router = useRouter();
  const teamId = String(params.id);
  const memberId = String(params.memberId);
  const [days, setDays] = useState<90 | 365>(90);
  const [team, setTeam] = useState<SupportTeam | null>(null);
  const [presence, setPresence] = useState<MemberPresence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { const [nextTeam, nextPresence] = await Promise.all([api.get<SupportTeam>(`/api/support/teams/${teamId}`), api.get<MemberPresence>(`/api/support/teams/${teamId}/members/${memberId}/presence?days=${days}`)]); setTeam(nextTeam); setPresence(nextPresence); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Failed to load activity history."); }
    finally { setLoading(false); }
  }, [days, memberId, teamId]);
  useEffect(() => { void load(); }, [load]);

  const member = team?.members.find((item) => String(item.id) === memberId) || null;
  const totals = useMemo(() => (presence?.daily || []).reduce((result, day) => ({ minutes: result.minutes + day.activeMinutes, replies: result.replies + day.replies, activeDays: result.activeDays + Number(day.activeMinutes > 0 || day.replies > 0) }), { minutes: 0, replies: 0, activeDays: 0 }), [presence]);

  if (loading) return <PageLoadingState label="Loading member activity…" />;
  if (error) return <PageErrorState title="Activity history could not be loaded" description={error} reset={() => void load()} />;
  if (!team || !member || !presence) return <PageErrorState title="Support member not found" description="This member may have been moved or removed." reset={() => router.push("/dashboard/support/teams")} />;

  return <div className="mx-auto max-w-screen-xl space-y-5 p-4 sm:p-5">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div className="flex items-center gap-3"><Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Back to assigned tickets" onClick={() => router.push(memberRoute(teamId, memberId))}><ArrowLeft className="h-4 w-4" /></Button><div><div className="flex items-center gap-2"><h1 className="text-lg font-semibold">{member.name} activity</h1><Badge variant="outline" className="text-[10px]">{team.name}</Badge><span className={cn("flex items-center gap-1 text-[10px]", presence.presenceState === "active" ? "text-success" : "text-muted-foreground")}><Radio className="h-3 w-3" />{presence.presenceState === "active" ? "Active now" : "Away"}</span></div><p className="mt-0.5 text-xs text-muted-foreground">Login presence and customer replies in {presence.timezone}.</p></div></div><div className="flex rounded-lg border border-border/60 bg-muted/20 p-1" aria-label="Activity history range"><Button size="sm" variant={days === 90 ? "default" : "ghost"} className="h-7 text-xs" onClick={() => setDays(90)}>90 days</Button><Button size="sm" variant={days === 365 ? "default" : "ghost"} className="h-7 text-xs" onClick={() => setDays(365)}>365 days</Button></div></div>

    <div className="grid overflow-hidden rounded-2xl border border-border/60 bg-card sm:grid-cols-2 xl:grid-cols-4"><Metric label="Tracked time" value={minutesLabel(totals.minutes)} icon={Clock3} /><Metric label="Active days" value={String(totals.activeDays)} icon={Activity} /><Metric label="Customer replies" value={String(totals.replies)} icon={MessageSquareReply} /><Metric label="Awaiting reply" value={String(presence.unrepliedWorkload)} icon={UserRoundCheck} /></div>

    <SupportActivityCalendar daily={presence.daily} days={days} timezone={presence.timezone} />

    <Card className="rounded-2xl border-border/60 shadow-none"><CardHeader className="pb-2"><CardTitle className="text-sm">Recent active days</CardTitle></CardHeader><CardContent className="p-0">{presence.daily.length === 0 ? <p className="px-5 py-12 text-center text-xs text-muted-foreground">No member activity was recorded in this range.</p> : <div className="divide-y divide-border/50">{[...presence.daily].reverse().slice(0, 30).map((day) => <div key={day.date} className="grid gap-2 px-5 py-3 text-xs sm:grid-cols-[150px_1fr_1fr_1fr]"><span className="font-medium">{day.date}</span><span className="text-muted-foreground">{minutesLabel(day.activeMinutes)} active</span><span className="text-muted-foreground">{day.replies} repl{day.replies === 1 ? "y" : "ies"}</span><span className="text-muted-foreground">{day.intervals.length} session{day.intervals.length === 1 ? "" : "s"}</span></div>)}</div>}</CardContent></Card>
  </div>;
}

function Metric({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Activity }) { return <div className="border-b border-r border-border/50 p-4 last:border-r-0 xl:border-b-0"><div className="flex items-start justify-between"><div><p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</p><p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value}</p></div><Icon className="h-4 w-4 text-primary" /></div></div>; }
