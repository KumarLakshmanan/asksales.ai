import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WidgetPreview } from "@/components/support/WidgetPreview";
import { DEFAULT_WIDGET_SETTINGS } from "@/lib/support-widget-settings";
describe("local widget preview", () => {
  it("accepts demo messages and toggles the launcher without opening live sessions", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(
      <WidgetPreview
        settings={{
          ...DEFAULT_WIDGET_SETTINGS,
          displayName: "Example help",
          greeting: "Welcome to Example.",
        }}
        teamName="Example"
      />,
    );
    expect(screen.getByText("Example help")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Preview message"), {
      target: { value: "Delivery options?" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Send preview message" }),
    );
    expect(screen.getByText("Delivery options?")).toBeInTheDocument();
    expect(screen.getByText("Demo only. Live replies require enabled AI and a ready assistant assigned to this widget.")).toBeVisible();
    expect(screen.queryByText(/reply will appear here after installation/)).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Close preview widget" }),
    );
    expect(screen.queryByLabelText("Preview message")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open preview widget" }),
    );
    expect(screen.getByLabelText("Preview message")).toBeInTheDocument();
    fetchSpy.mockRestore();
  });
});
