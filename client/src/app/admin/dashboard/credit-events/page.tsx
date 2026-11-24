"use client";

import React, { useState, useEffect, useCallback } from "react";
import api from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Activity,
  RefreshCw,
  Filter,
} from "lucide-react";
import { usageCredits } from "@/lib/usageCredits";

interface CreditEvent {
  id: number;
  userId: number;
  eventKey: string;
  creditsUsed: string;
  balanceAfter: string;
  description: string;
  service: string;
  apiProvider?: string;
  apiCostCents?: number;
  referenceType?: string | null;
  referenceId?: string | null;
  createdAt: string;
  userName?: string | null;
  userEmail?: string | null;
}

const CATEGORY_COLORS: Record<string, string> = {
  lead: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  content: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  outreach: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
  api_usage: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  marketing: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-400",
};

export default function CreditEventsPage() {
  const { toast } = useToast();
  const [events, setEvents] = useState<CreditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serviceFilter, setServiceFilter] = useState<string>("all");

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = serviceFilter !== "all" ? `?eventKey=${serviceFilter}` : "";
      const res = await api.get<{ logs: CreditEvent[]; total: number }>(
        `/api/admin/credit-events${params}`
      );
      setEvents(res?.logs || []);
    } catch (error: unknown) {
      setLoadError(error instanceof Error ? error.message : "Failed to load credit events");
      toast({ title: "Error", description: "Failed to load credit events", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [serviceFilter, toast]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const getEventCategory = (eventKey: string): string => {
    if (eventKey.startsWith("lead")) return "lead";
    if (eventKey.startsWith("content") || eventKey.startsWith("image") || eventKey.startsWith("video")) return "content";
    if (eventKey.startsWith("outreach") || eventKey.startsWith("email") || eventKey.startsWith("sms")) return "outreach";
    if (eventKey.includes("api") || eventKey.includes("openai") || eventKey.includes("apify") || eventKey.includes("gemini") || eventKey.includes("zerobounce")) return "api_usage";
    if (eventKey.includes("campaign") || eventKey.includes("ad")) return "marketing";
    return "other";
  };

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold sm:text-2xl">
            <Activity className="h-6 w-6 text-purple-600 dark:text-purple-400" />
            Credit Event Logs
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            View all credit-consuming events across all users
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={serviceFilter} onValueChange={setServiceFilter}>
            <SelectTrigger className="w-full sm:w-[180px]" aria-label="Filter credit events">
              <Filter className="w-4 h-4 mr-1" />
              <SelectValue placeholder="Filter by event" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Events</SelectItem>
              <SelectItem value="lead_generation">Lead Generation</SelectItem>
              <SelectItem value="lead_enrichment">Lead Enrichment</SelectItem>
              <SelectItem value="lead_scoring">Lead Scoring</SelectItem>
              <SelectItem value="content_email">Email Content</SelectItem>
              <SelectItem value="content_image">Image Generation</SelectItem>
              <SelectItem value="content_video">Video Generation</SelectItem>
              <SelectItem value="outreach_email">Email Outreach</SelectItem>
              <SelectItem value="outreach_sms">SMS Outreach</SelectItem>
              <SelectItem value="api_openai">OpenAI API</SelectItem>
              <SelectItem value="api_openrouter">OpenRouter API</SelectItem>
              <SelectItem value="api_custom_ai">Custom AI API</SelectItem>
              <SelectItem value="api_apify">Apify Scraping</SelectItem>
              <SelectItem value="api_gemini">Gemini API</SelectItem>
              <SelectItem value="campaign_creation">Campaign Creation</SelectItem>
              <SelectItem value="ad_creation">Ad Creation</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={fetchEvents} className="gap-2">
            <RefreshCw className="w-4 h-4" /> Refresh
          </Button>
        </div>
      </div>

      {loadError && (
        <Callout
          tone="danger"
          title="Credit events could not be loaded"
          actions={<Button variant="outline" size="sm" onClick={() => void fetchEvents()}>Try again</Button>}
        >
          {loadError}
        </Callout>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent Credit Events</CardTitle>
        </CardHeader>
        <CardContent>
          {loadError ? null : loading ? (
            <LoadingState size="section" label="Loading credit events…" />
          ) : events.length === 0 ? (
            <div className="text-center py-12">
              <Activity className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No credit events found</p>
              <p className="text-sm text-muted-foreground">Events will appear here as users consume credits.</p>
            </div>
          ) : (
            <Table className="min-w-[1100px]">
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Thread</TableHead>
                  <TableHead className="text-right">Credits</TableHead>
                  <TableHead className="text-right">Balance After</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">API Cost</TableHead>
                  <TableHead className="text-right">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((evt) => {
                  const cat = getEventCategory(evt.eventKey);
                  return (
                    <TableRow key={evt.id}>
                      <TableCell>
                        <span className="text-sm font-medium">{evt.userName || `#${evt.userId}`}</span>
                        {evt.userEmail && <span className="text-xs text-muted-foreground ml-1">({evt.userEmail})</span>}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs ${CATEGORY_COLORS[cat] || ""}`}>
                          {evt.eventKey}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                        {evt.description}
                      </TableCell>
                      <TableCell>
                        {evt.referenceType === 'chat_thread' && evt.referenceId ? (
                          <Badge variant="outline" className="bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 font-mono text-xs">
                            #{evt.referenceId}
                          </Badge>
                        ) : "—"}
                      </TableCell>
                      <TableCell className={`text-right font-mono font-semibold ${usageCredits(evt.creditsUsed).className}`}>
                        {usageCredits(evt.creditsUsed).label}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {parseFloat(evt.balanceAfter).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {evt.apiProvider && (
                          <Badge variant="secondary" className="text-xs">
                            {evt.apiProvider}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {evt.apiCostCents != null ? `₹${evt.apiCostCents.toFixed(2)}` : "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {new Date(evt.createdAt).toLocaleDateString()}{" "}
                        {new Date(evt.createdAt).toLocaleTimeString()}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
