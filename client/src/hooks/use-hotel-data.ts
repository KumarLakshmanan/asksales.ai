"use client";

import { useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  BUSINESS_PROFILE_HEADER,
  selectedBusinessProfileId,
  subscribeBusinessProfile,
} from "@/lib/business-profile";
import { useAuth } from "@/contexts/AuthContext";
import { type ConfirmationRecovery as HotelConfirmationRecovery } from "../../../shared/bookingConfirmationRecovery";
export type { HotelConfirmationRecovery };

export interface HotelProperty {
  id?: number;
  name: string;
  city?: string | null;
  country?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  description?: string | null;
  amenities?: string[];
  check_in_time?: string | null;
  check_out_time?: string | null;
  currency?: string;
  timezone?: string;
}
export interface HotelPropertyChoice { id: number; name: string }
interface HotelPropertyResult { property: HotelProperty | null; properties?: HotelPropertyChoice[] }
export interface HotelRoomType {
  id: number;
  name: string;
  description?: string;
  capacity: number;
  base_price: string;
  min_price: string;
  max_discount_pct: string;
  amenities?: string[];
}
export interface HotelAvailability {
  id: number;
  room_type_id: number;
  room_type: string;
  date: string;
  available_count: number;
  total_count: number;
  reserved_count: number;
  price_per_night: string;
}
export interface HotelBooking {
  id: number;
  guest_name?: string;
  guest_phone?: string;
  check_in_date: string;
  check_out_date: string;
  nights: number;
  number_of_guests: number;
  number_of_rooms: number;
  total_price: string;
  currency: string;
  status: string;
  payment_status: string;
  payment_provider?: string;
  payment_link?: string;
  hold_expires_at?: string;
  confirmed_at?: string;
  cancelled_at?: string;
  cancellation_reason?: string;
  room_type?: string;
  created_at: string;
  confirmation_recovery?: HotelConfirmationRecovery;
}
export interface HotelSummary {
  totalRoomTypes: number;
  totalBookings: number;
  confirmedBookings: number;
  revenueByCurrency: Record<string, number>;
}

function useHotelQuery<T>(resource: string, endpoint: string, enabled = true) {
  const { user, isLoading } = useAuth();
  const profileId = useSyncExternalStore(
    subscribeBusinessProfile,
    selectedBusinessProfileId,
    () => null,
  );
  const scope = ["hotel", user?.id, profileId] as const;
  const options = profileId
    ? { headers: { [BUSINESS_PROFILE_HEADER]: String(profileId) } }
    : undefined;
  const query = useQuery<T>({
    queryKey: [...scope, resource, endpoint],
    queryFn: () => api.get<T>(endpoint, options),
    enabled: Boolean(user) && !isLoading && enabled,
    staleTime: 60_000,
    retry: 1,
  });
  const client = useQueryClient();
  const invalidate = (...resources: string[]) =>
    Promise.all(
      resources.map((name) =>
        client.invalidateQueries({ queryKey: [...scope, name] }),
      ),
    );
  return { ...query, invalidate, scope };
}
export function useHotelProperty() {
  const query = useHotelQuery<HotelPropertyResult>(
    "property",
    "/api/hotel/property",
  );
  const client = useQueryClient();
  const setProperty = async (property: HotelProperty) => {
    client.setQueryData<HotelPropertyResult>([...query.scope, "property", "/api/hotel/property"], current => ({
      ...current, property, properties: current?.properties?.map(item => item.id === property.id ? { ...item, name: property.name } : item),
    }));
    await query.invalidate("summary", "availability");
  };
  const property = query.data?.property ?? null;
  const properties = query.data?.properties ?? (property?.id ? [{ id: property.id, name: property.name }] : []);
  return { ...query, property, properties, setProperty };
}
export const useHotelSummary = () =>
  useHotelQuery<HotelSummary>("summary", "/api/hotel/summary");
export const useHotelRoomTypes = (enabled: boolean) =>
  useHotelQuery<{ roomTypes: HotelRoomType[] }>(
    "rooms",
    "/api/hotel/room-types",
    enabled,
  );
export const useHotelBookings = (enabled: boolean) =>
  useHotelQuery<{ bookings: HotelBooking[] }>(
    "bookings",
    "/api/hotel/bookings",
    enabled,
  );
export const useHotelAvailability = (
  from: string,
  to: string,
  timezone: string,
) =>
  useHotelQuery<{ availability: HotelAvailability[] }>(
    "availability",
    `/api/hotel/availability?${new URLSearchParams({ from, to, timezone })}`,
  );
