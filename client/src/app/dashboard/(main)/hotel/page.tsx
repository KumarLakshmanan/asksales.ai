"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { BedDouble, CalendarDays, ClipboardList, CreditCard, Users, DollarSign, Settings } from "lucide-react";
import { useHotelProperty, useHotelRoomTypes, useHotelBookings, useHotelSummary } from "@/hooks/use-hotel-data";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { AnimatePresence, motion } from "framer-motion";
import { Separator } from "@/components/ui/separator";
import { RoomTypesTab } from "./components/RoomTypesTab";
import { AvailabilityTab } from "./components/AvailabilityTab";
import { BookingsTab } from "./components/BookingsTab";
import { PaymentsTab } from "./components/PaymentsTab";
import { PropertyTab } from "./components/PropertyTab";
import { Button } from "@/components/ui/button";
import { usePreferences } from "@/contexts/PreferencesContext";

import { hotelRevenueDisplay } from "@/lib/hotel-money";
import { LoadingState } from "@/components/ui/loading-state";
import { Callout } from "@/components/ui/callout";
import { StatCard, StatGrid } from "@/components/ui/stat-card";

const VALID_TABS = ["rooms", "availability", "bookings", "payments", "property"] as const;
type TabId = (typeof VALID_TABS)[number];

const tabs = [
  { id: "rooms" as TabId, label: "Room Types", icon: BedDouble },
  { id: "availability" as TabId, label: "Availability", icon: CalendarDays },
  { id: "bookings" as TabId, label: "Bookings", icon: ClipboardList },
  { id: "payments" as TabId, label: "Payments", icon: CreditCard },
  { id: "property" as TabId, label: "Hotel Profile", icon: Settings },
];

export default function HotelAdminPage() {
  const { preferences, formatCurrency } = usePreferences();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const getTabFromUrl = useCallback((): TabId => {
    const tab = searchParams.get("tab");
    return VALID_TABS.includes(tab as TabId) ? (tab as TabId) : "rooms";
  }, [searchParams]);

  const [activeTab, setActiveTab] = useState<TabId>(getTabFromUrl);
  const tabButtons = useRef(new Map<TabId, HTMLButtonElement>());
  const propertyQuery = useHotelProperty();
  const property = propertyQuery.property;
  const summaryQuery = useHotelSummary();
  const roomQuery = useHotelRoomTypes(Boolean(property) && (activeTab === "rooms" || activeTab === "availability"));
  const bookingsQuery = useHotelBookings(Boolean(property) && activeTab === "bookings");
  const roomTypes = roomQuery.data?.roomTypes ?? [];
  const bookings = bookingsQuery.data?.bookings ?? [];
  const activeQuery = activeTab === "rooms" || activeTab === "availability" ? roomQuery : activeTab === "bookings" ? bookingsQuery : null;
  const loading = propertyQuery.isLoading || summaryQuery.isLoading;
  const loadError = propertyQuery.isError || summaryQuery.isError || activeQuery?.isError;
  const loadAll = async () => {
    await Promise.all([propertyQuery.refetch(), summaryQuery.refetch(), ...(activeQuery ? [activeQuery.refetch()] : [])]);
  };
  const loadRoomTypes = async () => { await roomQuery.invalidate("rooms", "summary", "availability"); };
  const loadBookings = async () => { await bookingsQuery.invalidate("bookings", "summary", "availability"); };

  useEffect(() => {
    setActiveTab(getTabFromUrl());
  }, [getTabFromUrl]);

  const handleTabChange = (tabId: TabId) => {
    setActiveTab(tabId);
    router.push(`${pathname}?tab=${tabId}`, { scroll: false });
  };

  const revenueByCurrency = summaryQuery.data?.revenueByCurrency ?? {};
  const revenueCurrencies = Object.keys(revenueByCurrency);
  const revenueDisplay = hotelRevenueDisplay(revenueByCurrency, property?.currency, formatCurrency);
  const stats = {
    totalRoomTypes: summaryQuery.data?.totalRoomTypes ?? 0,
    totalBookings: summaryQuery.data?.totalBookings ?? 0,
    confirmedBookings: summaryQuery.data?.confirmedBookings ?? 0,
  };
  const currency = property?.currency;

  if (loading) {
    return (
      <LoadingState size="page" label="Loading hotel workspace…" />
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-5 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <PageHeader
          icon={BedDouble}
          title="Hotel Management"
          subtitle="Manage rooms, availability, bookings & payments"
        />

        <div
          className="flex w-full max-w-full items-center gap-1 overflow-x-auto rounded-lg border bg-muted/40 p-1 xl:w-auto"
          role="tablist"
          aria-label="Hotel management sections"
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`hotel-tab-${tab.id}`}
                aria-controls={`hotel-panel-${tab.id}`}
                tabIndex={isActive ? 0 : -1}
                ref={(button) => { if (button) tabButtons.current.set(tab.id, button); else tabButtons.current.delete(tab.id); }}
                aria-selected={isActive}
                onClick={() => handleTabChange(tab.id)}
                onKeyDown={(event) => {
                  const index = tabs.findIndex(item => item.id === tab.id);
                  const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
                    : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
                      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
                  if (next === null) return;
                  event.preventDefault();
                  tabButtons.current.get(tabs[next].id)?.focus();
                  handleTabChange(tabs[next].id);
                }}
                className={cn(
                  "relative flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-xs font-medium transition-all",
                  isActive ? "text-white" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {isActive && (
                  <motion.div
                    layoutId="activeTabBg"
                    className="absolute inset-0 bg-violet-600 rounded-md z-0"
                  />
                )}
                <Icon className="w-3.5 h-3.5 relative z-10" />
                <span className="relative z-10">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <Separator className="bg-border/50" />

      {loadError && (
        <Callout
          tone="danger"
          actions={
            <Button type="button" variant="outline" size="sm" onClick={() => void loadAll()}>
              Retry
            </Button>
          }
        >
          Some hotel data could not be loaded. Retry before making inventory or booking changes.
        </Callout>
      )}

      {!loadError && !property && (
        <Callout
          tone="warning"
          title="Set up the hotel profile first"
          actions={
            <Button type="button" size="sm" onClick={() => handleTabChange("property")}>
              Configure hotel
            </Button>
          }
        >
          Property timezone and currency are required before inventory, rates, and bookings can be managed safely.
        </Callout>
      )}

      {/* Stats Dashboard */}
      <StatGrid columns={4}>
        <StatCard label="Room Types" value={stats.totalRoomTypes} icon={<BedDouble />} />
        <StatCard label="Total Bookings" value={stats.totalBookings} icon={<ClipboardList />} />
        <StatCard label="Confirmed" value={stats.confirmedBookings} icon={<Users />} />
        <StatCard
          label={revenueCurrencies.length > 1 ? "Revenue currencies" : "Confirmed revenue"}
          value={revenueDisplay}
          icon={<DollarSign />}
        />
      </StatGrid>

      {/* Tab Content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          role="tabpanel"
          id={`hotel-panel-${activeTab}`}
          aria-labelledby={`hotel-tab-${activeTab}`}
          initial={{ opacity: 0, x: 10 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -10 }}
          transition={{ duration: 0.2 }}
        >
          {activeQuery?.isLoading && <LoadingState size="section" label={`Loading ${tabs.find((tab) => tab.id === activeTab)?.label ?? "hotel data"}…`} />}
          {!loadError && property && !activeQuery?.isLoading && activeTab === "rooms" && (
            <RoomTypesTab roomTypes={roomTypes} properties={propertyQuery.properties} currency={currency} onRefresh={loadRoomTypes} />
          )}
          {!loadError && property && !activeQuery?.isLoading && activeTab === "availability" && (
            <AvailabilityTab
              roomTypes={roomTypes}
              currency={currency}
              timezone={property?.timezone || preferences.timezone}
            />
          )}
          {!loadError && property && !activeQuery?.isLoading && activeTab === "bookings" && (
            <BookingsTab
              currency={currency}
              bookings={bookings}
              timezone={property?.timezone || preferences.timezone}
              onRefresh={loadBookings}
            />
          )}
          {activeTab === "payments" && <PaymentsTab />}
          {activeTab === "property" && <PropertyTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
