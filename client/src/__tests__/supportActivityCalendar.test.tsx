import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { activityCalendarDates, activityDateKey, SupportActivityCalendar } from "@/components/support/SupportActivityCalendar";

const now = new Date("2026-09-06T20:00:00Z"); // September 7 in the member's timezone.
const daily = [{
  date: "2026-09-06", activeMinutes: 45, replies: 2,
  intervals: [
    { id: 1, startedAt: "2026-09-06T03:30:00Z", endedAt: "2026-09-06T04:00:00Z", endReason: "logout" },
    { id: 2, startedAt: "2026-09-06T04:30:00Z", endedAt: "2026-09-06T04:45:00Z", endReason: "inactivity", clippedToDay: true },
  ],
}];

describe("support member activity calendar", () => {
  it("uses the member's local day rather than the browser or UTC date", () => {
    expect(activityDateKey(now, "Asia/Kolkata")).toBe("2026-09-07");
    expect(activityDateKey(now, "America/Los_Angeles")).toBe("2026-09-06");
  });

  it.each([90, 365])("contains exactly %i selectable dates with non-interactive week padding", (days) => {
    const cells = activityCalendarDates("2026-09-07", days);
    expect(cells.filter(cell => cell.inRange)).toHaveLength(days);
    expect(cells.at(-1)?.date).toBe("2026-09-07");
  });

  it("shows every interval for the selected day with local times and end reasons", () => {
    render(<SupportActivityCalendar daily={daily} days={90} timezone="Asia/Kolkata" now={now} />);
    const button = screen.getByRole("button", { name: "2026-09-06: 45 active minutes, 2 replies" });
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    const detail = screen.getByRole("region", { name: "Activity on 2026-09-06" });
    expect(within(detail).getByText("45 active minutes · 2 customer replies · 2 presence intervals")).toBeInTheDocument();
    expect(within(detail).getAllByRole("listitem")).toHaveLength(2);
    expect(within(detail).getByText("09:00:00")).toBeInTheDocument();
    expect(within(detail).getByText("10:15:00")).toBeInTheDocument();
    expect(within(detail).getByText("Logged out")).toBeInTheDocument();
    expect(within(detail).getByText("Became inactive · clipped to this day")).toBeInTheDocument();
  });

  it("lets an owner inspect days without sessions without inventing login times", () => {
    render(<SupportActivityCalendar daily={daily} days={90} timezone="Asia/Kolkata" now={now} />);
    const detail = screen.getByRole("region", { name: "Activity on 2026-09-07" });
    expect(within(detail).getByText("No presence intervals were recorded for this day.")).toBeInTheDocument();
    expect(within(detail).queryByRole("listitem")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(90);
  });

  it("does not invent a logout for an interval still being tracked", () => {
    render(<SupportActivityCalendar daily={[{ ...daily[0], intervals: [{ ...daily[0].intervals[0], endReason: null }] }]} days={365} timezone="Asia/Kolkata" now={now} />);
    fireEvent.click(screen.getByRole("button", { name: "2026-09-06: 45 active minutes, 2 replies" }));
    expect(screen.getByText("Tracked through last refresh")).toBeInTheDocument();
    expect(screen.queryByText("Logged out")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(365);
  });
});
