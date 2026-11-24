import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadingState } from "@/components/ui/loading-state";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/copy-button";
import { DescriptionList } from "@/components/ui/description-list";
import { StatusBadge, formatStatusLabel, getStatusTone } from "@/components/ui/status-badge";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LoadingState", () => {
  it("announces its label, visibly only when asked", () => {
    const { rerender } = render(<LoadingState label="Loading campaigns…" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading campaigns…");
    expect(screen.getByText("Loading campaigns…")).toHaveClass("sr-only");
    rerender(<LoadingState label="Loading campaigns…" showLabel size="page" />);
    expect(screen.getByText("Loading campaigns…")).not.toHaveClass("sr-only");
    expect(screen.getByRole("status").className).toContain("min-h-[60vh]");
  });
});

describe("Callout", () => {
  it("announces danger by default but not passive tips", () => {
    const { rerender } = render(<Callout tone="danger" title="Sync failed">Reconnect Gmail.</Callout>);
    expect(screen.getByRole("alert")).toHaveTextContent("Sync failedReconnect Gmail.");
    rerender(<Callout tone="info">Tip</Callout>);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<Callout tone="warning" announce>Quota low</Callout>);
    expect(screen.getByRole("status")).toHaveTextContent("Quota low");
  });

  it("renders actions and a labelled dismiss button", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <Callout tone="warning" title="Trial ends soon" actions={<button type="button">Upgrade</button>} onDismiss={onDismiss} dismissLabel="Hide trial notice" />,
    );
    expect(screen.getByRole("button", { name: "Upgrade" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide trial notice" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("CopyButton", () => {
  function mockClipboard(writeText: (text: string) => Promise<void>) {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  }

  it("copies, confirms in place, announces and calls onCopied", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    const onCopied = vi.fn();
    render(<CopyButton value={() => "sk_test_123"} label="Copy API key" onCopied={onCopied} />);
    await user.click(screen.getByRole("button", { name: /Copy API key/ }));
    expect(writeText).toHaveBeenCalledWith("sk_test_123");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
    expect(onCopied).toHaveBeenCalled();
  });

  it("falls back to execCommand when the clipboard API is denied", async () => {
    const user = userEvent.setup();
    mockClipboard(vi.fn().mockRejectedValue(new Error("NotAllowedError")));
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    render(<CopyButton value="abc" />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(execCommand).toHaveBeenCalledWith("copy");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
  });

  it("names icon-only buttons and reports failures", async () => {
    const user = userEvent.setup();
    mockClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    Object.defineProperty(document, "execCommand", { value: vi.fn().mockReturnValue(false), configurable: true });
    const onError = vi.fn();
    render(<CopyButton value="https://example.test" label="Copy link" iconOnly onError={onError} />);
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Couldn’t copy" })).toBeInTheDocument());
    expect(onError).toHaveBeenCalled();
  });
});

describe("DescriptionList", () => {
  it("pairs labels with values and fills blanks", () => {
    render(
      <DescriptionList
        items={[
          { label: "Company", value: "Acme Hotels" },
          { label: "Phone", value: null },
          { label: "Notes", value: "", fullWidth: true },
        ]}
      />,
    );
    const terms = screen.getAllByRole("term").map((t) => t.textContent);
    const definitions = screen.getAllByRole("definition").map((d) => d.textContent);
    expect(terms).toEqual(["Company", "Phone", "Notes"]);
    expect(definitions).toEqual(["Acme Hotels", "—", "—"]);
  });

  it("shows skeletons while loading", () => {
    const { container } = render(<DescriptionList loading layout="inline" items={[{ label: "Plan", value: "Pro" }]} />);
    expect(screen.queryByText("Pro")).toBeNull();
    expect(container.querySelector("dl")).toHaveAttribute("aria-busy", "true");
  });
});

describe("StatusBadge", () => {
  it("maps status words to shared tones, case- and separator-insensitively", () => {
    expect(getStatusTone("FAILED")).toBe("danger");
    expect(getStatusTone("In progress")).toBe("progress");
    expect(getStatusTone("pending-review")).toBe("warning");
    expect(getStatusTone("something_new")).toBe("neutral");
    expect(getStatusTone(undefined)).toBe("neutral");
    expect(getStatusTone("draft", { draft: "info" })).toBe("info");
    expect(formatStatusLabel("awaiting_approval")).toBe("Awaiting approval");
  });

  it("always states the status in text", () => {
    const { rerender } = render(<StatusBadge status="scheduled" />);
    expect(screen.getByText("Scheduled").closest("[data-tone]")).toHaveAttribute("data-tone", "info");
    rerender(<StatusBadge status="sent" label="Delivered to inbox" />);
    expect(screen.getByText("Delivered to inbox").closest("[data-tone]")).toHaveAttribute("data-tone", "success");
    rerender(<StatusBadge status={null} />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
});
