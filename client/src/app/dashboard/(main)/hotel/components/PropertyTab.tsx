"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertCircle, Save, Building } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePreferences } from "@/contexts/PreferencesContext";
import { useHotelProperty, type HotelProperty } from "@/hooks/use-hotel-data";
import { LoadingState } from "@/components/ui/loading-state";

export function PropertyTab() {
  const { toast } = useToast();
  const { preferences } = usePreferences();
  const propertyQuery = useHotelProperty();
  const loading = propertyQuery.isLoading;
  const loadError = propertyQuery.isError;
  const [saving, setSaving] = useState(false);
  const [hotel, setHotel] = useState<HotelProperty>({
    name: "",
    city: "",
    country: "",
    address: "",
    phone: "",
    email: "",
    description: "",
    check_in_time: "14:00",
    check_out_time: "11:00",
    amenities: [],
    currency: preferences.currency,
    timezone: preferences.timezone,
  });
  const [amenitiesInput, setAmenitiesInput] = useState("");

  useEffect(() => {
    const property = propertyQuery.property;
    if (property) {
      setHotel({
        ...property,
        city: property.city || "", country: property.country || "", address: property.address || "",
        phone: property.phone || "", email: property.email || "", description: property.description || "",
        check_in_time: property.check_in_time ? String(property.check_in_time).slice(0, 5) : "14:00",
        check_out_time: property.check_out_time ? String(property.check_out_time).slice(0, 5) : "11:00",
        amenities: property.amenities || [], currency: property.currency || preferences.currency,
        timezone: property.timezone || preferences.timezone,
      });
      setAmenitiesInput((property.amenities || []).join(", "));
    }
  }, [propertyQuery.property, preferences.currency, preferences.timezone]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hotel.name.trim()) {
      toast({
        title: "Validation Error",
        description: "Hotel property name is required.",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      const parsedAmenities = amenitiesInput
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);

      const res = await api.post<{ success: boolean; property: HotelProperty }>(
        "/api/hotel/property",
        {
          name: hotel.name.trim(),
          city: hotel.city?.trim() || null,
          country: hotel.country?.trim() || null,
          address: hotel.address?.trim() || null,
          phone: hotel.phone?.trim() || null,
          email: hotel.email?.trim() || null,
          description: hotel.description?.trim() || null,
          checkInTime: hotel.check_in_time || null,
          checkOutTime: hotel.check_out_time || null,
          amenities: parsedAmenities,
          currency: hotel.currency || preferences.currency,
          timezone: hotel.timezone || preferences.timezone,
        }
      );

      if (res.success) {
        toast({
          title: "Property Saved",
          description: "Hotel details have been updated successfully.",
        });
        await propertyQuery.setProperty(res.property);
      }
    } catch (err) {
      toast({
        title: "Save Failed",
        description: err instanceof Error ? err.message : "Unable to save hotel property details.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <LoadingState size="section" label="Loading hotel profile…" />
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-destructive/30 bg-destructive/5 py-12 text-center">
        <AlertCircle className="mb-3 h-8 w-8 text-destructive" />
        <h3 className="font-semibold">Hotel profile unavailable</h3>
        <p className="mt-1 text-sm text-muted-foreground">Retry before changing booking settings.</p>
        <Button type="button" variant="outline" className="mt-4" onClick={() => void propertyQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <Card className="rounded-xl border border-border/50 max-w-2xl">
      <CardHeader>
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Building className="w-4 h-4 text-violet-500" />
          Hotel Profile & Settings
        </CardTitle>
        <CardDescription className="text-xs">
          Configure default metadata used by AI agents to handle reservations and check availability.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="hotel-name" className="text-xs font-medium">Hotel Property Name</Label>
              <Input
                id="hotel-name"
                value={hotel.name}
                onChange={(e) => setHotel({ ...hotel, name: e.target.value })}
                placeholder="e.g. Grand Palace Resort"
                className="h-9 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hotel-city" className="text-xs font-medium">City / Location</Label>
              <Input
                id="hotel-city"
                value={hotel.city || ""}
                onChange={(e) => setHotel({ ...hotel, city: e.target.value })}
                placeholder="e.g. Goa"
                className="h-9 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="check-in-time" className="text-xs font-medium">Check-In Time</Label>
              <Input
                id="check-in-time"
                type="time"
                value={hotel.check_in_time || ""}
                onChange={(e) => setHotel({ ...hotel, check_in_time: e.target.value })}
                placeholder="e.g. 14:00"
                className="h-9 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="check-out-time" className="text-xs font-medium">Check-Out Time</Label>
              <Input
                id="check-out-time"
                type="time"
                value={hotel.check_out_time || ""}
                onChange={(e) => setHotel({ ...hotel, check_out_time: e.target.value })}
                placeholder="e.g. 11:00"
                className="h-9 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hotel-phone" className="text-xs font-medium">Contact Phone Number</Label>
              <Input
                id="hotel-phone"
                value={hotel.phone || ""}
                onChange={(e) => setHotel({ ...hotel, phone: e.target.value })}
                placeholder="e.g. +91 98765 43210"
                className="h-9 text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="hotel-email" className="text-xs font-medium">Email Address</Label>
              <Input
                id="hotel-email"
                type="email"
                value={hotel.email || ""}
                onChange={(e) => setHotel({ ...hotel, email: e.target.value })}
                placeholder="e.g. info@hotelname.com"
                className="h-9 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="hotel-country" className="text-xs font-medium">Country</Label>
              <Input
                id="hotel-country"
                value={hotel.country || ""}
                onChange={(event) => setHotel({ ...hotel, country: event.target.value })}
                placeholder="India"
                className="h-10"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hotel-currency" className="text-xs font-medium">Booking currency</Label>
              <Select value={hotel.currency || preferences.currency} onValueChange={(value) => setHotel({ ...hotel, currency: value })}>
                <SelectTrigger id="hotel-currency" className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["INR", "USD", "EUR", "GBP", "CAD", "AUD", "JPY", "SGD"].map((currency) => (
                    <SelectItem key={currency} value={currency}>{currency}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hotel-timezone" className="text-xs font-medium">Property timezone</Label>
              <Select value={hotel.timezone || preferences.timezone} onValueChange={(value) => setHotel({ ...hotel, timezone: value })}>
                <SelectTrigger id="hotel-timezone" className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["UTC", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Europe/London", "Europe/Paris", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney"].map((timezone) => (
                    <SelectItem key={timezone} value={timezone}>{timezone}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hotel-address" className="text-xs font-medium">Full Address</Label>
            <Input
              id="hotel-address"
              value={hotel.address || ""}
              onChange={(e) => setHotel({ ...hotel, address: e.target.value })}
              placeholder="e.g. 123 Beach Road, Near Sunset Point, Anjuna, Goa"
              className="h-9 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hotel-amenities" className="text-xs font-medium">General Amenities (comma-separated)</Label>
            <Input
              id="hotel-amenities"
              value={amenitiesInput}
              onChange={(e) => setAmenitiesInput(e.target.value)}
              placeholder="e.g. Swimming Pool, Free WiFi, Spa, Fitness Center, Restaurant"
              className="h-9 text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hotel-description" className="text-xs font-medium">Description & Context for AI Agent</Label>
            <Textarea
              id="hotel-description"
              value={hotel.description || ""}
              onChange={(e) => setHotel({ ...hotel, description: e.target.value })}
              placeholder="Provide general context about the hotel view, highlights, or target audience for the AI."
              rows={3}
              className="text-sm resize-none"
            />
          </div>

          <div className="flex justify-end pt-2">
            <Button type="submit" loading={saving} loadingText="Saving…" className="h-9">
              <Save className="w-4 h-4 mr-1.5" />
              Save Settings
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
