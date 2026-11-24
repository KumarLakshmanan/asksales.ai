"use client";

import { useMemo, useState, useRef } from "react";
import {
  AlertTriangle,
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  CreditCard,
  Eye,
  Phone,
  User,
  Users,
} from "lucide-react";
import { api } from "@/lib/api";
import { usePreferences } from "@/contexts/PreferencesContext";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SearchInput } from "@/components/ui/search-input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { type HotelBooking as Booking, type HotelConfirmationRecovery } from "@/hooks/use-hotel-data";

import { confirmedHotelRevenue, formatHotelAmount, hotelRevenueDisplay } from "@/lib/hotel-money";

interface BookingsTabProps {
  currency?: string;
  bookings: Booking[];
  timezone: string;
  onRefresh: () => Promise<void> | void;
}

type SortField = "guest_name" | "check_in_date" | "total_price" | "status" | "created_at";
type SortDir = "asc" | "desc";

const BOOKING_STATUS_TONES: Record<string, StatusTone> = {
  confirmed: "success",
  pending_payment: "warning",
  cancelled: "danger",
  expired: "neutral",
  inquiry: "info",
};

const day = (value: string) => String(value || "").slice(0, 10);

export function BookingsTab({ bookings, timezone, currency, onRefresh }: BookingsTabProps) {
  const { toast } = useToast();
  const { preferences, formatCurrency } = usePreferences();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortField, setSortField] = useState<SortField>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<Booking | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Booking | null>(null);
  const [cancellationReason, setCancellationReason] = useState("");
  const [workingId, setWorkingId] = useState<number | null>(null);
  const opener = useRef<{ id: number; button: HTMLButtonElement } | null>(null);
  const viewButtons = useRef(new Map<number, HTMLButtonElement>());
  const restoreDialogFocus = (event: Event) => {
    event.preventDefault();
    const target = opener.current;
    (target?.button.isConnected ? target.button : target && viewButtons.current.get(target.id))?.focus();
    opener.current = null;
  };

  const filteredBookings = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    const result = bookings.filter((booking) => {
      const matchesSearch = !normalizedSearch
        || booking.guest_name?.toLowerCase().includes(normalizedSearch)
        || booking.guest_phone?.toLowerCase().includes(normalizedSearch)
        || booking.room_type?.toLowerCase().includes(normalizedSearch)
        || String(booking.id).includes(normalizedSearch);
      return matchesSearch && (statusFilter === "all" || booking.status === statusFilter);
    });
    return [...result].sort((a, b) => {
      const values: Record<SortField, [string | number, string | number]> = {
        guest_name: [a.guest_name || "", b.guest_name || ""],
        check_in_date: [a.check_in_date, b.check_in_date],
        total_price: [Number(a.total_price), Number(b.total_price)],
        status: [a.status, b.status],
        created_at: [a.created_at, b.created_at],
      };
      const [left, right] = values[sortField];
      const comparison = left === right ? 0 : left > right ? 1 : -1;
      return sortDir === "asc" ? comparison : -comparison;
    });
  }, [bookings, searchQuery, sortDir, sortField, statusFilter]);

  const confirmed = bookings.filter((booking) => booking.status === "confirmed");
  const revenue = hotelRevenueDisplay(confirmedHotelRevenue(bookings), currency, formatCurrency);

  const displayDate = (value: string) => {
    const dateValue = day(value);
    if (!dateValue) return "—";
    return new Date(`${dateValue}T12:00:00.000Z`).toLocaleDateString(preferences.locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  };

  const displayDateTime = (value: string) => new Date(value).toLocaleString(preferences.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir((current) => current === "asc" ? "desc" : "asc");
    else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const confirmBooking = async () => {
    if (!confirmTarget) return;
    setWorkingId(confirmTarget.id);
    try {
      const result = await api.put<{ confirmationRecovery?: HotelConfirmationRecovery }>(`/api/hotel/bookings/${confirmTarget.id}/confirm`, {});
      const unfinished = result?.confirmationRecovery && result.confirmationRecovery.state !== 'complete';
      toast({ title: unfinished ? "Booking confirmed; setup needs attention" : "Booking confirmed",
        description: unfinished ? "The reservation is confirmed. Review the unfinished confirmation setup below." : "Inventory and payment status were updated." });
      await onRefresh();
      setConfirmTarget(null);
    } catch (error) {
      toast({
        title: "Confirmation failed",
        description: error instanceof Error ? error.message : "Unable to confirm this booking.",
        variant: "destructive",
      });
    } finally {
      setWorkingId(null);
    }
  };

  const cancelBooking = async () => {
    if (!cancelTarget || !cancellationReason.trim()) return;
    setWorkingId(cancelTarget.id);
    try {
      await api.put(`/api/hotel/bookings/${cancelTarget.id}/cancel`, {
        reason: cancellationReason.trim(),
      });
      toast({
        title: "Booking cancelled",
        description: cancelTarget.payment_status === "paid"
          ? "Inventory was restored and the payment is marked for refund reconciliation."
          : "The inventory hold was released.",
      });
      await onRefresh();
      setCancelTarget(null);
      setCancellationReason("");
    } catch (error) {
      toast({
        title: "Cancellation failed",
        description: error instanceof Error ? error.message : "Unable to cancel this booking.",
        variant: "destructive",
      });
    } finally {
      setWorkingId(null);
    }
  };

  const retrySetup = async (booking: Booking) => {
    if (workingId !== null || !booking.confirmation_recovery?.canRetry) return;
    setWorkingId(booking.id);
    try {
      const result = await api.post<{ confirmationRecovery: HotelConfirmationRecovery }>(`/api/hotel/bookings/${booking.id}/recovery`, {});
      toast({ title: result.confirmationRecovery.state === 'complete' ? 'Confirmation setup complete' : 'Confirmation setup still needs attention',
        description: 'This action does not capture payment, issue a refund, or resend a guest confirmation.' });
      await onRefresh();
    } catch (error) {
      toast({ title: 'Setup retry could not be confirmed', description: error instanceof Error ? error.message : 'Reload the booking to review its current setup state.', variant: 'destructive' });
    } finally { setWorkingId(null); }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDir === "asc"
      ? <ChevronUp className="ml-1 h-3 w-3" />
      : <ChevronDown className="ml-1 h-3 w-3" />;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput
          aria-label="Search bookings"
          placeholder="Search guest, phone, room, or ID"
          value={searchQuery}
          onValueChange={setSearchQuery}
          wrapperClassName="w-full sm:max-w-sm"
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-10 w-full sm:w-44" aria-label="Filter booking status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
            <SelectItem value="pending_payment">Pending payment</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="overflow-hidden border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px]">
            <thead>
              <tr className="border-b bg-muted/30">
                {([
                  ["guest_name", "Guest"],
                  ["check_in_date", "Stay"],
                  ["total_price", "Total"],
                  ["status", "Status"],
                ] as Array<[SortField, string]>).map(([field, label]) => (
                  <th key={field} className="p-3 text-left text-xs font-semibold text-muted-foreground">
                    <button type="button" className="flex items-center hover:text-foreground" onClick={() => handleSort(field)}>
                      {label}<SortIcon field={field} />
                    </button>
                  </th>
                ))}
                <th className="p-3 text-left text-xs font-semibold text-muted-foreground">Room / occupancy</th>
                <th className="p-3 text-left text-xs font-semibold text-muted-foreground">Payment</th>
                <th className="p-3 text-right text-xs font-semibold text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredBookings.map((booking) => (
                <tr key={booking.id} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="p-3">
                    <p className="text-sm font-medium">{booking.guest_name || "Guest not provided"}</p>
                    <p className="text-xs text-muted-foreground">#{booking.id}{booking.guest_phone ? ` · ${booking.guest_phone}` : ""}</p>
                  </td>
                  <td className="p-3">
                    <p className="text-sm">{displayDate(booking.check_in_date)} – {displayDate(booking.check_out_date)}</p>
                    <p className="text-xs text-muted-foreground">{booking.nights} night{booking.nights === 1 ? "" : "s"}</p>
                  </td>
                  <td className="p-3 text-sm font-medium">
                    {formatHotelAmount(Number(booking.total_price), booking.currency, formatCurrency)}
                  </td>
                  <td className="p-3">
                    <StatusBadge status={booking.status} toneOverrides={BOOKING_STATUS_TONES} />
                  </td>
                  <td className="p-3">
                    <p className="text-sm">{booking.room_type || "Deleted room type"}</p>
                    <p className="text-xs text-muted-foreground">
                      {booking.number_of_guests} guest{booking.number_of_guests === 1 ? "" : "s"} · {booking.number_of_rooms} room{booking.number_of_rooms === 1 ? "" : "s"}
                    </p>
                  </td>
                  <td className="p-3">
                    <Badge variant="outline">{booking.payment_status.replaceAll("_", " ")}</Badge>
                    {booking.payment_provider && <p className="mt-1 text-xs text-muted-foreground">{booking.payment_provider}</p>}
                    {booking.confirmation_recovery && !['complete', 'not_applicable'].includes(booking.confirmation_recovery.state) && (
                      <p className="mt-2 text-xs text-warning" role="status">
                        {booking.confirmation_recovery.state === 'in_progress' ? 'Confirmation setup in progress'
                          : booking.confirmation_recovery.state === 'needs_review' ? (booking.confirmation_recovery.step === 'alert' ? 'Alert delivery needs review' : 'Confirmation setup needs review')
                            : `Confirmation setup unfinished${booking.confirmation_recovery.step ? `: ${booking.confirmation_recovery.step}` : ''}`}
                      </p>
                    )}
                  </td>
                  <td className="p-3">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-9 w-9"
                        aria-label={`View booking ${booking.id}`}
                        ref={(button) => { if (button) viewButtons.current.set(booking.id, button); else viewButtons.current.delete(booking.id); }}
                        onClick={(event) => { opener.current = { id: booking.id, button: event.currentTarget }; setSelectedBooking(booking); }}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {booking.status === "pending_payment" && (
                        <Button type="button" size="sm" onClick={(event) => { opener.current = { id: booking.id, button: event.currentTarget }; setConfirmTarget(booking); }}>
                          Confirm paid
                        </Button>
                      )}
                      {(booking.status === "pending_payment" || booking.status === "confirmed") && (
                        <Button type="button" size="sm" variant="outline" onClick={(event) => { opener.current = { id: booking.id, button: event.currentTarget }; setCancelTarget(booking); }}>
                          Cancel
                        </Button>
                      )}
                      {booking.status === 'confirmed' && booking.confirmation_recovery?.canRetry && (
                        <Button type="button" size="sm" variant="outline" aria-label={`Retry confirmation setup for booking ${booking.id}`}
                          title="Resume unfinished setup through the existing confirmation workflow. Uncertain alert outcomes remain held for review."
                          disabled={workingId !== null} onClick={() => void retrySetup(booking)}>Retry setup</Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {filteredBookings.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-14 text-center">
          <ClipboardList className="mb-3 h-9 w-9 text-muted-foreground" />
          <h3 className="text-base font-semibold">No bookings found</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {searchQuery || statusFilter !== "all" ? "Clear or adjust the filters." : "Guest reservations will appear here."}
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Total bookings", bookings.length],
          ["Confirmed", confirmed.length],
          ["Pending payment", bookings.filter((booking) => booking.status === "pending_payment").length],
          [
            "Confirmed revenue",
            revenue,
          ],
        ].map(([label, value]) => (
          <Card key={String(label)} className="border">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-1 text-lg font-semibold">{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!selectedBooking} onOpenChange={(open) => !open && setSelectedBooking(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" onCloseAutoFocus={restoreDialogFocus}>
          <DialogHeader>
            <DialogTitle>Booking #{selectedBooking?.id}</DialogTitle>
            <DialogDescription>Persisted guest, stay, inventory, and payment details.</DialogDescription>
          </DialogHeader>
          {selectedBooking && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  [User, "Guest", selectedBooking.guest_name || "Not provided"],
                  [Phone, "Phone", selectedBooking.guest_phone || "Not provided"],
                  [Calendar, "Stay", `${displayDate(selectedBooking.check_in_date)} – ${displayDate(selectedBooking.check_out_date)}`],
                  [Users, "Occupancy", `${selectedBooking.number_of_guests} guests · ${selectedBooking.number_of_rooms} rooms`],
                  [CreditCard, "Total", formatHotelAmount(Number(selectedBooking.total_price), selectedBooking.currency, formatCurrency)],
                ].map(([Icon, label, value]) => {
                  const DetailIcon = Icon as typeof User;
                  return (
                    <div key={String(label)} className="flex gap-3 rounded-lg border bg-muted/20 p-3">
                      <DetailIcon className="mt-0.5 h-4 w-4 text-muted-foreground" />
                      <div>
                        <p className="text-xs text-muted-foreground">{String(label)}</p>
                        <p className="text-sm font-medium">{String(value)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-2">
                <StatusBadge status={selectedBooking.status} toneOverrides={BOOKING_STATUS_TONES} />
                <Badge variant="outline">{selectedBooking.payment_status.replaceAll("_", " ")}</Badge>
              </div>
              {selectedBooking.hold_expires_at && selectedBooking.status === "pending_payment" && (
                <p className="text-sm text-muted-foreground">
                  Inventory hold expires {displayDateTime(selectedBooking.hold_expires_at)}.
                </p>
              )}
              {selectedBooking.cancellation_reason && (
                <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                  <p className="text-xs font-medium text-destructive">Cancellation reason</p>
                  <p className="mt-1 text-sm">{selectedBooking.cancellation_reason}</p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">Created {displayDateTime(selectedBooking.created_at)}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmTarget} onOpenChange={(open) => !open && setConfirmTarget(null)}>
        <DialogContent className="sm:max-w-md" onCloseAutoFocus={restoreDialogFocus}>
          <DialogHeader>
            <DialogTitle>Confirm payment received?</DialogTitle>
            <DialogDescription>
              Use this only after verifying an offline/manual payment. The booking will become confirmed and the guest may receive a confirmation on the original channel.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmTarget(null)}>Back</Button>
            <Button type="button" onClick={() => void confirmBooking()} loading={workingId === confirmTarget?.id} loadingText="Confirming…">
              <Check className="mr-2 h-4 w-4" />
              Confirm paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!cancelTarget} onOpenChange={(open) => {
        if (!open) {
          setCancelTarget(null);
          setCancellationReason("");
        }
      }}>
        <DialogContent className="sm:max-w-md" onCloseAutoFocus={restoreDialogFocus}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Cancel booking #{cancelTarget?.id}?
            </DialogTitle>
            <DialogDescription>
              Inventory will be restored once. A paid booking is marked “refund pending”; this action does not issue a provider refund.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="hotel-cancellation-reason">Cancellation reason</Label>
            <Textarea
              id="hotel-cancellation-reason"
              value={cancellationReason}
              onChange={(event) => setCancellationReason(event.target.value)}
              maxLength={1000}
              placeholder="Record why this reservation is being cancelled"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCancelTarget(null)}>Keep booking</Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void cancelBooking()}
              disabled={!cancellationReason.trim()}
              loading={workingId === cancelTarget?.id}
              loadingText="Cancelling…"
            >
              Cancel booking
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
