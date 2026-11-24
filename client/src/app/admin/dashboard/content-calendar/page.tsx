"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageErrorState } from "@/components/ui/page-state";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  CheckCircle,
  FileEdit,
} from "lucide-react";
import { formatMediumDate as formatDate, formatShortTime as formatTime } from "@/lib/display-format";

interface CalendarEvent {
  id: number;
  title?: string;
  name?: string;
  platform?: string;
  channel?: string;
  status?: string;
  scheduledDate?: string;
  scheduled_date?: string;
  scheduledAt?: string;
  scheduled_at?: string;
  publishedAt?: string;
  published_at?: string;
  type?: string;
  content?: string;
  userId?: number;
  userName?: string;
  user_name?: string;
  createdAt?: string;
  created_at?: string;
}

interface StatsData {
  scheduled: number;
  published: number;
  draft: number;
}

const DAYS_OF_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "bg-pink-200 text-pink-900 dark:bg-pink-900/40 dark:text-pink-300",
  facebook: "bg-blue-200 text-blue-900 dark:bg-blue-900/40 dark:text-blue-300",
  twitter: "bg-sky-200 text-sky-900 dark:bg-sky-900/40 dark:text-sky-300",
  linkedin: "bg-indigo-200 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-300",
  email: "bg-green-200 text-green-900 dark:bg-green-900/40 dark:text-green-300",
  sms: "bg-yellow-200 text-yellow-900 dark:bg-yellow-900/40 dark:text-yellow-300",
  tiktok: "bg-purple-200 text-purple-900 dark:bg-purple-900/40 dark:text-purple-300",
  blog: "bg-orange-200 text-orange-900 dark:bg-orange-900/40 dark:text-orange-300",
};

export default function ContentCalendarPage() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [stats, setStats] = useState<StatsData>({
    scheduled: 0,
    published: 0,
    draft: 0,
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [platformFilter, setPlatformFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const { toast } = useToast();

  const fetchCalendar = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<unknown>("/api/admin/content-calendar");
      const eventsList: CalendarEvent[] = Array.isArray(data)
        ? (data as CalendarEvent[])
        : ((data as Record<string, unknown>).events as CalendarEvent[]) || ((data as Record<string, unknown>).items as CalendarEvent[]) || ((data as Record<string, unknown>).data as CalendarEvent[]) || [];
      setEvents(eventsList);

      const statsData = !Array.isArray(data) ? (data as Record<string, unknown>)?.stats : undefined;
      if (statsData) {
        setStats(statsData as StatsData);
      } else {
        computeStats(eventsList);
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load calendar";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const computeStats = (eventsList: CalendarEvent[]) => {
    const scheduled = eventsList.filter(
      (e) => e.status?.toLowerCase() === "scheduled"
    ).length;
    const published = eventsList.filter(
      (e) => e.status?.toLowerCase() === "published"
    ).length;
    const draft = eventsList.filter(
      (e) => e.status?.toLowerCase() === "draft"
    ).length;
    setStats({ scheduled, published, draft });
  };

  useEffect(() => {
    fetchCalendar();
  }, [fetchCalendar]);

  const getEventDate = (event: CalendarEvent): string | null => {
    return (
      event.scheduledDate ||
      event.scheduled_date ||
      event.scheduledAt ||
      event.scheduled_at ||
      event.publishedAt ||
      event.published_at ||
      event.createdAt ||
      event.created_at ||
      null
    );
  };

  const getEventPlatform = (event: CalendarEvent) =>
    (event.platform || event.channel || event.type || "other").toLowerCase();

  const availablePlatforms = [...new Set(events.map(getEventPlatform))]
    .filter((platform) => platform !== "other")
    .sort();
  const availableStatuses = [...new Set(events.map((event) => (event.status || "unknown").toLowerCase()))]
    .sort();
  const filteredEvents = events.filter((event) => {
    const matchesPlatform = platformFilter === "all" || getEventPlatform(event) === platformFilter;
    const matchesStatus = statusFilter === "all" || (event.status || "unknown").toLowerCase() === statusFilter;
    return matchesPlatform && matchesStatus;
  });

  const getPlatformBadgeClass = (platform: string) =>
    PLATFORM_COLORS[platform] || "bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-gray-300";

  // Calendar helpers
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const firstDayOfMonth = new Date(year, month, 1);
  const lastDayOfMonth = new Date(year, month + 1, 0);
  const startDay = firstDayOfMonth.getDay();
  const daysInMonth = lastDayOfMonth.getDate();

  const monthLabel = currentDate.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  const goToPrevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const goToNextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
  };
  const goToToday = () => setCurrentDate(new Date());

  // Group events by day
  const eventsByDay: Record<number, CalendarEvent[]> = {};
  filteredEvents.forEach((event) => {
    const dateStr = getEventDate(event);
    if (!dateStr) return;
    const d = new Date(dateStr);
    if (d.getFullYear() === year && d.getMonth() === month) {
      const day = d.getDate();
      if (!eventsByDay[day]) eventsByDay[day] = [];
      eventsByDay[day].push(event);
    }
  });

  // Build calendar grid cells
  const calendarCells: (number | null)[] = [];
  for (let i = 0; i < startDay; i++) calendarCells.push(null);
  for (let d = 1; d <= daysInMonth; d++) calendarCells.push(d);

  // Upcoming events (next 30 days from today)
  const today = new Date();
  const upcomingEvents = filteredEvents
    .filter((event) => {
      const dateStr = getEventDate(event);
      if (!dateStr) return false;
      const d = new Date(dateStr);
      return d >= today && d <= new Date(today.getTime() + 30 * 86400000);
    })
    .sort((a, b) => {
      const da = new Date(getEventDate(a) || "").getTime();
      const db = new Date(getEventDate(b) || "").getTime();
      return da - db;
    })
    .slice(0, 10);

  const statCards = [
    {
      title: "Scheduled",
      value: stats.scheduled.toLocaleString(),
      icon: Clock,
      gradient: "from-blue-500 to-blue-700",
      bgGradient: "from-blue-500/10 to-blue-700/10",
    },
    {
      title: "Published",
      value: stats.published.toLocaleString(),
      icon: CheckCircle,
      gradient: "from-green-500 to-green-700",
      bgGradient: "from-green-500/10 to-green-700/10",
    },
    {
      title: "Draft",
      value: stats.draft.toLocaleString(),
      icon: FileEdit,
      gradient: "from-yellow-500 to-yellow-700",
      bgGradient: "from-yellow-500/10 to-yellow-700/10",
    },
  ];

  if (loading) {
    return (
      <LoadingState size="page" label="Loading content calendar…" />
    );
  }

  if (loadError) {
    return <PageErrorState title="Content calendar could not be loaded" description={loadError} reset={() => void fetchCalendar()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black tracking-tighter flex items-center gap-2">
          <Calendar className="h-8 w-8 text-purple-600" />
          Content Calendar
        </h1>
        <p className="text-muted-foreground mt-1">
          View scheduled and published content across all users. Use channel and status filters to focus the calendar.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {statCards.map((card) => (
          <Card
            key={card.title}
            className={`relative overflow-hidden bg-gradient-to-br ${card.bgGradient} border-0`}
          >
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.title}
              </CardTitle>
              <div
                className={`p-2 rounded-lg bg-gradient-to-br ${card.gradient}`}
              >
                <card.icon className="h-4 w-4 text-white" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{card.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">
        Summary totals cover all content. Filters below apply to calendar events and the upcoming list.
      </p>

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-center">
        <Select value={platformFilter} onValueChange={setPlatformFilter}>
          <SelectTrigger className="w-full sm:w-[200px]" aria-label="Filter calendar by channel">
            <SelectValue placeholder="All channels" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
            {availablePlatforms.map((platform) => (
              <SelectItem key={platform} value={platform} className="capitalize">{platform}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-[200px]" aria-label="Filter calendar by content status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {availableStatuses.map((status) => (
              <SelectItem key={status} value={status} className="capitalize">{status}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(platformFilter !== "all" || statusFilter !== "all") && (
          <Button variant="ghost" onClick={() => { setPlatformFilter("all"); setStatusFilter("all"); }}>
            Clear filters
          </Button>
        )}
        <span className="text-sm text-muted-foreground sm:ml-auto" aria-live="polite">
          Showing {filteredEvents.length} of {events.length} items
        </span>
      </div>

      {/* Calendar Navigation */}
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={goToPrevMonth} aria-label="Show previous month">
          <ChevronLeft className="h-4 w-4" />
          Previous
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={goToToday}>Today</Button>
          <h2 className="text-lg font-semibold sm:text-xl">{monthLabel}</h2>
        </div>
        <Button variant="outline" size="sm" onClick={goToNextMonth} aria-label="Show next month">
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Calendar Grid */}
      <Card>
        <CardContent className="p-4">
          {/* Day headers */}
          <div className="grid grid-cols-7 gap-1 mb-2">
            {DAYS_OF_WEEK.map((day) => (
              <div
                key={day}
                className="text-center text-xs font-semibold text-muted-foreground py-2"
              >
                {day}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7 gap-1">
            {calendarCells.map((day, idx) => {
              const isToday =
                day !== null &&
                today.getDate() === day &&
                today.getMonth() === month &&
                today.getFullYear() === year;
              const dayEvents = day ? eventsByDay[day] || [] : [];

              return (
                <div
                  key={idx}
                  className={`min-h-[80px] p-1 rounded-md border ${
                    day === null
                      ? "bg-transparent border-transparent"
                      : isToday
                      ? "bg-purple-50 border-purple-300 dark:bg-purple-950/30 dark:border-purple-700"
                      : "bg-background border-border"
                  }`}
                >
                  {day !== null && (
                    <>
                      <div
                        className={`text-xs font-medium mb-1 ${
                          isToday
                            ? "text-purple-700 dark:text-purple-400 font-bold"
                            : "text-muted-foreground"
                        }`}
                      >
                        {day}
                      </div>
                      <div className="space-y-0.5">
                        {dayEvents.slice(0, 3).map((event) => (
                          <div
                            key={event.id}
                            className={`text-[10px] px-1 py-0.5 rounded truncate ${getPlatformBadgeClass(
                              getEventPlatform(event)
                            )}`}
                            title={event.title || event.name || "Event"}
                          >
                            {event.title || event.name || getEventPlatform(event)}
                          </div>
                        ))}
                        {dayEvents.length > 3 && (
                          <div className="text-[10px] text-muted-foreground px-1">
                            +{dayEvents.length - 3} more
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Upcoming Events Table */}
      <div>
        <h3 className="text-lg font-semibold mb-3">Upcoming Scheduled Items</h3>
        <div className="overflow-x-auto rounded-md border">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Scheduled Date</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {upcomingEvents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8">
                    <p className="text-muted-foreground">No upcoming events</p>
                  </TableCell>
                </TableRow>
              ) : (
                upcomingEvents.map((event) => {
                  const dateStr = getEventDate(event);
                  const platform = getEventPlatform(event);
                  return (
                    <TableRow key={event.id}>
                      <TableCell className="font-medium">
                        {event.title || event.name || "—"}
                      </TableCell>
                      <TableCell>
                        <Badge className={`${getPlatformBadgeClass(platform)} text-xs`}>
                          {platform}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {event.status ? (
                          <Badge
                            className={
                              event.status.toLowerCase() === "published"
                                ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                                : event.status.toLowerCase() === "scheduled"
                                ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400"
                                : "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400"
                            }
                          >
                            {event.status}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        {event.userId ? (
                          <Link href={`/admin/dashboard/users/${event.userId}/view`} className="text-primary hover:underline">
                            {event.userName || event.user_name || `User #${event.userId}`}
                          </Link>
                        ) : event.userName || event.user_name || "—"}
                      </TableCell>
                      <TableCell>{formatDate(dateStr)}</TableCell>
                      <TableCell>{formatTime(dateStr)}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Footer */}
      <div className="text-sm text-muted-foreground">
        Total: {events.length} content items
      </div>
    </div>
  );
}
