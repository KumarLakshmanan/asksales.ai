"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Save,
  Check,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";
import { formatHotelAmount } from "@/lib/hotel-money";
import { usePreferences } from "@/contexts/PreferencesContext";
import { dateKeyInTimezone } from "@/lib/timezone";

import { useHotelAvailability, type HotelRoomType as RoomType, type HotelAvailability as Availability } from "@/hooks/use-hotel-data";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";

interface AvailabilityTabProps {
  roomTypes: RoomType[];
  currency?: string;
  timezone: string;
}

const day = (d: string) => (d ? String(d).slice(0, 10) : "");

export function AvailabilityTab({
  roomTypes,
  currency,
  timezone,
}: AvailabilityTabProps) {
  const { toast } = useToast();
  const { preferences, formatCurrency } = usePreferences();
  const [selectedRoomType, setSelectedRoomType] = useState<string>("all");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [editingCell, setEditingCell] = useState<{ roomTypeId: number; date: string } | null>(null);
  const [editValue, setEditValue] = useState({ availableCount: "", pricePerNight: "" });
  const [saving, setSaving] = useState(false);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!editingCell && returnFocus.current) {
      editButtons.current.get(returnFocus.current)?.focus();
      returnFocus.current = null;
    }
  }, [editingCell]);

  // Set availability form
  const [showSetForm, setShowSetForm] = useState(false);
  const [setForm, setSetForm] = useState({
    roomTypeId: "",
    from: dateKeyInTimezone(new Date(), timezone),
    to: dateKeyInTimezone(new Date(Date.now() + 30 * 864e5), timezone),
    availableCount: "5",
    pricePerNight: "",
  });

  // Generate calendar days for the current week
  const calendarDays = useMemo(() => {
    const start = new Date(`${dateKeyInTimezone(currentDate, timezone)}T12:00:00Z`);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay()); // Start from Sunday in the property timezone
    const days = [];
    for (let i = 0; i < 14; i++) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + i);
      days.push(date.toISOString().slice(0, 10));
    }
    return days;
  }, [currentDate, timezone]);

  const availabilityQuery = useHotelAvailability(calendarDays[0], calendarDays[calendarDays.length - 1], timezone);
  const availability = useMemo(() => availabilityQuery.data?.availability ?? [], [availabilityQuery.data]);

  // Filter availability by selected room type
  const filteredAvailability = useMemo(() => {
    if (selectedRoomType === "all") return availability;
    return availability.filter((a) => a.room_type_id === Number(selectedRoomType));
  }, [availability, selectedRoomType]);

  // Create availability map for quick lookup
  const availabilityMap = useMemo(() => {
    const map = new Map<string, Availability>();
    filteredAvailability.forEach((a) => {
      map.set(`${a.room_type_id}-${day(a.date)}`, a);
    });
    return map;
  }, [filteredAvailability]);

  // Get unique room types from availability
  const displayRoomTypes = useMemo(() => {
    if (selectedRoomType !== "all") {
      return roomTypes.filter((rt) => rt.id === Number(selectedRoomType));
    }
    return roomTypes;
  }, [roomTypes, selectedRoomType]);

  const startEditing = (roomTypeId: number, date: string, current: Availability | undefined) => {
    setEditingCell({ roomTypeId, date });
    setEditValue({
      // The API accepts total capacity and subtracts reservations under lock.
      availableCount: current?.total_count.toString() || "0",
      pricePerNight: current?.price_per_night || "",
    });
  };

  const cancelEditing = () => {
    if (editingCell) returnFocus.current = `${editingCell.roomTypeId}-${editingCell.date}`;
    setEditingCell(null);
    setEditValue({ availableCount: "", pricePerNight: "" });
  };

  const saveCell = async () => {
    if (!editingCell) return;
    if (
      !Number.isInteger(Number(editValue.availableCount))
      || Number(editValue.availableCount) < 0
      || !Number.isFinite(Number(editValue.pricePerNight))
      || Number(editValue.pricePerNight) < 0
    ) {
      toast({ title: "Enter a non-negative total inventory and nightly price", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await api.post("/api/hotel/availability", {
        roomTypeId: editingCell.roomTypeId,
        from: editingCell.date,
        to: editingCell.date,
        availableCount: Number(editValue.availableCount),
        pricePerNight: Number(editValue.pricePerNight),
      });
      toast({ title: "Availability updated" });
      cancelEditing();
      await availabilityQuery.invalidate("availability");
    } catch (error) {
      toast({ title: "Update failed", description: error instanceof Error ? error.message : "Unable to update availability.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const applyAvailability = async () => {
    if (!setForm.roomTypeId || !setForm.pricePerNight) {
      toast({ title: "Pick a room type and price", variant: "destructive" });
      return;
    }
    if (
      setForm.to < setForm.from
      || !Number.isInteger(Number(setForm.availableCount))
      || Number(setForm.availableCount) < 0
      || Number(setForm.pricePerNight) < 0
    ) {
      toast({ title: "Check the date range, inventory, and price", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const r = await api.post<{ daysUpdated: number }>("/api/hotel/availability", {
        roomTypeId: Number(setForm.roomTypeId),
        from: setForm.from,
        to: setForm.to,
        availableCount: Number(setForm.availableCount),
        pricePerNight: Number(setForm.pricePerNight),
      });
      toast({ title: `Availability updated for ${r.daysUpdated} day(s)` });
      setShowSetForm(false);
      await availabilityQuery.invalidate("availability");
    } catch (error) {
      toast({ title: "Update failed", description: error instanceof Error ? error.message : "Unable to update availability.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const navigateWeek = (direction: "prev" | "next") => {
    const newDate = new Date(currentDate);
    newDate.setDate(newDate.getDate() + (direction === "next" ? 14 : -14));
    setCurrentDate(newDate);
  };

  const getAvailabilityColor = (count: number) => {
    if (count === 0) return "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400";
    if (count <= 2) return "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400";
    return "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400";
  };

  return (
    <div className="space-y-4">
      {availabilityQuery.isError && <Callout tone="danger" actions={<Button type="button" variant="outline" onClick={() => void availabilityQuery.refetch()}>Retry</Button>}>Availability could not be loaded.</Callout>}
      {availabilityQuery.isLoading && <LoadingState size="section" label="Loading availability…" />}
      <div className={availabilityQuery.isError || availabilityQuery.isLoading ? "pointer-events-none opacity-50" : undefined} inert={availabilityQuery.isError || availabilityQuery.isLoading}>
      {/* Header Actions */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2">
          <Select value={selectedRoomType} onValueChange={setSelectedRoomType}>
            <SelectTrigger className="w-48 h-9">
              <SelectValue placeholder="All Room Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Room Types</SelectItem>
              {roomTypes.map((rt) => (
                <SelectItem key={rt.id} value={String(rt.id)}>
                  {rt.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setShowSetForm(!showSetForm)} className="h-9 gap-1.5 bg-violet-600 hover:bg-violet-700">
          <CalendarDays className="w-3.5 h-3.5" />
          Set Availability
        </Button>
      </div>

      {/* Set Availability Form */}
      {showSetForm && (
        <Card className="rounded-xl border border-violet-200 dark:border-violet-800">
          <CardContent className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
              <div className="col-span-2">
                <Label className="text-xs">Room Type</Label>
                <Select value={setForm.roomTypeId} onValueChange={(v) => setSetForm({ ...setForm, roomTypeId: v })}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select room type" />
                  </SelectTrigger>
                  <SelectContent>
                    {roomTypes.map((rt) => (
                      <SelectItem key={rt.id} value={String(rt.id)}>
                        {rt.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">From</Label>
                <Input
                  type="date"
                  value={setForm.from}
                  onChange={(e) => setSetForm({ ...setForm, from: e.target.value })}
                  className="h-9"
                />
              </div>
              <div>
                <Label className="text-xs">To</Label>
                <Input
                  type="date"
                  value={setForm.to}
                  onChange={(e) => setSetForm({ ...setForm, to: e.target.value })}
                  className="h-9"
                />
              </div>
              <div>
                <Label className="text-xs">Total rooms</Label>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  value={setForm.availableCount}
                  onChange={(e) => setSetForm({ ...setForm, availableCount: e.target.value })}
                  className="h-9"
                />
              </div>
              <div>
                <Label className="text-xs">Price/night</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={setForm.pricePerNight}
                  onChange={(e) => setSetForm({ ...setForm, pricePerNight: e.target.value })}
                  className="h-9"
                />
              </div>
              <div className="col-span-2 md:col-span-6 flex gap-2">
                <Button onClick={applyAvailability} loading={saving} loadingText="Applying…" className="h-9 gap-1.5">
                  <Save className="w-3.5 h-3.5" />
                  Apply
                </Button>
                <Button variant="ghost" onClick={() => setShowSetForm(false)} className="h-9">
                  Cancel
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Calendar Navigation */}
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={() => navigateWeek("prev")} className="h-9 gap-1">
          <ChevronLeft className="w-4 h-4" />
          Previous
        </Button>
        <h3 className="text-sm font-semibold">
          {new Date(`${calendarDays[0]}T12:00:00Z`).toLocaleDateString(preferences.locale, { month: "short", day: "numeric", timeZone: "UTC" })} –{" "}
          {new Date(`${calendarDays[calendarDays.length - 1]}T12:00:00Z`).toLocaleDateString(preferences.locale, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}
        </h3>
        <Button variant="outline" size="sm" onClick={() => navigateWeek("next")} className="h-9 gap-1">
          Next
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      {/* Calendar Grid */}
      <Card className="rounded-xl border border-border/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px]">
            <thead>
              <tr className="border-b border-border/50">
                <th className="sticky left-0 bg-background p-3 text-left text-xs font-semibold text-muted-foreground z-10">
                  Room Type
                </th>
                {calendarDays.map((date) => {
                  const d = new Date(`${date}T12:00:00Z`);
                  const isToday = date === dateKeyInTimezone(new Date(), timezone);
                  return (
                    <th
                      key={date}
                      className={`p-3 text-center text-xs font-semibold min-w-[100px] ${
                        isToday ? "bg-violet-50 dark:bg-violet-950/20 text-violet-600" : "text-muted-foreground"
                      }`}
                    >
                      <div>{d.toLocaleDateString(preferences.locale, { weekday: "short", timeZone: "UTC" })}</div>
                      <div className="text-xs">{d.toLocaleDateString(preferences.locale, { month: "short", day: "numeric", timeZone: "UTC" })}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {displayRoomTypes.map((rt) => (
                <tr key={rt.id} className="border-b border-border/30 hover:bg-muted/20">
                  <td className="sticky left-0 bg-background p-3 text-sm font-medium z-10">
                    {rt.name}
                  </td>
                  {calendarDays.map((date) => {
                    const key = `${rt.id}-${date}`;
                    const avail = availabilityMap.get(key);
                    const isEditing = editingCell?.roomTypeId === rt.id && editingCell?.date === date;
                    const isToday = date === dateKeyInTimezone(new Date(), timezone);

                    return (
                      <td
                        key={date}
                        className={`p-2 text-center ${
                          isToday ? "bg-violet-50/50 dark:bg-violet-950/10" : ""
                        }`}
                      >
                        {isEditing ? (
                          <div className="space-y-1" onKeyDown={(event) => {
                            if (event.key === "Escape") { event.preventDefault(); cancelEditing(); }
                          }}>
                            <Input
                              autoFocus
                              aria-label={`Total rooms for ${rt.name} on ${date}`}
                              type="number"
                              min={0}
                              step={1}
                              value={editValue.availableCount}
                              onChange={(e) => setEditValue({ ...editValue, availableCount: e.target.value })}
                              className="h-7 text-xs w-full"
                              placeholder="Count"
                            />
                            <Input
                              aria-label={`Price per night for ${rt.name} on ${date}`}
                              type="number"
                              min={0}
                              step="0.01"
                              value={editValue.pricePerNight}
                              onChange={(e) => setEditValue({ ...editValue, pricePerNight: e.target.value })}
                              className="h-7 text-xs w-full"
                              placeholder="Price"
                            />
                            <div className="flex gap-1 justify-center">
                              <Button type="button" aria-label={`Save availability for ${rt.name} on ${date}`} size="icon" variant="ghost" className="h-6 w-6" onClick={saveCell} disabled={saving}>
                                <Check className="w-3 h-3 text-green-600" />
                              </Button>
                              <Button type="button" aria-label={`Cancel availability edit for ${rt.name} on ${date}`} size="icon" variant="ghost" className="h-6 w-6" onClick={cancelEditing}>
                                <X className="w-3 h-3 text-red-600" />
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            aria-label={`Edit availability for ${rt.name} on ${date}`}
                            ref={(button) => { if (button) editButtons.current.set(key, button); else editButtons.current.delete(key); }}
                            className={`w-full cursor-pointer rounded-lg p-2 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                              avail ? getAvailabilityColor(avail.available_count) : "bg-muted/20"
                            }`}
                            onClick={() => startEditing(rt.id, date, avail)}
                          >
                            {avail ? (
                              <>
                                <span className="block text-sm font-semibold">
                                  {avail.available_count}/{avail.total_count}
                                </span>
                                <span className="block text-xs opacity-80">
                                  {formatHotelAmount(Number(avail.price_per_night), currency, formatCurrency)}
                                </span>
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-red-100 dark:bg-red-900/30" />
          Sold Out
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-amber-100 dark:bg-amber-900/30" />
          Low (1-2)
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-green-100 dark:bg-green-900/30" />
          Available (remaining / total)
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-muted/20" />
          Not configured
        </div>
      </div>

      {/* Empty State */}
      {displayRoomTypes.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="w-16 h-16 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center mb-4">
            <CalendarDays className="h-8 w-8 text-violet-500" />
          </div>
          <h3 className="text-lg font-semibold mb-1">No availability data</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Set availability for your room types to see them here
          </p>
          <Button onClick={() => setShowSetForm(true)} className="gap-1.5">
            <CalendarDays className="w-4 h-4" />
            Set Availability
          </Button>
        </div>
      )}
      </div>
    </div>
  );
}
