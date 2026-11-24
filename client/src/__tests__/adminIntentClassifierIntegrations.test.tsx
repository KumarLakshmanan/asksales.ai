import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), push: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/admin-api", () => ({ api: { get: mocks.get, post: mocks.post, put: mocks.put, delete: mocks.delete } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/components/ui/switch", () => ({ Switch: ({ checked, onCheckedChange, ...props }: any) =>
  <button role="switch" aria-checked={checked} onClick={onCheckedChange} {...props} /> }));
vi.mock("@/components/admin/ConfirmDialog", () => ({ ConfirmDialog: ({ open, onConfirm }: any) =>
  open ? <button onClick={onConfirm}>Confirm delete</button> : null }));

import Page from "@/app/admin/dashboard/integrations/intent-classifier/page";
import IntegrationCredentialForm from "@/components/admin/IntegrationCredentialForm";
import { PLATFORM_CONFIGS } from "@/lib/admin-integration-platforms";

const credential = { id: 7, platform: "openrouter", name: "Jev primary", apiKey: "••••••••", isActive: true,
  priority: "high", config: { model: "typesafe/jev-1.13" }, usageCount: 3, lastUsedAt: null };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockImplementation(async (url: string) => url.includes("genai-provider-models") ? { models: [] }
    : url.includes("genai-model-price") ? null : { credentials: [credential] });
  mocks.post.mockResolvedValue({ success: true, test: { success: true, message: "Classifier responded with a valid decision" } });
  mocks.delete.mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe("Intent Classifier integrations", () => {
  it("shows Jev, active priority, usage, and all five provider choices", async () => {
    render(<Page />);
    expect(await screen.findByText("Jev primary")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText(/3 uses/)).toBeInTheDocument();
    for (const label of ["OpenRouter", "OpenAI", "Gemini", "Vertex AI", "Custom AI"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });
  it("tests, toggles, edits, and deletes from the classifier endpoint", async () => {
    render(<Page />);
    await screen.findByText("Jev primary");
    fireEvent.click(screen.getByRole("button", { name: "Test Jev primary" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/admin/intent-classifier-integrations/7/test"));
    fireEvent.click(screen.getByRole("switch", { name: "Toggle Jev primary" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/admin/intent-classifier-integrations/7/toggle"));
    fireEvent.click(screen.getByRole("button", { name: "Edit Jev primary" }));
    expect(mocks.push).toHaveBeenCalledWith("/admin/dashboard/integrations/intent-classifier/openrouter/edit/7");
    fireEvent.click(screen.getByRole("button", { name: "Delete Jev primary" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith("/api/admin/intent-classifier-integrations/7"));
  });
  it("defaults a new OpenRouter classifier to Jev", async () => {
    render(<IntegrationCredentialForm platform="openrouter" config={PLATFORM_CONFIGS.openrouter} classifier />);
    expect(screen.getByDisplayValue("typesafe/jev-1.13")).toBeInTheDocument();
  });
});
