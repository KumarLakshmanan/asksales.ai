"use client";
import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { creatorSessionScope } from '@/lib/creator-session';
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes';
import { canReplayCalendarBulkIntent, clearCalendarBulkIntent, loadCalendarBulkIntent, saveCalendarBulkIntent, type CalendarBulkIntent, type CalendarBulkPayload } from '@/lib/calendar-bulk-intent';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/ui/page-header';
import { 
  ChevronLeft,
  ChevronRight,
  Calendar as CalendarIcon,
  Clock,
  Edit,
  Trash2,
  Instagram,
  Facebook,
  Linkedin,
  Twitter,
  Youtube,
  MoreVertical,
  Plus,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContentCalendarSkeleton } from '@/components/skeletons';
import { PageErrorState } from '@/components/ui/page-state';
import { usePreferences } from '@/contexts/PreferencesContext';
import { dateInTimezone, zonedDateTimeToUtc } from '@/lib/timezone';
import { publishingStatusLabel } from '@/lib/socialPublishing';
import { formatLocalDate } from '@/lib/display-format';

interface ContentItem {
  id: number;
  sourceKey: string;
  title: string;
  content: string;
  platform: 'instagram' | 'facebook' | 'linkedin' | 'twitter' | 'youtube';
  scheduled_date: string;
  scheduled_time: string;
  status: 'draft' | 'planned' | 'scheduled' | 'processing' | 'ambiguous' | 'published' | 'failed' | 'cancelled';
  type: 'post' | 'story' | 'reel' | 'carousel' | 'video' | 'short' | 'ad';
  plan_id?: number;
  contentAssetId?: number;
  scheduledAt?: string;
  publishAttempts?: PublishAttempt[];
  version?: number;
  metadata?: {
    publishedUrl?: string;
    platforms?: string[];
    postType?: string;
    retryCount?: number;
    lastError?: string | null;
    [key: string]: unknown;
  };
}

interface PublishAttempt {
  id: number;
  platform: ContentItem['platform'];
  status: string;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  providerPostUrl?: string | null;
  updatedAt?: string;
  completedAt?: string | null;
  reviewedPayload?: { privacyStatus?: string };
  capabilities?: { retry: boolean; reconcile: boolean; publishNow: boolean };
}

interface ColorScheme {
  bg: string;
  border: string;
  text: string;
  badge: string;
}

const platformIcons = {
  instagram: Instagram,
  facebook: Facebook,
  linkedin: Linkedin,
  twitter: Twitter,
  youtube: Youtube,
};

// Keep format legible without turning the calendar into a rainbow. The label carries
// the semantic distinction; the copper rail keeps scheduled work visually scannable.
const typeColors: Record<ContentItem['type'], ColorScheme> = {
  reel: { 
    bg: 'bg-muted/55', border: 'border-l-2 border-primary/70', text: 'text-foreground', badge: 'bg-secondary text-secondary-foreground',
  },
  carousel: { 
    bg: 'bg-muted/55', border: 'border-l-2 border-primary/70', text: 'text-foreground', badge: 'bg-secondary text-secondary-foreground',
  },
  post: { 
    bg: 'bg-muted/55', border: 'border-l-2 border-primary/70', text: 'text-foreground', badge: 'bg-secondary text-secondary-foreground',
  },
  story: { 
    bg: 'bg-muted/55', border: 'border-l-2 border-primary/70', text: 'text-foreground', badge: 'bg-secondary text-secondary-foreground',
  },
  ad: { 
    bg: 'bg-muted/55', border: 'border-l-2 border-primary/70', text: 'text-foreground', badge: 'bg-secondary text-secondary-foreground',
  },
  video: {
    bg: 'bg-muted/55', border: 'border-l-2 border-primary/70', text: 'text-foreground', badge: 'bg-secondary text-secondary-foreground',
  },
  short: {
    bg: 'bg-muted/55', border: 'border-l-2 border-primary/70', text: 'text-foreground', badge: 'bg-secondary text-secondary-foreground',
  },
};

const daysOfWeek = ['SUN', 'MON', 'TUE', 'WED', 'THUR', 'FRI', 'SAT'];
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const hours = Array.from({ length: 24 }, (_, i) => i); // 0-23

const calendarTimeLabel = (item: Pick<ContentItem, 'status' | 'scheduled_time'>) => {
  const label = item.status === 'published'
    ? 'Published'
    : item.status === 'scheduled'
      ? 'Scheduled'
      : item.status.charAt(0).toUpperCase() + item.status.slice(1);
  return `${label}: ${item.scheduled_time}`;
};

export default function ContentCalendarPage() {
  const router = useRouter();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [contentItems, setContentItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const contentRequest = useRef(0);
  const contentInFlight = useRef(0);
  const [viewMode, setViewMode] = useState<'month' | 'week'>('month');
  const [platformFilter, setPlatformFilter] = useState<'all' | ContentItem['platform']>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ContentItem['status']>('all');
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const dayControl = useRef<HTMLElement | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; item: ContentItem | null }>({ open: false, item: null });
  const [editingItem, setEditingItem] = useState<ContentItem | null>(null);
  const [editForm, setEditForm] = useState({ title: '', content: '', scheduledDate: '', scheduledTime: '' });
  const [savingEdit, setSavingEdit] = useState(false);
  const [publishAttempts, setPublishAttempts] = useState<Record<number, PublishAttempt[]>>({});
  const [loadingAttempts, setLoadingAttempts] = useState(false);
  const [unavailableAttempts, setUnavailableAttempts] = useState<Record<number, boolean>>({});
  const [historyRetry, setHistoryRetry] = useState(0);
  const [selectedAssetIds, setSelectedAssetIds] = useState<number[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [actionScope, setActionScope] = useState<'single' | 'group'>('single');
  const [bulkAction, setBulkAction] = useState<'cancel' | 'reschedule' | null>(null);
  const [bulkSchedule, setBulkSchedule] = useState({ date: '', time: '12:00' });
  const [actionBusy, setActionBusy] = useState(false);
  const [pendingBulkIntent, setPendingBulkIntent] = useState<CalendarBulkIntent | null>(null);
  const [bulkRecoveryError, setBulkRecoveryError] = useState<string | null>(null);
  const pendingBulkRef = useRef<CalendarBulkIntent | null>(null);
  const calendarScope = useRef(creatorSessionScope());
  const calendarMounted = useRef(false);
  const calendarGeneration = useRef(0);
  const bulkRequest = useRef<AbortController | null>(null);
  const [publishNowConfirm, setPublishNowConfirm] = useState<{ item: ContentItem; attempt: PublishAttempt } | null>(null);
  const [linkedAssetId, setLinkedAssetId] = useState<number | null>(null);
  const deepLinkHandled = useRef(false);
  const deepLinkFocused = useRef(false);
  const [draggedItem, setDraggedItem] = useState<ContentItem | null>(null);
  const { toast } = useToast();
  const { preferences, isLoading: preferencesLoading } = usePreferences();
  const editChanged = Boolean(editingItem && (editForm.title !== editingItem.title || editForm.content !== (editingItem.content || '')
    || editForm.scheduledDate !== editingItem.scheduled_date || editForm.scheduledTime !== editingItem.scheduled_time));
  const { clearGuard: clearEditGuard } = useUnsavedChanges(savingEdit || editChanged);

  const restoreBulkIntent = () => {
    try {
      const intent = loadCalendarBulkIntent(calendarScope.current);
      pendingBulkRef.current = intent;
      setPendingBulkIntent(intent);
      setBulkRecoveryError(null);
      if (intent) { setSelectedAssetIds(intent.payload.assetIds); setSelectionMode(true); }
    } catch {
      setBulkRecoveryError('Calendar recovery details could not be read. Retry before submitting another calendar action.');
    }
  };
  useEffect(() => {
    calendarGeneration.current += 1;
    calendarMounted.current = true;
    restoreBulkIntent();
    return () => { calendarGeneration.current += 1; calendarMounted.current = false; bulkRequest.current?.abort(); };
  }, []);

  useEffect(() => {
    setCurrentDate(dateInTimezone(new Date(), preferences.timezone));
  }, [preferences.timezone]);

  useEffect(() => {
    if (preferencesLoading || deepLinkHandled.current) return;
    const assetId = Number(new URLSearchParams(window.location.search).get('assetId'));
    if (!Number.isSafeInteger(assetId) || assetId <= 0) return;
    deepLinkHandled.current = true;
    let cancelled = false;
    let completed = false;
    void api.get<{ id: number; status: string; scheduledPublishAt?: string; publishedAt?: string; createdAt: string }>(`/api/content/assets/${assetId}`).then(asset => {
      if (cancelled) return;
      completed = true;
      const instant = asset.status === 'published' ? (asset.publishedAt || asset.scheduledPublishAt || asset.createdAt) : (asset.scheduledPublishAt || asset.publishedAt || asset.createdAt);
      const timestamp = new Date(instant);
      if (!Number.isFinite(timestamp.getTime())) throw new Error('The post has no valid calendar date.');
      const date = dateInTimezone(timestamp, preferences.timezone);
      setCurrentDate(date);
      setSelectedDate(date);
      setLinkedAssetId(asset.id);
      setSidePanelOpen(true);
    }).catch(error => {
      if (!cancelled) { completed = true; toast({ title: 'Post unavailable', description: error instanceof Error ? error.message : 'This post could not be opened.', variant: 'destructive' }); }
    });
    return () => { cancelled = true; if (!completed) deepLinkHandled.current = false; };
  }, [preferences.timezone, preferencesLoading, toast]);

  useEffect(() => {
    if (!sidePanelOpen || !linkedAssetId || deepLinkFocused.current || !contentItems.some(item => item.contentAssetId === linkedAssetId)) return;
    const timer = window.setTimeout(() => {
      const card = document.getElementById(`calendar-asset-${linkedAssetId}`);
      if (card) { card.scrollIntoView?.({ block: 'nearest' }); card.focus({ preventScroll: true }); deepLinkFocused.current = true; }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sidePanelOpen, linkedAssetId, contentItems]);

  const loadContentItems = useCallback(async (quiet = false) => {
    const request = ++contentRequest.current;
    contentInFlight.current = request;
    try {
      if (!quiet) { setLoading(true); setLoadError(null); setRefreshError(null); }
      let rangeStart: Date;
      let rangeEnd: Date;
      if (viewMode === 'week') {
        rangeStart = new Date(currentDate);
        rangeStart.setDate(currentDate.getDate() - currentDate.getDay());
        rangeEnd = new Date(rangeStart);
        rangeEnd.setDate(rangeStart.getDate() + 6);
      } else {
        rangeStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
        rangeEnd = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
      }
      const startDate = formatLocalDate(rangeStart);
      const endDate = formatLocalDate(rangeEnd);

      const data = await api.get<{ items?: ContentItem[]; success?: boolean }>('/api/content/calendar', {
        params: { startDate, endDate, timezone: preferences.timezone },
      });

      const items = (data.items || []).map((item: ContentItem & { contentPlanId?: number }, index) => {
        return {
          ...item,
          sourceKey: item.sourceKey || `${item.contentAssetId ? 'asset' : 'calendar'}-${item.id}-${item.contentPlanId || item.plan_id || index}`,
          scheduled_date: item.scheduled_date,
          scheduled_time: item.scheduled_time,
          plan_id: item.contentPlanId || item.plan_id,
        };
      });

      if (request === contentRequest.current) {
        setHasLoaded(true);
        setLoadError(null);
        setRefreshError(null);
        setContentItems(items);
        setPublishAttempts(current => ({ ...current, ...Object.fromEntries(items.filter(item => item.contentAssetId && item.publishAttempts).map(item => [item.contentAssetId, item.publishAttempts])) }));
        setUnavailableAttempts(current => {
          const next = { ...current };
          items.forEach(item => { if (item.contentAssetId && item.publishAttempts) delete next[item.contentAssetId]; });
          return next;
        });
        setSelectedAssetIds(ids => pendingBulkRef.current ? ids : ids.filter(id => items.some(item => item.contentAssetId === id && item.status === 'scheduled')));
      }
    } catch (error) {
      console.error('Failed to load content items:', error);
      if (request === contentRequest.current) {
        const message = error instanceof Error ? error.message : 'Unable to load scheduled content.';
        if (quiet) setRefreshError(message); else setLoadError(message);
      }
    } finally {
      if (request === contentRequest.current) setLoading(false);
      if (contentInFlight.current === request) contentInFlight.current = 0;
    }
  }, [currentDate, preferences.timezone, viewMode]);

  const refreshCurrentView = useRef(loadContentItems);
  useLayoutEffect(() => { refreshCurrentView.current = loadContentItems; }, [loadContentItems]);

  useEffect(() => {
    void loadContentItems();
    return () => { contentRequest.current += 1; };
  }, [loadContentItems]);

  useEffect(() => {
    if (!contentItems.some(item => ['scheduled', 'processing', 'ambiguous'].includes(item.status))) return;
    // A background refresh must not supersede a load that is still running;
    // when the API is slower than this interval the calendar never settles.
    const refresh = () => { if (document.visibilityState === 'visible' && !contentInFlight.current) void loadContentItems(true); };
    const interval = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', refresh); };
  }, [contentItems, loadContentItems]);

  useEffect(() => {
    if (!sidePanelOpen || !selectedDate) { setLoadingAttempts(false); return; }
    const selectedDateKey = formatLocalDate(selectedDate);
    const assetIds = [...new Set(contentItems
      .filter((item) => item.scheduled_date === selectedDateKey && item.contentAssetId && !item.publishAttempts)
      .map((item) => item.contentAssetId as number))];
    if (assetIds.length === 0) { setLoadingAttempts(false); return; }
    let cancelled = false;
    setLoadingAttempts(true);
    Promise.allSettled(assetIds.map(async (assetId) => {
      const response = await api.get<{ attempts?: PublishAttempt[] }>(`/api/content/assets/${assetId}/publish-attempts`);
      return [assetId, response.attempts || []] as const;
    }))
      .then((entries) => {
        if (cancelled) return;
        setPublishAttempts((current) => ({ ...current, ...Object.fromEntries(entries.flatMap(entry => entry.status === 'fulfilled' ? [entry.value] : [])) }));
        setUnavailableAttempts(current => {
          const next = { ...current };
          entries.forEach((entry, index) => {
            if (entry.status === 'rejected') next[assetIds[index]] = true;
            else delete next[assetIds[index]];
          });
          return next;
        });
      })
      .finally(() => { if (!cancelled) setLoadingAttempts(false); });
    return () => { cancelled = true; };
  }, [contentItems, selectedDate, sidePanelOpen, historyRetry]);

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days = [];
    
    // Add empty slots for days before the first day of the month
    for (let i = 0; i < firstDay.getDay(); i++) {
      days.push(null);
    }
    
    // Add all days of the month
    for (let i = 1; i <= lastDay.getDate(); i++) {
      days.push(new Date(year, month, i));
    }
    
    return days;
  };

  const getWeekDays = (date: Date) => {
    const current = new Date(date);
    const day = current.getDay();
    const diff = current.getDate() - day;
    const weekStart = new Date(current.setDate(diff));
    
    const days = [];
    for (let i = 0; i < 7; i++) {
      days.push(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i));
    }
    return days;
  };

  const getContentForDate = (date: Date | null) => {
    if (!date) return [];
    const dateStr = formatLocalDate(date);
    return contentItems.filter((item) => (
      item.scheduled_date === dateStr
      && (platformFilter === 'all' || item.platform === platformFilter)
      && (statusFilter === 'all' || item.status === statusFilter)
    )).sort((a, b) =>
      a.scheduled_time.localeCompare(b.scheduled_time)
    );
  };

  const getContentForDateAndHour = (date: Date, hour: number) => {
    const dateStr = formatLocalDate(date);
    return contentItems.filter(item => {
      if (item.scheduled_date !== dateStr) return false;
      if (platformFilter !== 'all' && item.platform !== platformFilter) return false;
      if (statusFilter !== 'all' && item.status !== statusFilter) return false;
      const itemHour = parseInt(item.scheduled_time.split(':')[0], 10);
      return itemHour === hour;
    });
  };

  const navigateMonth = (direction: number) => {
    setCurrentDate(date => new Date(date.getFullYear(), date.getMonth() + direction, 1));
  };

  const navigateWeek = (direction: number) => {
    setCurrentDate(date => new Date(date.getFullYear(), date.getMonth(), date.getDate() + (direction * 7)));
  };

  const isToday = (date: Date | null) => {
    if (!date) return false;
    const today = dateInTimezone(new Date(), preferences.timezone);
    return date.toDateString() === today.toDateString();
  };

  const formatHour = (hour: number) => {
    if (hour === 0) return '12 AM';
    if (hour === 12) return '12 PM';
    if (hour < 12) return `${hour} AM`;
    return `${hour - 12} PM`;
  };

  const handleDateClick = (date: Date | null) => {
    if (date) {
      dayControl.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      setSelectedDate(date);
      setSidePanelOpen(true);
    }
  };

  const openSocialPostCreator = (date?: Date | null) => {
    const scheduledDate = date ? `?date=${formatLocalDate(date)}` : '';
    router.push(`/dashboard/saved-templates/social/generate${scheduledDate}`);
  };

  const getDayColor = (dateContent: ContentItem[]): ColorScheme => {
    if (dateContent.length === 0) return typeColors.post;
    // Get the dominant type color from the first item on that day
    const firstItemType = dateContent[0].type as keyof typeof typeColors;
    return typeColors[firstItemType] || typeColors.post;
  };

  const handleDelete = async (itemId: number) => {
    try {
      const item = deleteConfirm.item;
      if (!item) return;
      if (item.contentAssetId) {
        await api.delete(`/api/content/assets/${item.contentAssetId}`);
      } else if (item.plan_id) {
        await api.delete(`/api/content/calendar/${itemId}`, { params: { contentPlanId: item.plan_id } });
      } else {
        throw new Error('This calendar item has no persistent source.');
      }
      setContentItems((items) => items.filter((entry) => entry.sourceKey !== item.sourceKey));
      setDeleteConfirm({ open: false, item: null });
      toast({
        title: 'Success',
        description: 'Content deleted successfully',
        variant: 'default'
      });
    } catch (error) {
      console.error('Failed to delete content:', error);
      toast({
        title: 'Error',
        description: 'Failed to delete content',
        variant: 'destructive'
      });
    }
  };

  const openEdit = (item: ContentItem) => {
    setActionScope('single');
    setEditingItem(item);
    setEditForm({
      title: item.title,
      content: item.content || '',
      scheduledDate: item.scheduled_date,
      scheduledTime: item.scheduled_time,
    });
  };

  const saveEdit = async () => {
    if (!editingItem || !editForm.title.trim() || !editForm.scheduledDate) return;
    setSavingEdit(true);
    try {
      if (editingItem.contentAssetId) {
        const scheduledPublishAt = zonedDateTimeToUtc(
          editForm.scheduledDate,
          editForm.scheduledTime || '12:00',
          preferences.timezone,
        );
        if (scheduledPublishAt.getTime() <= Date.now() + 60_000) {
          throw new Error('Scheduled time must be at least one minute in the future.');
        }
        await api.post(`/api/content/assets/${editingItem.contentAssetId}/reschedule`, {
          scheduledFor: scheduledPublishAt.toISOString(),
          scope: actionScope,
          expectedScheduledFor: editingItem.scheduledAt,
          expectedVersion: editingItem.version,
        });
      } else if (editingItem.plan_id) {
        await api.put(`/api/content/calendar/${editingItem.id}`, {
          contentPlanId: editingItem.plan_id,
          title: editForm.title.trim(),
          description: editForm.content,
          scheduledDate: editForm.scheduledDate,
          scheduledTime: editForm.scheduledTime || '12:00',
        });
      } else {
        throw new Error('This calendar item has no persistent source.');
      }
      setEditingItem(null);
      clearEditGuard();
      await refreshCurrentView.current();
      toast({ title: 'Content updated', description: 'The calendar item was saved.' });
    } catch (error) {
      toast({ title: 'Update failed', description: error instanceof Error ? error.message : 'Unable to update content.', variant: 'destructive' });
    } finally {
      setSavingEdit(false);
    }
  };

  const canMove = (item: ContentItem) => item.contentAssetId ? item.status === 'scheduled' : ['planned', 'draft'].includes(item.status);
  const dropOnDate = (date: Date, item: ContentItem | null, hour?: number) => {
    setDraggedItem(null);
    if (!item || !canMove(item)) return;
    openEdit(item);
    setEditForm({ title: item.title, content: item.content || '', scheduledDate: formatLocalDate(date), scheduledTime: hour === undefined ? item.scheduled_time : `${String(hour).padStart(2, '0')}:00` });
  };

  const runBulkAction = async () => {
    if (bulkRequest.current || actionBusy || bulkRecoveryError || calendarScope.current !== creatorSessionScope()) return;
    if (!pendingBulkRef.current && (!selectedAssetIds.length || !bulkAction)) return;
    setActionBusy(true);
    const generation = calendarGeneration.current;
    const current = () => calendarMounted.current && generation === calendarGeneration.current && calendarScope.current === creatorSessionScope();
    let intent = pendingBulkRef.current;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!intent) {
        const selected = contentItems.filter(item => item.contentAssetId && selectedAssetIds.includes(item.contentAssetId));
        const payload: CalendarBulkPayload = {
          action: bulkAction!, assetIds: selectedAssetIds, scope: actionScope,
          expectedVersions: Object.fromEntries(selected.filter(item => item.version !== undefined).map(item => [item.contentAssetId, item.version])),
          expectedScheduledFor: Object.fromEntries(selected.filter(item => item.scheduledAt).map(item => [item.contentAssetId, item.scheduledAt])),
          ...(bulkAction === 'reschedule' ? { scheduledDate: bulkSchedule.date, scheduledTime: bulkSchedule.time, timezone: preferences.timezone } : {}),
        };
        intent = saveCalendarBulkIntent(calendarScope.current, payload);
        pendingBulkRef.current = intent;
        setPendingBulkIntent(intent);
      }
      if (!canReplayCalendarBulkIntent(intent)) throw new Error('This request is outside the server’s 24-hour replay window. Review current schedules; this action cannot be safely replayed.');
      const controller = new AbortController(); bulkRequest.current = controller;
      timeout = setTimeout(() => controller.abort(), 30_000);
      const result = await api.post<{ success?: boolean; inProgress?: boolean; affected?: number; action?: string }>('/api/content/calendar/bulk', intent.payload, {
        headers: { 'Idempotency-Key': intent.key }, signal: controller.signal,
      });
      if (!current()) return;
      if (result?.success !== true || result.action !== intent.payload.action || !Number.isSafeInteger(result.affected) || Number(result.affected) < 0) {
        toast({ title: 'Calendar action pending', description: 'The result is not confirmed. Retry the same action to recover its receipt.' });
        return;
      }
      try { clearCalendarBulkIntent(intent); }
      catch { setBulkRecoveryError('The change was confirmed, but recovery details could not be cleared. Reload to check the same receipt.'); }
      pendingBulkRef.current = null; setPendingBulkIntent(null);
      setSelectedAssetIds([]); setBulkAction(null);
      await refreshCurrentView.current(true);
      if (current()) toast({ title: intent.payload.action === 'cancel' ? 'Schedules cancelled' : 'Posts rescheduled' });
    } catch (error) {
      if (!current()) return;
      const status = (error as { status?: number })?.status;
      if (intent && status && [400, 401, 403, 404, 409, 422].includes(status)) {
        try { clearCalendarBulkIntent(intent); pendingBulkRef.current = null; setPendingBulkIntent(null); }
        catch { setBulkRecoveryError('Recovery details could not be cleared. Retry reading them before another action.'); }
      }
      toast({ title: intent ? 'Calendar action not confirmed' : 'Calendar action not submitted', description: error instanceof Error ? error.message : 'Keep this review and retry the same action.', variant: 'destructive' });
    } finally {
      if (timeout) clearTimeout(timeout);
      if (current()) { bulkRequest.current = null; setActionBusy(false); }
    }
  };

  const openBulkAction = (action: 'cancel' | 'reschedule', ids?: number[]) => {
    if (pendingBulkIntent || bulkRecoveryError) return;
    if (ids) setSelectedAssetIds(ids);
    setActionScope('single');
    setBulkAction(action);
  };

  const toggleSelection = (item: ContentItem) => {
    if (!item.contentAssetId || item.status !== 'scheduled') return;
    setSelectedAssetIds(ids => ids.includes(item.contentAssetId!) ? ids.filter(id => id !== item.contentAssetId) : [...ids, item.contentAssetId!]);
  };

  const recoverAttempt = async (item: ContentItem, attempt: PublishAttempt, action: 'retry' | 'reconcile' | 'publish_now') => {
    setActionBusy(true);
    try {
      await api.post(`/api/content/assets/${item.contentAssetId}/publish-attempts/${attempt.id}/recover`, { action, expectedVersion: item.version });
      await refreshCurrentView.current(true);
      toast({ title: action === 'retry' ? 'Retry requested' : action === 'publish_now' ? 'Publishing requested' : 'Provider status checked' });
    } catch (error) { toast({ title: 'Unable to update delivery', description: error instanceof Error ? error.message : 'Please try again.', variant: 'destructive' }); }
    finally { setActionBusy(false); }
  };

  const days = viewMode === 'month' ? getDaysInMonth(currentDate) : getWeekDays(currentDate);
  const weekDays = getWeekDays(currentDate);
  const selectedDayContent = getContentForDate(selectedDate);
  const selectedDayHasContent = selectedDate !== null && contentItems.some(item => item.scheduled_date === formatLocalDate(selectedDate));

  if (loading && !hasLoaded) {
    return <ContentCalendarSkeleton />;
  }

  if (loadError && !hasLoaded) {
    return <PageErrorState reset={() => loadContentItems()} title="We couldn’t load the content calendar" description={loadError} />;
  }

  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-6 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      {/* Header with Title, Navigation, and View Toggle */}
      <div className="space-y-4">
        {/* Title */}
        <PageHeader
          icon={CalendarIcon}
          title="Content calendar"
          subtitle={`Plan, review, and manage scheduled social publishing · ${preferences.timezone}`}
        />
        
        <div className="flex flex-wrap items-start gap-4">
          {/* Keep date controls together; let the actions wrap below when space is limited. */}
          <div className="grid w-full max-w-full shrink-0 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-2 sm:w-auto" role="group" aria-label="Calendar date navigation">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => viewMode === 'month' ? navigateMonth(-1) : navigateWeek(-1)}
              aria-label={`Previous ${viewMode}`}
              className="h-11 min-h-11 w-11 min-w-11 shrink-0"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-0 text-center text-lg font-medium [overflow-wrap:anywhere] sm:min-w-[160px]">
              {viewMode === 'month'
                ? `${months[currentDate.getMonth()]}, ${currentDate.getFullYear()}`
                : `Week of ${months[weekDays[0]?.getMonth() ?? 0]} ${weekDays[0]?.getDate()}, ${weekDays[0]?.getFullYear()}`
              }
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => viewMode === 'month' ? navigateMonth(1) : navigateWeek(1)}
              aria-label={`Next ${viewMode}`}
              className="h-11 min-h-11 w-11 min-w-11 shrink-0"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {/* Calendar actions and view toggle */}
          <div className="flex min-w-0 flex-1 basis-[36rem] flex-wrap items-center gap-2">
            <Button variant="outline" disabled={Boolean(pendingBulkIntent) || Boolean(bulkRecoveryError)} aria-pressed={selectionMode} onClick={() => { setSelectionMode(!selectionMode); setSelectedAssetIds([]); }}>{selectionMode ? 'Done selecting' : 'Select scheduled posts'}</Button>
            {selectedAssetIds.length > 0 && <><Button variant="outline" disabled={Boolean(pendingBulkIntent) || Boolean(bulkRecoveryError)} onClick={() => openBulkAction('reschedule')}>Reschedule {selectedAssetIds.length} selected</Button><Button variant="outline" disabled={Boolean(pendingBulkIntent) || Boolean(bulkRecoveryError)} onClick={() => openBulkAction('cancel')}>Cancel {selectedAssetIds.length} selected</Button></>}
            <Button variant="outline" onClick={() => setCurrentDate(dateInTimezone(new Date(), preferences.timezone))}>Today</Button>
            <Button
              onClick={() => openSocialPostCreator()}
            >
              <Plus className="w-4 h-4 mr-1" />
              Create Post
            </Button>
            <Select value={platformFilter} onValueChange={(value) => setPlatformFilter(value as typeof platformFilter)}>
              <SelectTrigger className="w-[145px]" aria-label="Filter by platform"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All platforms</SelectItem>
                <SelectItem value="instagram">Instagram</SelectItem>
                <SelectItem value="facebook">Facebook</SelectItem>
                <SelectItem value="youtube">YouTube</SelectItem>
                <SelectItem value="linkedin">LinkedIn</SelectItem>
                <SelectItem value="twitter">Twitter</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}>
              <SelectTrigger className="w-[135px]" aria-label="Filter by status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="planned">Planned</SelectItem>
                <SelectItem value="scheduled">Scheduled</SelectItem>
                <SelectItem value="processing">Publishing / processing</SelectItem>
                <SelectItem value="ambiguous">Needs provider check</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center bg-muted rounded-lg p-1">
              <button
                type="button"
                aria-pressed={viewMode === 'week'}
                onClick={() => setViewMode('week')}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  viewMode === 'week'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Weekly
              </button>
              <button
                type="button"
                aria-pressed={viewMode === 'month'}
                onClick={() => setViewMode('month')}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  viewMode === 'month'
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Monthly
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Keep the toolbar mounted across refreshes so focus follows the user's
          latest action without delayed focus restoration or stale response races. */}
      {refreshError && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 text-sm">
        <p>Calendar may be out of date. {refreshError} Loaded content is retained.</p>
        <Button variant="outline" onClick={() => void loadContentItems(true)}>Retry calendar refresh</Button>
      </div>}
      {!bulkAction && (pendingBulkIntent || bulkRecoveryError) && <div role="status" className="space-y-3 rounded-xl border border-border bg-card p-4 text-sm">
        {pendingBulkIntent && <>
          <p>This calendar action is not confirmed: {pendingBulkIntent.payload.action === 'cancel' ? 'cancel schedules' : 'reschedule posts'} for {pendingBulkIntent.payload.assetIds.length} selected destination(s).</p>
          <p className="text-muted-foreground">Closing a review or changing workspace does not cancel a submitted request. Retry uses the same reviewed action and key; it can submit that action if the original request never arrived.</p>
          <Button variant="outline" disabled={actionBusy || !canReplayCalendarBulkIntent(pendingBulkIntent)} onClick={() => void runBulkAction()}>Retry same calendar action</Button>
          {!canReplayCalendarBulkIntent(pendingBulkIntent) && <p>The server’s 24-hour replay window has ended. Review current schedules; this action cannot be safely replayed.</p>}
        </>}
        {bulkRecoveryError && <><p>{bulkRecoveryError}</p><Button variant="outline" onClick={restoreBulkIntent}>Retry recovery details</Button></>}
      </div>}
      {loading ? <ContentCalendarSkeleton /> : loadError ? (
        <PageErrorState reset={() => loadContentItems()} title="We couldn’t load the content calendar" description={loadError} />
      ) : <>
      {/* Month View Calendar Grid */}
      {viewMode === 'month' && (
        <Card
          className="overflow-x-auto"
          tabIndex={0}
          aria-label="Monthly calendar. Scroll horizontally to view all days."
        >
          <p className="border-b px-3 py-2 text-xs text-muted-foreground sm:hidden">Swipe horizontally to view all days.</p>
          <CardContent className="min-w-[840px] p-0">
            {/* Day Headers */}
            <div className="grid grid-cols-7 border-b">
              {daysOfWeek.map(day => (
                <div key={day} className="p-3 text-center text-sm font-medium text-muted-foreground border-r last:border-r-0">
                  {day}
                </div>
              ))}
            </div>
            
            {/* Calendar Days */}
            <div className="grid grid-cols-7">
              {days.map((date, index) => {
                const content = getContentForDate(date);
                const dayColor = getDayColor(content);
                const hasContent = content.length > 0;
                
                return (
                  <div 
                    key={date ? formatLocalDate(date) : `empty-${index}`}
                    onClick={() => handleDateClick(date)}
                    onDragOver={(event) => { if (date) event.preventDefault(); }}
                    onDrop={(event) => { event.preventDefault(); if (date) void dropOnDate(date, draggedItem); }}
                    role={date ? 'button' : undefined}
                    aria-label={date ? `View content for ${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}` : undefined}
                    tabIndex={date ? 0 : -1}
                    onKeyDown={(event) => {
                      if (date && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        handleDateClick(date);
                      }
                    }}
                    className={`min-h-[140px] p-3 border-r border-b last:border-r-0 cursor-pointer transition-colors ${
                      !date ? 'bg-muted/30' : hasContent ? dayColor.bg : 'bg-background hover:bg-muted/30'
                    } ${isToday(date) && !hasContent ? 'ring-2 ring-primary ring-inset' : ''} ${
                      selectedDate && date && date.toDateString() === selectedDate.toDateString() ? 'ring-2 ring-primary ring-inset' : ''
                    }`}
                  >
                    {date && (
                      <>
                        <div className={`text-sm font-semibold mb-3 ${
                          isToday(date) 
                            ? 'bg-primary text-primary-foreground w-6 h-6 rounded-full flex items-center justify-center' 
                            : hasContent ? dayColor.text : 'text-foreground'
                        }`}>
                          {date.getDate()}
                        </div>
                        {hasContent && (
                          <div className="space-y-2">
                            <div className={`inline-block rounded px-2 py-1 text-xs font-semibold ${dayColor.badge}`}>
                              {content.length} item{content.length > 1 ? 's' : ''}
                            </div>
                            <div className="space-y-1.5">
                              {content.slice(0, 2).map(item => (
                                <div 
                                  key={item.sourceKey}
                                  role="button"
                                  tabIndex={0}
                                  aria-label={`Open ${item.title}`}
                                  draggable={canMove(item)}
                                  onDragStart={(event) => { event.stopPropagation(); setDraggedItem(item); }}
                                  onClick={(event) => { event.stopPropagation(); handleDateClick(date); }}
                                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); handleDateClick(date); } }}
                                  className={`space-y-0.5 cursor-pointer ${item.contentAssetId && selectedAssetIds.includes(item.contentAssetId) ? 'ring-2 ring-primary rounded' : ''}`}
                                >
                                  {selectionMode && item.contentAssetId && item.status === 'scheduled' && <input type="checkbox" aria-label={`Select ${item.title}`} checked={selectedAssetIds.includes(item.contentAssetId)} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onChange={() => toggleSelection(item)} />}
                                  <div className={`line-clamp-2 text-xs font-semibold ${dayColor.text}`}>
                                    &quot;{item.title}&quot;
                                  </div>
                                  <div className={`text-xs opacity-75 ${dayColor.text}`}>
                                    {calendarTimeLabel(item)}
                                  </div>
                                </div>
                              ))}
                            </div>
                            {content.length > 2 && (
                              <div className={`text-xs font-medium ${dayColor.text}`}>
                                +{content.length - 2} more
                              </div>
                            )}
                            <div className="mt-2">
                              <span className={`inline-block rounded px-2 py-1 text-xs font-semibold ${dayColor.badge}`}>
                                {content[0].type.charAt(0).toUpperCase() + content[0].type.slice(1)}
                              </span>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Week View with Hourly Time Slots */}
      {viewMode === 'week' && (
        <Card
          className="overflow-x-auto"
          tabIndex={0}
          aria-label="Weekly calendar. Scroll horizontally to view all days."
        >
          <p className="border-b px-3 py-2 text-xs text-muted-foreground sm:hidden">Swipe horizontally to view all days.</p>
          <CardContent className="min-w-[980px] p-0">
            {/* Week Header - Days */}
            <div className="grid grid-cols-8 border-b sticky top-0 bg-background z-10">
              {/* Empty cell for time column */}
              <div className="p-3 border-r text-center text-sm font-medium text-muted-foreground w-20">
                Time
              </div>
              {/* Day columns */}
              {weekDays.map((date) => {
                const dayContent = getContentForDate(date);
                const dayColor = getDayColor(dayContent);
                const hasContent = dayContent.length > 0;
                
                return (
                  <button
                    type="button"
                    key={formatLocalDate(date)}
                    aria-label={`View content for ${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`}
                    className={`p-3 text-center border-r last:border-r-0 cursor-pointer transition-colors ${
                      hasContent ? dayColor.bg : 'bg-background hover:bg-muted/30'
                    } ${isToday(date) && !hasContent ? 'ring-2 ring-primary ring-inset' : ''}`}
                    onClick={() => handleDateClick(date)}
                  >
                    <span className={`block text-sm font-medium ${hasContent ? dayColor.text : 'text-muted-foreground'}`}>
                      {daysOfWeek[date.getDay()]}
                    </span>
                    <span className={`block text-lg font-semibold mt-1 ${
                      isToday(date) 
                        ? 'bg-primary text-primary-foreground w-8 h-8 rounded-full flex items-center justify-center mx-auto' 
                        : hasContent ? dayColor.text : ''
                    }`}>
                      {date.getDate()}
                    </span>
                  </button>
                );
              })}
            </div>
            
            {/* Hourly Grid */}
            <div className="max-h-[600px] overflow-y-auto">
              {hours.map(hour => (
                <div key={hour} className="grid grid-cols-8 border-b min-h-[60px]">
                  {/* Time Column */}
                  <div className="p-2 border-r text-xs text-muted-foreground text-right pr-3 pt-1 w-20">
                    {formatHour(hour)}
                  </div>
                  {/* Day Columns */}
                  {weekDays.map((date, dayIndex) => {
                    const eventsAtHour = getContentForDateAndHour(date, hour);
                    return (
                      <div 
                        key={dayIndex} 
                        data-calendar-slot={`${formatLocalDate(date)}T${String(hour).padStart(2, '0')}:00`}
                        className={`p-1.5 border-r last:border-r-0 relative ${
                          isToday(date) ? 'bg-primary/5' : ''
                        }`}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => { event.preventDefault(); dropOnDate(date, draggedItem, hour); }}
                      >
                        {eventsAtHour.map(item => {
                          const colors = typeColors[item.type as keyof typeof typeColors] || typeColors.post;
                          return (
                            <div 
                              key={item.sourceKey}
                              role="button"
                              tabIndex={0}
                              aria-label={`Open ${item.title}`}
                              draggable={canMove(item)}
                              onDragStart={(event) => { event.stopPropagation(); setDraggedItem(item); }}
                              className={`text-xs p-2 rounded-lg mb-1 cursor-grab hover:opacity-90 transition-opacity shadow-sm ${colors.bg} ${colors.border} ${item.contentAssetId && selectedAssetIds.includes(item.contentAssetId) ? 'ring-2 ring-primary' : ''}`}
                              title={`${item.title} - ${item.scheduled_time}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDateClick(date);
                              }}
                              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleDateClick(date); } }}
                            >
                              {selectionMode && item.contentAssetId && item.status === 'scheduled' && <input type="checkbox" aria-label={`Select ${item.title}`} checked={selectedAssetIds.includes(item.contentAssetId)} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onChange={() => toggleSelection(item)} />}
                              <div className={`font-semibold line-clamp-1 ${colors.text}`}>{item.title}</div>
                              <div className="mt-1 text-muted-foreground">{calendarTimeLabel(item)}</div>
                              <span className={`inline-block px-2 py-1 text-xs font-semibold ${colors.badge} mt-1`}>
                                {item.type.charAt(0).toUpperCase() + item.type.slice(1)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Day View Side Panel */}
      <Sheet open={sidePanelOpen} onOpenChange={setSidePanelOpen}>
        <SheetContent
          onCloseAutoFocus={event => {
            event.preventDefault();
            const active = document.activeElement;
            const closingDrawer = event.target;
            if (dayControl.current?.isConnected && (active === document.body || (closingDrawer instanceof HTMLElement && closingDrawer.contains(active)))) {
              dayControl.current.focus({ preventScroll: true });
            }
          }}
          className="flex h-dvh min-h-0 w-[calc(100vw-1rem)] max-w-[400px] flex-col overflow-hidden p-0 sm:w-full sm:max-w-[540px]"
        >
          <SheetHeader className="shrink-0 border-b px-6 py-6 pr-12">
            <SheetTitle className="flex items-center gap-2">
              <CalendarIcon className="h-5 w-5" />
              {selectedDate && (
                <span>
                  {months[selectedDate.getMonth()]} {selectedDate.getDate()}, {selectedDate.getFullYear()}
                </span>
              )}
            </SheetTitle>
            <SheetDescription>
              Posts and editorial plans for this day · {preferences.timezone}
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 py-5" data-testid="calendar-day-drawer-scroll-region">
            {selectedDate && (
              <Button
                onClick={() => openSocialPostCreator(selectedDate)}
                className="w-full"
              >
                <Plus className="w-4 h-4 mr-2" />
                Create Post for This Date
              </Button>
            )}

            {selectedDayContent.length > 0 ? (
              selectedDayContent.map(item => {
                const Icon = platformIcons[item.platform] || CalendarIcon;
                const colors = typeColors[item.type as keyof typeof typeColors] || typeColors.post;
                return (
                  <Card key={item.sourceKey} id={item.contentAssetId ? `calendar-asset-${item.contentAssetId}` : undefined} tabIndex={-1} className={`overflow-hidden ${colors.bg} ${linkedAssetId === item.contentAssetId ? 'ring-2 ring-primary' : ''}`}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3 flex-1">
                          <div className={`w-10 h-10 rounded-lg flex items-center justify-center border-2 ${colors.border} ${colors.text}`}>
                            <Icon className="h-5 w-5" />
                          </div>
                          <div className="flex-1">
                            <h4 className={`font-bold text-lg ${colors.text}`}>{item.title}</h4>
                            <div className="flex items-center gap-2 mt-2 text-sm flex-wrap">
                              <Clock className={`h-4 w-4 ${colors.text}`} />
                              <span className={`font-medium ${colors.text}`}>{item.scheduled_time}</span>
                              <Badge 
                                className={`${colors.badge}`}
                              >
                                {item.type.charAt(0).toUpperCase() + item.type.slice(1)}
                              </Badge>
                              <Badge variant="outline" className={colors.text}>{item.status === 'ambiguous' ? 'Needs provider check' : item.status === 'processing' ? 'Publishing / processing' : item.status.charAt(0).toUpperCase() + item.status.slice(1)}</Badge>
                              {item.platform === 'youtube' && <Badge variant="outline">{String(item.metadata?.privacyStatus || 'private')}</Badge>}
                            </div>
                            {!item.contentAssetId && <p className="mt-2 text-xs text-muted-foreground">Editorial plan only. Create and review a post to schedule delivery.</p>}
                            {item.platform === 'youtube' && item.status === 'scheduled' && <p className="mt-2 text-xs text-muted-foreground">Upload starts at this time; YouTube processing may finish later. Visibility is retained.</p>}
                            <p className={`text-sm mt-3 ${colors.text} opacity-85 leading-relaxed`}>
                              {item.content}
                            </p>
                            {item.contentAssetId && (() => {
                              const history = publishAttempts[item.contentAssetId] ?? item.publishAttempts;
                              const attempts = history || [];
                              const latest = attempts.at(-1);
                              return (
                                <>
                                {unavailableAttempts[item.contentAssetId] && <div className="mt-2 text-xs" role="status">
                                  <p>Publishing history unavailable. {latest ? 'Previously loaded history is shown below.' : 'Unable to confirm delivery history for this post.'}</p>
                                  <Button size="sm" variant="outline" className="mt-2" disabled={loadingAttempts} onClick={() => setHistoryRetry(current => current + 1)}>Retry publishing history</Button>
                                </div>}
                                {latest ? (
                                <div className="mt-3 rounded-md border bg-background/70 p-2 text-xs">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="font-medium capitalize">{latest.platform} delivery</span>
                                    <Badge variant={['failed', 'ambiguous'].includes(latest.status) ? 'destructive' : 'outline'}>{publishingStatusLabel(latest.status, item.status === 'scheduled')}</Badge>
                                  </div>
                                  <p className="mt-1 text-muted-foreground">Delivery attempts: {latest.attemptCount} of {latest.maxAttempts}</p>
                                  {latest.platform === 'youtube' && <p className="mt-1 text-muted-foreground">Visibility: {latest.reviewedPayload?.privacyStatus || String(item.metadata?.privacyStatus || 'private')}. {latest.status === 'provider_succeeded' ? 'Uploaded; YouTube is still processing.' : 'The scheduled time starts the upload; processing may finish later. Private and unlisted videos do not automatically become public.'}</p>}
                                  {latest.errorMessage && <p className="mt-1 text-destructive">{latest.errorCode ? `${latest.errorCode}: ` : ''}{latest.errorMessage}</p>}
                                  {latest.status === 'retryable_failed' && latest.nextAttemptAt && <p className="mt-1 text-muted-foreground">Next automatic retry: {new Date(latest.nextAttemptAt).toLocaleString('en-IN', { timeZone: preferences.timezone })} · {preferences.timezone}</p>}
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    {latest.capabilities?.retry && <Button size="sm" variant="outline" disabled={actionBusy} onClick={() => recoverAttempt(item, latest, 'retry')}>Retry this destination</Button>}
                                    {latest.capabilities?.reconcile && <Button size="sm" variant="outline" disabled={actionBusy} onClick={() => recoverAttempt(item, latest, 'reconcile')}>Check provider status</Button>}
                                    {latest.capabilities?.publishNow && <Button size="sm" variant="outline" disabled={actionBusy} onClick={() => setPublishNowConfirm({ item, attempt: latest })}>Publish this destination now</Button>}
                                    {latest.errorMessage && <Button size="sm" variant="outline" onClick={() => router.push(`/dashboard/integrations/${item.platform}`)}>Manage connected accounts</Button>}
                                  </div>
                                  {latest.providerPostUrl && (
                                    <a className="mt-1 inline-block text-primary hover:underline" href={latest.providerPostUrl} target="_blank" rel="noreferrer">View provider post</a>
                                  )}
                                  <details className="mt-2"><summary className="cursor-pointer font-medium">Delivery history ({attempts.length})</summary><ol className="mt-2 space-y-2">{[...attempts].reverse().map(attempt => <li key={attempt.id} className="border-t pt-2"><span className="capitalize">{attempt.status.replaceAll('_', ' ')}</span> · {attempt.attemptCount} provider attempt{attempt.attemptCount === 1 ? '' : 's'}{attempt.updatedAt && <div className="text-muted-foreground">{new Date(attempt.updatedAt).toLocaleString('en-IN', { timeZone: preferences.timezone })}</div>}{attempt.errorMessage && <div className="text-destructive">{attempt.errorMessage}</div>}</li>)}</ol></details>
                                </div>
                                ) : !unavailableAttempts[item.contentAssetId] && <p className="mt-2 text-xs text-muted-foreground">{history === undefined ? 'Loading publishing history…' : 'No publishing history yet.'}</p>}
                                </>
                              );
                            })()}
                          </div>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${item.title}`}>
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canMove(item) && (
                              <DropdownMenuItem onClick={() => openEdit(item)}>
                                <Edit className="mr-2 h-4 w-4" />
                                {item.contentAssetId ? 'Reschedule' : 'Edit plan'}
                              </DropdownMenuItem>
                            )}
                            {item.contentAssetId && item.status === 'scheduled' && <DropdownMenuItem onClick={() => openBulkAction('cancel', [item.contentAssetId!])} className="text-destructive">Cancel schedule</DropdownMenuItem>}
                            {(!item.contentAssetId || item.status === 'draft') && (
                              <DropdownMenuItem onClick={() => setDeleteConfirm({ open: true, item })} className="text-destructive">
                                <Trash2 className="mr-2 h-4 w-4" />
                                {item.contentAssetId ? 'Delete draft' : 'Delete plan'}
                              </DropdownMenuItem>
                            )}
                            {item.status === 'published' && item.metadata?.publishedUrl && (
                              <DropdownMenuItem asChild>
                                <a href={item.metadata.publishedUrl} target="_blank" rel="noreferrer">View published post</a>
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <CalendarIcon className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="font-medium">{selectedDayHasContent ? 'No content matches your filters' : 'No content scheduled'}</p>
                <p className="text-sm mt-1">{selectedDayHasContent ? 'Content exists for this date. Clear filters to view it.' : 'Create a post or choose another date.'}</p>
                {selectedDayHasContent && <Button variant="outline" className="mt-4" onClick={() => { setPlatformFilter('all'); setStatusFilter('all'); }}>Clear filters</Button>}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={Boolean(editingItem)} onOpenChange={(open) => { if (!open) setEditingItem(null); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingItem?.contentAssetId ? 'Confirm reschedule' : 'Edit editorial plan'}</DialogTitle>
            <DialogDescription>
              {editingItem?.contentAssetId
                ? `Review the new publishing time in ${preferences.timezone} before saving.`
                : 'Update the title, copy, or scheduled time.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {editingItem?.contentAssetId && <div className="space-y-2"><Label>Apply changes to</Label><Select value={actionScope} onValueChange={value => setActionScope(value as typeof actionScope)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="single">This destination only ({editingItem.platform})</SelectItem><SelectItem value="group">All destinations for this post</SelectItem></SelectContent></Select><p className="text-xs text-muted-foreground">{actionScope === 'single' ? 'Other destinations keep their current schedules.' : 'All related pending destinations will move together. Active or completed deliveries cannot be moved.'}</p></div>}
            <div className="space-y-2">
              <Label htmlFor="calendar-edit-title">Title</Label>
              <Input id="calendar-edit-title" value={editForm.title} disabled={Boolean(editingItem?.contentAssetId)} onChange={(event) => setEditForm((form) => ({ ...form, title: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="calendar-edit-content">Content</Label>
              <Textarea id="calendar-edit-content" rows={5} value={editForm.content} disabled={Boolean(editingItem?.contentAssetId)} onChange={(event) => setEditForm((form) => ({ ...form, content: event.target.value }))} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="calendar-edit-date">Date</Label>
                <Input id="calendar-edit-date" type="date" value={editForm.scheduledDate} onChange={(event) => setEditForm((form) => ({ ...form, scheduledDate: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="calendar-edit-time">Time</Label>
                <Input id="calendar-edit-time" type="time" value={editForm.scheduledTime} onChange={(event) => setEditForm((form) => ({ ...form, scheduledTime: event.target.value }))} />
              </div>
            </div>
            <div className="sticky -bottom-6 flex justify-end gap-2 border-t bg-background py-4">
              <Button variant="outline" onClick={() => setEditingItem(null)}>Cancel</Button>
              <Button onClick={saveEdit} disabled={savingEdit || !editForm.title.trim() || !editForm.scheduledDate}>
                {savingEdit ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(bulkAction)} onOpenChange={open => { if (!open && !actionBusy) setBulkAction(null); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>{bulkAction === 'cancel' ? 'Cancel schedules' : 'Reschedule posts'}</DialogTitle><DialogDescription>Review changes for {selectedAssetIds.length} selected destination{selectedAssetIds.length === 1 ? '' : 's'}.</DialogDescription></DialogHeader>
          <div className="space-y-4">
            {pendingBulkIntent && <div role="status" className="space-y-3 rounded-lg border border-border p-3 text-sm">
              <p>This calendar action is not confirmed. The reviewed values and request key are retained.</p>
              <p className="text-muted-foreground">Retry uses the same reviewed action and key; it can submit that action if the original request never arrived. Closing this review does not cancel a submitted request.</p>
              <Button variant="outline" disabled={actionBusy || !canReplayCalendarBulkIntent(pendingBulkIntent)} onClick={() => void runBulkAction()}>Retry same calendar action</Button>
              {!canReplayCalendarBulkIntent(pendingBulkIntent) && <p>The server’s 24-hour replay window has ended. Review current schedules; this action cannot be safely replayed.</p>}
            </div>}
            {bulkRecoveryError && <p role="alert">{bulkRecoveryError}</p>}
            <div className="space-y-2"><Label>Apply changes to</Label><Select value={actionScope} disabled={Boolean(pendingBulkIntent)} onValueChange={value => setActionScope(value as typeof actionScope)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="single">Selected destinations only</SelectItem><SelectItem value="group">All destinations for these posts</SelectItem></SelectContent></Select></div>
            <p className="text-sm text-muted-foreground">{actionScope === 'single' ? 'Other destinations keep their schedules.' : 'All related pending destinations will be included. Active or completed deliveries cannot be changed.'}</p>
            {bulkAction === 'reschedule' && <><div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="bulk-date">Date</Label><Input id="bulk-date" disabled={Boolean(pendingBulkIntent)} type="date" value={bulkSchedule.date} onChange={event => setBulkSchedule(current => ({ ...current, date: event.target.value }))} /></div><div className="space-y-2"><Label htmlFor="bulk-time">Time</Label><Input id="bulk-time" disabled={Boolean(pendingBulkIntent)} type="time" value={bulkSchedule.time} onChange={event => setBulkSchedule(current => ({ ...current, time: event.target.value }))} /></div></div><p className="text-xs text-muted-foreground">{preferences.timezone}. Only one post per platform can occupy this time; conflicts leave the selection unchanged.</p></>}
            <div className="sticky -bottom-6 flex justify-end gap-2 border-t bg-background py-4"><Button variant="outline" disabled={actionBusy} onClick={() => setBulkAction(null)}>Back</Button><Button variant={bulkAction === 'cancel' ? 'destructive' : 'default'} disabled={actionBusy || Boolean(pendingBulkIntent) || (bulkAction === 'reschedule' && !bulkSchedule.date)} onClick={runBulkAction}>{actionBusy ? 'Updating…' : bulkAction === 'cancel' ? 'Cancel schedules' : 'Confirm reschedule'}</Button></div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(publishNowConfirm)}
        onOpenChange={open => { if (!open) setPublishNowConfirm(null); }}
        onConfirm={() => { if (publishNowConfirm) void recoverAttempt(publishNowConfirm.item, publishNowConfirm.attempt, 'publish_now'); setPublishNowConfirm(null); }}
        title="Publish this destination now?"
        description={`Publish the reviewed content for ${publishNowConfirm?.item.platform || 'this destination'} immediately. Other destinations keep their schedules.`}
        confirmText="Publish now"
      />

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm(prev => ({ ...prev, open }))}
        onConfirm={() => deleteConfirm.item && handleDelete(deleteConfirm.item.id)}
        title="Delete Content"
        description={`Are you sure you want to delete "${deleteConfirm.item?.title || 'this content'}"? This action cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />
      </>}
    </div>
  );
}
