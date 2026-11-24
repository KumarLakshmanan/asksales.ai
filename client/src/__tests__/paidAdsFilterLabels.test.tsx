import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaidAdsFilterSelect } from "@/components/performance-marketing/PaidAdsFilterSelect";

afterEach(cleanup);

describe("Paid Ads persistent filter labels", () => {
  it("identifies each filter with a visible, associated label in default and selected states", () => {
    const filters = [
      { label: "Platform", selected: "meta" },
      { label: "Objective", selected: "app_promotion" },
      { label: "Campaign status", selected: "report_only" },
      { label: "Delivery status", selected: "active" },
    ];
    const view = (selected: boolean) => <>{filters.map(({ label, selected: value }) => (
      <PaidAdsFilterSelect key={label} label={label} value={selected ? value : "all"} items={["all", value]} onChange={vi.fn()} />
    ))}</>;
    const { rerender } = render(view(false));

    for (const { label } of filters) {
      const trigger = screen.getByRole("combobox", { name: label });
      expect(screen.getByText(label, { selector: "label" })).toBeVisible();
      expect(screen.getByLabelText(label)).toBe(trigger);
      expect(trigger).toHaveTextContent("all");
    }

    rerender(view(true));
    for (const { label, selected } of filters) {
      expect(screen.getByText(label, { selector: "label" })).toBeVisible();
      expect(screen.getByRole("combobox", { name: label })).toHaveTextContent(selected.replaceAll("_", " "));
    }
  });

  it("preserves translated labels and custom option wording without replacing the filter identity", () => {
    const label = "Status der Werbekampagne und Auslieferung";
    render(<PaidAdsFilterSelect label={label} value="report_only" items={["all", "report_only"]} onChange={vi.fn()} itemLabel={() => "Nur Berichterstattung ohne automatische Überwachung"} />);
    expect(screen.getByText(label, { selector: "label" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: label })).toHaveTextContent("Nur Berichterstattung ohne automatische Überwachung");
  });
});
