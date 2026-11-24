/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState, useRef, useEffect, useId } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  BedDouble,
  Plus,
  X,
  Trash2,
  Pencil,
  Filter,
  Upload,
  Check,
  Users,
  DollarSign,
  Tag,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";
import { formatHotelAmount } from "@/lib/hotel-money";
import { usePreferences } from "@/contexts/PreferencesContext";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { type HotelRoomType as RoomType, type HotelPropertyChoice } from "@/hooks/use-hotel-data";
import { Callout } from "@/components/ui/callout";
import { SearchInput } from "@/components/ui/search-input";

interface RoomTypesTabProps {
  roomTypes: RoomType[];
  properties?: HotelPropertyChoice[];
  currency?: string;
  onRefresh: () => void;
}

const roomTypeName = (rt: RoomType) => rt.name?.trim() || `Room type ${rt.id}`;
const roomTypeTarget = (rt: RoomType) =>
  rt.name?.trim() ? `${roomTypeName(rt)} (ID ${rt.id})` : roomTypeName(rt);

export function RoomTypesTab({ roomTypes, properties = [], currency, onRefresh }: RoomTypesTabProps) {
  const formId = useId();
  const { toast } = useToast();
  const { formatCurrency } = usePreferences();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editButtonRefs = useRef(new Map<number, HTMLButtonElement>());
  const editNameRef = useRef<HTMLInputElement>(null);
  const returnFocusId = useRef<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editData, setEditData] = useState<Partial<RoomType>>({});
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [priceFilter, setPriceFilter] = useState<{ min: string; max: string }>({ min: "", max: "" });
  const [showFilters, setShowFilters] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importHotelId, setImportHotelId] = useState('');
  const [importError, setImportError] = useState<{ file: string; property: string; message: string; row?: number; field?: string; rejected: boolean } | null>(null);
  const importProperty = properties.find(item => String(item.id) === (properties.length === 1 ? String(properties[0].id) : importHotelId));
  const [deleteIds, setDeleteIds] = useState<number[]>([]);
  const [newRoom, setNewRoom] = useState({
    name: "",
    capacity: "2",
    basePrice: "",
    minPrice: "",
    maxDiscountPct: "20",
    amenities: "",
  });

  const filteredRoomTypes = roomTypes.filter((rt) => {
    const matchesSearch = roomTypeName(rt).toLowerCase().includes(searchQuery.toLowerCase());
    const matchesMinPrice = !priceFilter.min || Number(rt.base_price) >= Number(priceFilter.min);
    const matchesMaxPrice = !priceFilter.max || Number(rt.base_price) <= Number(priceFilter.max);
    return matchesSearch && matchesMinPrice && matchesMaxPrice;
  });

  const editingRoomIsVisible = filteredRoomTypes.some((rt) => rt.id === editingId);
  useEffect(() => {
    // A filtered-out or removed row must not retain an invisible edit draft.
    if (editingId !== null && !editingRoomIsVisible) {
      setEditingId(null);
      setEditData({});
    }
  }, [editingId, editingRoomIsVisible]);

  useEffect(() => {
    if (editingId !== null) {
      editNameRef.current?.focus();
    } else if (returnFocusId.current !== null) {
      editButtonRefs.current.get(returnFocusId.current)?.focus();
      returnFocusId.current = null;
    }
  }, [editingId]);

  const startEditing = (rt: RoomType) => {
    setEditingId(rt.id);
    setEditData({
      name: rt.name,
      capacity: rt.capacity,
      base_price: rt.base_price,
      min_price: rt.min_price,
      max_discount_pct: rt.max_discount_pct,
      amenities: rt.amenities,
    });
  };

  const cancelEditing = () => {
    returnFocusId.current = editingId;
    setEditingId(null);
    setEditData({});
  };

  const saveRoomType = async (id: number) => {
    if (
      !editData.name?.trim()
      || Number(editData.capacity) < 1
      || Number(editData.base_price) <= 0
      || Number(editData.min_price) <= 0
      || Number(editData.min_price) > Number(editData.base_price)
      || Number(editData.max_discount_pct) < 0
      || Number(editData.max_discount_pct) > 100
    ) {
      toast({ title: "Check the room name, capacity, prices, and discount", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await api.put(`/api/hotel/room-types/${id}`, {
        name: editData.name,
        capacity: Number(editData.capacity),
        basePrice: Number(editData.base_price),
        minPrice: Number(editData.min_price),
        maxDiscountPct: Number(editData.max_discount_pct),
        amenities: editData.amenities,
      });
      toast({ title: "Room type updated" });
      cancelEditing();
      onRefresh();
    } catch (e: any) {
      toast({ title: "Failed to update", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const performDelete = async () => {
    if (deleteIds.length === 0) return;
    setSaving(true);
    try {
      const results = await Promise.allSettled(deleteIds.map((id) => api.delete(`/api/hotel/room-types/${id}`)));
      const deleted = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - deleted;
      toast({
        title: deleted ? `${deleted} room type${deleted === 1 ? "" : "s"} deleted` : "No room types were deleted",
        description: failed ? `${failed} item${failed === 1 ? "" : "s"} could not be deleted because booking history must be preserved.` : undefined,
        variant: deleted ? "default" : "destructive",
      });
      setDeleteIds([]);
      setSelectedIds([]);
      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const addRoomType = async () => {
    if (
      !newRoom.name.trim()
      || Number(newRoom.capacity) < 1
      || Number(newRoom.basePrice) <= 0
      || Number(newRoom.minPrice) <= 0
      || Number(newRoom.minPrice) > Number(newRoom.basePrice)
      || Number(newRoom.maxDiscountPct) < 0
      || Number(newRoom.maxDiscountPct) > 100
    ) {
      toast({ title: "Check the room name, capacity, prices, and discount", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await api.post("/api/hotel/room-types", {
        name: newRoom.name,
        capacity: Number(newRoom.capacity),
        basePrice: Number(newRoom.basePrice),
        minPrice: Number(newRoom.minPrice),
        maxDiscountPct: Number(newRoom.maxDiscountPct),
        amenities: newRoom.amenities
          ? newRoom.amenities.split(",").map((s) => s.trim()).filter(Boolean)
          : [],
      });
      toast({ title: "Room type added" });
      setNewRoom({ name: "", capacity: "2", basePrice: "", minPrice: "", maxDiscountPct: "20", amenities: "" });
      setShowAddForm(false);
      onRefresh();
    } catch (e: any) {
      toast({ title: "Failed to add room type", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === filteredRoomTypes.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredRoomTypes.map((rt) => rt.id));
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const destination = importProperty;
    if (!destination) { toast({ title: 'Choose an import property', variant: 'destructive' }); e.target.value = ''; return; }
    setImporting(true);
    const formData = new FormData();
    formData.append("file", file);
    formData.append('hotelId', String(destination.id));
    try {
      await api.upload("/api/hotel/import-rate-report", formData);
      setImportError(null);
      toast({ title: "Rate report imported successfully!", description: `Imported into ${destination.name}.` });
      onRefresh();
    } catch (error: unknown) {
      const failure = error as { message?: string; status?: number; data?: { row?: unknown; field?: unknown } } | null;
      const row = Number(failure?.data?.row);
      const message = error instanceof Error ? error.message : 'Unable to confirm the rate report import.';
      const rejected = typeof failure?.status === 'number' && failure.status >= 400 && failure.status < 500;
      setImportError({ file: file.name, property: destination.name, message, rejected,
        row: Number.isSafeInteger(row) && row > 0 ? row : undefined,
        field: typeof failure?.data?.field === 'string' ? failure.data.field : undefined });
      toast({ title: rejected ? 'Workbook rejected' : 'Import outcome not confirmed', description: message, variant: 'destructive' });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-4">
      <div className="max-w-sm space-y-1">
        <Label htmlFor={`${formId}-import-property`}>Import property</Label>
        <select id={`${formId}-import-property`} className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
          value={importProperty ? String(importProperty.id) : ''} disabled={importing} onChange={event => setImportHotelId(event.target.value)}>
          <option value="">Choose the destination property</option>
          {properties.map(item => <option key={item.id} value={item.id}>{item.name} (#{item.id})</option>)}
        </select>
      </div>
      {importError && <Callout tone="danger" title={`${importError.file} · ${importError.property}`}>
        <p>{importError.row ? `Row ${importError.row}${importError.field ? ` (${importError.field})` : ''}: ` : ''}{importError.message}</p>
        <p>{importError.rejected ? 'Review the workbook and choose a corrected file.' : 'Review current inventory before retrying; the request may have completed.'}</p>
      </Callout>}
      {/* Header Actions */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2 flex-1">
          <SearchInput
            placeholder="Search room types..."
            aria-label="Search room types"
            value={searchQuery}
            onValueChange={setSearchQuery}
            size="sm"
            wrapperClassName="flex-1 max-w-sm"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFilters(!showFilters)}
            className="h-9 gap-1.5"
          >
            <Filter className="w-3.5 h-3.5" />
            Filters
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.length > 0 && (
            <Button variant="destructive" size="sm" onClick={() => setDeleteIds(selectedIds)} className="h-9 gap-1.5">
              <Trash2 className="w-3.5 h-3.5" />
              Delete ({selectedIds.length})
            </Button>
          )}
          <input type="file" accept=".xlsx,.xls" aria-label="Rate report workbook" className="hidden" disabled={importing || !importProperty} ref={fileInputRef} onChange={handleImport} />
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            disabled={importing || !importProperty}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="w-3.5 h-3.5" />
            {importing ? "Importing..." : "Import Excel"}
          </Button>
          <Button size="sm" onClick={() => setShowAddForm(true)} className="h-9 gap-1.5 bg-violet-600 hover:bg-violet-700">
            <Plus className="w-3.5 h-3.5" />
            Add Room Type
          </Button>
        </div>
      </div>

      {/* Filters Panel */}
      {showFilters && (
        <Card className="rounded-xl border border-border/50">
          <CardContent className="p-4">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">Price Range:</Label>
                <Input
                  type="number"
                  min={1}
                  placeholder="Min"
                  aria-label={`Minimum room price (${currency || "currency unknown"})`}
                  value={priceFilter.min}
                  onChange={(e) => setPriceFilter({ ...priceFilter, min: e.target.value })}
                  className="w-24 h-8 text-xs"
                />
                <span className="text-muted-foreground">-</span>
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="Max"
                  aria-label={`Maximum room price (${currency || "currency unknown"})`}
                  value={priceFilter.max}
                  onChange={(e) => setPriceFilter({ ...priceFilter, max: e.target.value })}
                  className="w-24 h-8 text-xs"
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPriceFilter({ min: "", max: "" })}
                className="h-8 text-xs"
              >
                Clear
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Add Form */}
      {showAddForm && (
        <Card className="rounded-xl border border-violet-200 dark:border-violet-800">
          <CardContent className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Add New Room Type</h3>
              <Button variant="ghost" size="sm" onClick={() => setShowAddForm(false)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
              <div className="col-span-2 md:col-span-1">
                <Label htmlFor={`${formId}-new-name`} className="text-xs">Name</Label>
                <Input
                  id={`${formId}-new-name`}
                  value={newRoom.name}
                  onChange={(e) => setNewRoom({ ...newRoom, name: e.target.value })}
                  placeholder="Deluxe Room"
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label htmlFor={`${formId}-new-capacity`} className="text-xs">Capacity</Label>
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  id={`${formId}-new-capacity`}
                  value={newRoom.capacity}
                  onChange={(e) => setNewRoom({ ...newRoom, capacity: e.target.value })}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label htmlFor={`${formId}-new-basePrice`} className="text-xs">Base Price</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  id={`${formId}-new-basePrice`}
                  value={newRoom.basePrice}
                  onChange={(e) => setNewRoom({ ...newRoom, basePrice: e.target.value })}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label htmlFor={`${formId}-new-minPrice`} className="text-xs">Min Price</Label>
                <Input
                  type="number"
                  id={`${formId}-new-minPrice`}
                  value={newRoom.minPrice}
                  onChange={(e) => setNewRoom({ ...newRoom, minPrice: e.target.value })}
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <Label htmlFor={`${formId}-new-maxDiscountPct`} className="text-xs">Max Disc %</Label>
                <Input
                  type="number"
                  id={`${formId}-new-maxDiscountPct`}
                  value={newRoom.maxDiscountPct}
                  onChange={(e) => setNewRoom({ ...newRoom, maxDiscountPct: e.target.value })}
                  className="h-9 text-sm"
                />
              </div>
              <div className="col-span-2 md:col-span-5">
                <Label htmlFor={`${formId}-new-amenities`} className="text-xs">Amenities (comma-separated)</Label>
                <Input
                  id={`${formId}-new-amenities`}
                  value={newRoom.amenities}
                  onChange={(e) => setNewRoom({ ...newRoom, amenities: e.target.value })}
                  placeholder="King bed, Sea view, WiFi"
                  className="h-9 text-sm"
                />
              </div>
              <Button onClick={addRoomType} loading={saving} loadingText="Adding…" className="h-9">
                <Plus className="w-4 h-4 mr-1" />
                Add
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Select All */}
      {filteredRoomTypes.length > 0 && (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id={`${formId}-select-all`}
            aria-label={`Select all visible room types (${filteredRoomTypes.length})`}
            checked={selectedIds.length === filteredRoomTypes.length}
            onChange={toggleSelectAll}
            className="rounded border-input"
          />
          <span className="text-xs text-muted-foreground">
            Select all ({filteredRoomTypes.length})
          </span>
        </div>
      )}

      {/* Room Type Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredRoomTypes.map((rt) => (
          <Card
            key={rt.id}
            className={`group relative overflow-hidden bg-card border transition-all rounded-xl ${
              editingId === rt.id
                ? "border-violet-300 dark:border-violet-700 shadow-lg"
                : "border-border/40 hover:border-violet-200 dark:hover:border-violet-700 hover:shadow-md"
            }`}
          >
            {/* Selection Checkbox */}
            <div className="absolute top-3 left-3 z-10">
              <input
                type="checkbox"
                id={`${formId}-select-${rt.id}`}
                aria-label={`Select room type ${roomTypeTarget(rt)}`}
                checked={selectedIds.includes(rt.id)}
                onChange={() => toggleSelect(rt.id)}
                className="rounded border-input"
              />
            </div>

            {/* Action Buttons */}
            <div className="absolute top-3 right-3 z-10 flex items-center gap-1 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
              {editingId === rt.id ? (
                <>
                  <Button
                    key="save"
                    type="button"
                    aria-label={`Save changes to room type ${roomTypeTarget(rt)}`}
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 bg-background/90 backdrop-blur-sm"
                    onClick={() => saveRoomType(rt.id)}
                    loading={saving}
                  >
                    <Check aria-hidden="true" className="w-3.5 h-3.5 text-green-600" />
                  </Button>
                  <Button
                    key="cancel"
                    type="button"
                    aria-label={`Cancel editing room type ${roomTypeTarget(rt)}`}
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 bg-background/90 backdrop-blur-sm"
                    onClick={() => cancelEditing()}
                    disabled={saving}
                  >
                    <X aria-hidden="true" className="w-3.5 h-3.5 text-red-600" />
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    key="edit"
                    type="button"
                    aria-label={`Edit room type ${roomTypeTarget(rt)}`}
                    ref={(button) => {
                      if (button) editButtonRefs.current.set(rt.id, button);
                      else editButtonRefs.current.delete(rt.id);
                    }}
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 bg-background/90 backdrop-blur-sm"
                    onClick={() => startEditing(rt)}
                  >
                    <Pencil aria-hidden="true" className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 bg-background/90 backdrop-blur-sm"
                    aria-label={`Delete ${rt.name}`}
                    onClick={() => setDeleteIds([rt.id])}
                  >
                    <Trash2 className="w-3.5 h-3.5 text-red-500" />
                  </Button>
                </>
              )}
            </div>

            {/* Decorative Header */}
            <div className="h-20 bg-gradient-to-br from-violet-50 to-indigo-50 dark:from-violet-950/20 dark:to-indigo-950/20 flex items-center justify-center">
              <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-violet-100 dark:bg-violet-900/40 shadow-sm border border-violet-200/20">
                <BedDouble className="h-6 w-6 text-violet-500" />
              </div>
            </div>

            <CardContent className="p-4 space-y-3">
              {/* Room Name */}
              {editingId === rt.id ? (
                <Input
                  ref={editNameRef}
                  id={`${formId}-name-${rt.id}`}
                  aria-label={`Room name for ${roomTypeTarget(rt)}`}
                  value={editData.name || ""}
                  onChange={(e) => setEditData({ ...editData, name: e.target.value })}
                  className="h-8 text-sm font-semibold"
                />
              ) : (
                <h3 className="font-semibold text-foreground truncate">{roomTypeName(rt)}</h3>
              )}

              {/* Stats */}
              <div className="grid grid-cols-3 gap-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Users className="w-3 h-3" />
                  {editingId === rt.id ? (
                    <Input
                      type="number"
                      min={1}
                      id={`${formId}-capacity-${rt.id}`}
                      aria-label={`Capacity (guests per room) for ${roomTypeTarget(rt)}`}
                      value={editData.capacity || ""}
                      onChange={(e) => setEditData({ ...editData, capacity: Number(e.target.value) })}
                      className="h-7 w-14 text-xs"
                    />
                  ) : (
                    <span>{rt.capacity}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <DollarSign className="w-3 h-3" />
                  {editingId === rt.id ? (
                    <Input
                      type="number"
                      min="0.01"
                      step="0.01"
                      id={`${formId}-price-${rt.id}`}
                      aria-label={`Base price (${currency || "currency unknown"}) per night for ${roomTypeTarget(rt)}`}
                      value={editData.base_price || ""}
                      onChange={(e) => setEditData({ ...editData, base_price: e.target.value })}
                      className="h-7 w-20 text-xs"
                    />
                  ) : (
                    <span>{formatHotelAmount(Number(rt.base_price), currency, formatCurrency)}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Tag className="w-3 h-3" />
                  {editingId === rt.id ? (
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step="0.01"
                      id={`${formId}-discount-${rt.id}`}
                      aria-label={`Maximum discount (percent) for ${roomTypeTarget(rt)}`}
                      value={editData.max_discount_pct || ""}
                      onChange={(e) => setEditData({ ...editData, max_discount_pct: e.target.value })}
                      className="h-7 w-14 text-xs"
                    />
                  ) : (
                    <span>{rt.max_discount_pct}%</span>
                  )}
                </div>
              </div>

              {/* Amenities */}
              {rt.amenities && rt.amenities.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {rt.amenities.slice(0, 3).map((amenity, idx) => (
                    <Badge key={idx} variant="secondary" className="px-2 py-0.5 text-xs">
                      {amenity}
                    </Badge>
                  ))}
                  {rt.amenities.length > 3 && (
                    <Badge variant="secondary" className="px-2 py-0.5 text-xs">
                      +{rt.amenities.length - 3}
                    </Badge>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Empty State */}
      {filteredRoomTypes.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="w-16 h-16 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center mb-4">
            <BedDouble className="h-8 w-8 text-violet-500" />
          </div>
          <h3 className="text-lg font-semibold mb-1">No room types found</h3>
          <p className="text-sm text-muted-foreground mb-4">
            {searchQuery ? "Try adjusting your search" : "Create your first room type to get started"}
          </p>
          {!searchQuery && (
            <Button onClick={() => setShowAddForm(true)} className="gap-1.5">
              <Plus className="w-4 h-4" />
              Add Room Type
            </Button>
          )}
        </div>
      )}

      <Dialog open={deleteIds.length > 0} onOpenChange={(open) => !open && setDeleteIds([])}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {deleteIds.length === 1 ? "room type" : `${deleteIds.length} room types`}?
            </DialogTitle>
            <DialogDescription>
              Room types with booking history are preserved. Availability for successfully deleted room types is removed permanently.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteIds([])}>Keep room types</Button>
            <Button type="button" variant="destructive" loading={saving} loadingText="Deleting…" onClick={() => void performDelete()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
