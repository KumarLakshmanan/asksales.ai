import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeChannelEvent, WebhookEventsWorkspace } from "@/components/integrations/WebhookEventsWorkspace";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ default: mocks, api: mocks }));

describe("channel activity", () => {
  beforeEach(() => { mocks.get.mockReset(); });

  it("shows an Instagram message in plain language without exposing callback setup or JSON", async () => {
    mocks.get.mockResolvedValue({ events: [{ id: 41, platform: "instagram", source: "webhook_log", event_type: "incoming", created_at: "2026-08-25T04:30:00.000Z", payload: { entry: [{ messaging: [{ message: { text: "Hello" } }] }] } }] });
    render(<WebhookEventsWorkspace platform="instagram" platformLabel="Instagram" />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith("/api/integrations/instagram/webhook-events?limit=100"));
    expect(await screen.findByText("New message")).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.queryByText(/verify token|webhook URL|JSON|subscription endpoint/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /New message/ }));
    expect(screen.getByRole("heading", { name: "New message" })).toBeInTheDocument();
  });

  it("loads only the selected channel and shows a useful empty state", async () => {
    mocks.get.mockResolvedValue({ events: [] });
    render(<WebhookEventsWorkspace platform="facebook" platformLabel="Facebook" />);
    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith("/api/integrations/facebook/webhook-events?limit=100");
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("summarizes delivery problems without showing provider payload fields", () => {
    const view = describeChannelEvent({ id: 1, event_type: "email.bounced", payload: { api_key: "hidden" } }, "Email");
    expect(view.title).toBe("Delivery needs attention");
    expect(view.summary).not.toContain("hidden");
  });

  it("shows stored WhatsApp messages and Instagram comments as customer activity", () => {
    expect(describeChannelEvent({ id: 1, event_type: "whatsapp_message", message_text: "Can you help?" }, "WhatsApp")).toMatchObject({
      title: "New message", summary: "Can you help?", category: "Messages",
    });
    expect(describeChannelEvent({ id: 2, event_type: "comment", comment_text: "Great product" }, "Instagram")).toMatchObject({
      title: "New comment", summary: "Great product", category: "Comments",
    });
    expect(describeChannelEvent({ id: 3, event_type: "facebook_feed", payload: { item: "comment", message: "Please call me" } }, "Facebook")).toMatchObject({
      title: "New comment", summary: "Please call me", category: "Comments",
    });
  });
});
