import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import api from "@/lib/api";
import { DuplicateContactsDialog, defaultKeptContact } from "@/components/crm/DuplicateContactsDialog";

vi.mock("@/lib/api", () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const contact = (id: number, conversations: number, extra = {}) => ({
  id, name: "Lakshmanan", email: "lakshmanan.coder@gmail.com", phone: "916382775774", company: null,
  source: "import", createdAt: "2026-10-29T07:18:34Z", lastActivityAt: null, conversations, ...extra,
});
const group = { matchedOn: ["email", "phone"] as Array<"phone" | "email">, contacts: [contact(2, 12, { source: "whatsapp" }), contact(694, 0), contact(695, 1)] };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.get).mockResolvedValueOnce({ data: [group] }).mockResolvedValue({ data: [] });
  vi.mocked(api.post).mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe("possible duplicate contacts", () => {
  it("keeps the contact with the most history by default", () => {
    expect(defaultKeptContact(group)).toBe(2);
    expect(defaultKeptContact({ matchedOn: ["email"], contacts: [contact(9, 0), contact(4, 0)] })).toBe(4);
  });

  it("merges the others into the kept contact only after confirmation", async () => {
    const onMerged = vi.fn();
    const user = userEvent.setup();
    render(<DuplicateContactsDialog open onOpenChange={() => {}} onMerged={onMerged} />);
    expect(await screen.findByText("Same phone and email")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Merge into Lakshmanan" }));
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByText(/Merge 2 contacts into Lakshmanan\? This can't be undone\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Merge 3 contacts" }));
    await waitFor(() => expect(onMerged).toHaveBeenCalled());
    expect(vi.mocked(api.post).mock.calls).toEqual([
      ["/api/crm/contacts/694/merge", { intoContactId: 2 }],
      ["/api/crm/contacts/695/merge", { intoContactId: 2 }],
    ]);
    expect(await screen.findByText("No contacts share a phone number or email.")).toBeInTheDocument();
  });

  it("lets the person keep a different contact", async () => {
    const user = userEvent.setup();
    render(<DuplicateContactsDialog open onOpenChange={() => {}} onMerged={() => {}} />);
    const radios = await screen.findAllByRole("radio");
    await user.click(radios[2]);
    await user.click(screen.getByRole("button", { name: "Merge into Lakshmanan" }));
    await user.click(screen.getByRole("button", { name: "Merge 3 contacts" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.post).mock.calls.map(call => call[1])).toEqual([{ intoContactId: 695 }, { intoContactId: 695 }]);
  });
});
