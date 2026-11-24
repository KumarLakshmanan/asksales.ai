import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import HotelAdminPage from "@/app/dashboard/(main)/hotel/page";
const state = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  tab: "rooms",
  currency: "INR",
  timezone: "Asia/Kolkata",
  toast: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: { get: state.get, post: state.post } }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1 }, isLoading: false }),
}));
vi.mock("@/lib/business-profile", () => ({
  BUSINESS_PROFILE_HEADER: "X-Business-Profile-Id",
  selectedBusinessProfileId: () => 42,
  subscribeBusinessProfile: () => () => {},
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: state.toast }),
}));
vi.mock("@/contexts/PreferencesContext", () => ({
  usePreferences: () => ({
    preferences: { currency: state.currency, timezone: state.timezone },
    formatCurrency: (amount: number, currency: string) =>
      `${currency} ${amount}`,
  }),
}));
vi.mock("next/navigation", () => {
  const params = { get: () => state.tab };
  return {
    useSearchParams: () => params,
    useRouter: () => ({
      push: (url: string) => {
        state.tab = url.split("tab=")[1];
      },
    }),
    usePathname: () => "/dashboard/hotel",
  };
});
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, role, id, 'aria-labelledby': label }: React.HTMLAttributes<HTMLDivElement>) => <div role={role} id={id} aria-labelledby={label}>{children}</div>,
  },
}));
vi.mock("@/app/dashboard/(main)/hotel/components/RoomTypesTab", () => ({
  RoomTypesTab: ({ onRefresh }: { onRefresh: () => void }) => (
    <button onClick={onRefresh}>Refresh rooms</button>
  ),
}));
vi.mock("@/app/dashboard/(main)/hotel/components/BookingsTab", () => ({
  BookingsTab: () => <div>Booking detail</div>,
}));
vi.mock("@/app/dashboard/(main)/hotel/components/PaymentsTab", () => ({
  PaymentsTab: () => <div>Payment detail</div>,
}));
const property = {
  id: 8,
  name: "Grand Hotel",
  currency: "USD",
  timezone: "America/New_York",
};
let client: QueryClient;
function setup() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HotelAdminPage />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  state.tab = "rooms";
  state.currency = "INR";
  state.timezone = "Asia/Kolkata";
  state.get.mockReset();
  state.post.mockReset();
  state.get.mockImplementation(async (url: string) => {
    if (url === "/api/hotel/property") return { property };
    if (url === "/api/hotel/summary")
      return {
        totalRoomTypes: 1,
        totalBookings: 350,
        confirmedBookings: 300,
        revenueByCurrency: { USD: 9000 },
      };
    if (url === "/api/hotel/room-types") return { roomTypes: [] };
    if (url === "/api/hotel/bookings") return { bookings: [] };
    if (url.startsWith("/api/hotel/availability")) return { availability: [] };
    throw new Error(`Unexpected ${url}`);
  });
});
afterEach(() => {
  cleanup();
  client?.clear();
});
it('moves and activates tab focus with arrows, Home and End using one tab stop', async () => {
  state.tab = 'payments'; setup();
  const payments = await screen.findByRole('tab', { name: 'Payments' });
  payments.focus(); fireEvent.keyDown(payments, { key: 'ArrowRight' });
  expect(screen.getByRole('tab', { name: 'Hotel Profile' })).toHaveFocus();
  expect(screen.getByRole('tab', { name: 'Hotel Profile' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Hotel Profile' }), { key: 'Home' });
  expect(screen.getByRole('tab', { name: 'Room Types' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Room Types' }), { key: 'ArrowLeft' });
  expect(screen.getByRole('tab', { name: 'Hotel Profile' })).toHaveFocus();
  expect(screen.getAllByRole('tab').filter(tab => tab.tabIndex === 0)).toHaveLength(1);
  expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', screen.getByRole('tab', { name: 'Hotel Profile' }).id);
});
describe("hotel tab query ownership", () => {
  it("loads only active details, keeps exact summary totals, and reuses shared property cache", async () => {
    setup();
    expect(await screen.findByText("Refresh rooms")).toBeInTheDocument();
    expect(screen.getByText("350")).toBeInTheDocument();
    expect(screen.getByText("USD 9000")).toBeInTheDocument();
    expect(state.get.mock.calls.map(([url]) => url)).toEqual([
      "/api/hotel/property",
      "/api/hotel/summary",
      "/api/hotel/room-types",
    ]);
    fireEvent.click(screen.getByRole("tab", { name: "Hotel Profile" }));
    expect(await screen.findByDisplayValue("Grand Hotel")).toBeInTheDocument();
    expect(
      state.get.mock.calls.filter(([url]) => url === "/api/hotel/property"),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: "Bookings" }));
    expect(await screen.findByText("Booking detail")).toBeInTheDocument();
    expect(
      state.get.mock.calls.filter(([url]) => url === "/api/hotel/bookings"),
    ).toHaveLength(1);
    expect(
      state.get.mock.calls.some(([url]) => url.includes("availability")),
    ).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Room Types" }));
    expect(await screen.findByText("Refresh rooms")).toBeInTheDocument();
    expect(
      state.get.mock.calls.filter(([url]) => url === "/api/hotel/room-types"),
    ).toHaveLength(1);
  });
  it("writes saved property into shared cache and refreshes summary without refetching hidden details", async () => {
    state.tab = "property";
    state.post.mockResolvedValue({
      success: true,
      property: { ...property, name: "Renamed Hotel" },
    });
    const rendered = setup();
    const input = await screen.findByLabelText("Hotel Property Name");
    fireEvent.change(input, { target: { value: "Renamed Hotel" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));
    await waitFor(() => expect(state.post).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        state.get.mock.calls.filter(([url]) => url === "/api/hotel/summary"),
      ).toHaveLength(2),
    );
    expect(
      state.get.mock.calls.filter(([url]) => url === "/api/hotel/property"),
    ).toHaveLength(1);
    state.timezone = "UTC";
    rendered.rerender(
      <QueryClientProvider client={client}>
        <HotelAdminPage />
      </QueryClientProvider>,
    );
    expect(screen.getByDisplayValue("Renamed Hotel")).toBeInTheDocument();
    expect(
      state.get.mock.calls.some(
        ([url]) =>
          url.includes("bookings") ||
          url.includes("room-types") ||
          url.includes("availability"),
      ),
    ).toBe(false);
    expect(
      client.getQueryData(["hotel", 1, 42, "property", "/api/hotel/property"]),
    ).toEqual({ property: { ...property, name: "Renamed Hotel" } });
  });
  it("refreshes room and summary caches after a room mutation", async () => {
    setup();
    fireEvent.click(await screen.findByText("Refresh rooms"));
    await waitFor(() =>
      expect(
        state.get.mock.calls.filter(([url]) => url === "/api/hotel/room-types"),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(
        state.get.mock.calls.filter(([url]) => url === "/api/hotel/summary"),
      ).toHaveLength(2),
    );
    expect(
      state.get.mock.calls.some(
        ([url]) => url.includes("bookings") || url.includes("availability"),
      ),
    ).toBe(false);
  });
  it("loads availability once when opened and never reloads the unrelated booking detail", async () => {
    setup();
    expect(await screen.findByText("Refresh rooms")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Availability" }));
    await waitFor(() =>
      expect(
        state.get.mock.calls.filter(([url]) =>
          url.startsWith("/api/hotel/availability?"),
        ),
      ).toHaveLength(1),
    );
    expect(
      state.get.mock.calls.find(([url]) =>
        url.startsWith("/api/hotel/availability?"),
      )?.[0],
    ).toContain("timezone=America%2FNew_York");
    expect(
      state.get.mock.calls.some(([url]) => url === "/api/hotel/bookings"),
    ).toBe(false);
    expect(
      state.get.mock.calls.filter(([url]) => url === "/api/hotel/property"),
    ).toHaveLength(1);
  });
});
