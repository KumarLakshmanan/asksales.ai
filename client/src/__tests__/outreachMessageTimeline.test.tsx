import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OutreachMessageTimeline } from "@/components/outreach/OutreachMessageTimeline";
import type { OutreachChannel, OutreachMessage } from "@/components/outreach/types";

vi.mock("@/components/outreach/OutreachMessageBubble", () => ({
  OutreachMessageBubble: ({ message }: { message: OutreachMessage }) => <div role="listitem">{message.content}</div>,
}));

afterEach(cleanup);

const message = (id: number, createdAt: string): OutreachMessage => ({
  id,
  conversationId: 1,
  direction: "inbound",
  content: `Message ${id}`,
  status: "received",
  sentAt: null,
  deliveredAt: null,
  readAt: null,
  isRead: false,
  createdAt,
});

it.each(["whatsapp", "facebook", "instagram", "email"] as OutreachChannel[])(
  "shows day dividers at the actual Kolkata date boundary for %s",
  (channel) => {
    render(
      <OutreachMessageTimeline
        channel={channel}
        messages={[
          message(1, "2026-09-22T18:29:00Z"),
          message(2, "2026-09-22T18:31:00Z"),
          message(3, "2026-09-23T04:00:00Z"),
        ]}
      />,
    );

    expect(screen.getAllByRole("separator")).toHaveLength(2);
    expect(screen.getByRole("separator", { name: "22 September 2026" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "23 September 2026" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  },
);
