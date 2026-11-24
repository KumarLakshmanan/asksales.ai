import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import api from "@/lib/api";
import { WhatsAppTemplateEditor } from "@/components/outreach/create/WhatsAppTemplateEditor";
import { InboxWhatsAppTemplate } from "@/components/outreach/inbox/InboxWhatsAppTemplate";
import {
  buildOutreachTemplate,
  type OutreachRecipient,
} from "../../../shared/outreachCompose";
vi.mock("@/lib/api", () => ({ default: { upload: vi.fn(), get: vi.fn() } }));
const templates = [
  {
    id: "8",
    name: "2nightstay",
    language: "en",
    headerType: "IMAGE",
    body: "Your weekdays deserve a break too.",
  },
  { id: "9", name: "welcome", language: "en", body: "Hello" },
];
let changes = vi.fn<(id: string) => void>();
function Harness({ account = "1234" }: { account?: string }) {
  const [id, setId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <WhatsAppTemplateEditor
      templates={templates}
      templateId={id}
      values={values}
      providerAccountId={account}
      onTemplateChange={(next) => {
        changes(next);
        setId(next);
        setValues({});
      }}
      onValuesChange={setValues}
    />
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  changes = vi.fn();
  vi.mocked(api.upload).mockResolvedValue({ mediaId: "98765" });
  URL.createObjectURL = vi.fn(() => "blob:template-photo");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);
async function open() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Choose a template/ }));
  return user;
}
describe("template selection drawer", () => {
  it("searches and cancels without changing the composer", async () => {
    render(<Harness />);
    const user = await open();
    await user.type(screen.getByLabelText("Search templates"), "2night");
    expect(
      screen.queryByRole("button", { name: /welcome/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /2nightstay/ }));
    expect(screen.getByRole("button", { name: "Use template" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(changes).not.toHaveBeenCalled();
  });
  it("uploads media for the selected account and applies only after success", async () => {
    render(<Harness />);
    const user = await open();
    await user.click(screen.getByRole("button", { name: /2nightstay/ }));
    await user.upload(
      screen.getByLabelText("Upload template image"),
      new File(["png"], "offer.png", { type: "image/png" }),
    );
    await screen.findByText("Ready · offer.png");
    const form = vi.mocked(api.upload).mock.calls[0][1];
    expect(form.get("providerAccountId")).toBe("1234");
    expect(form.get("mediaType")).toBe("image");
    expect(screen.getByAltText("Template image preview")).toHaveAttribute(
      "src",
      "blob:template-photo",
    );
    await user.click(screen.getByRole("button", { name: "Use template" }));
    expect(changes).toHaveBeenCalledWith("8");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("shows an upload error and leaves Apply disabled", async () => {
    vi.mocked(api.upload).mockRejectedValue(new Error("Upload unavailable"));
    render(<Harness />);
    const user = await open();
    await user.click(screen.getByRole("button", { name: /2nightstay/ }));
    await user.upload(
      screen.getByLabelText("Upload template image"),
      new File(["png"], "offer.png", { type: "image/png" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Upload unavailable",
    );
    expect(screen.getByRole("button", { name: "Use template" })).toBeDisabled();
  });
  it("discards late upload results after cancellation", async () => {
    let resolve!: (value: { mediaId: string }) => void;
    vi.mocked(api.upload).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }) as never,
    );
    render(<Harness />);
    const user = await open();
    await user.click(screen.getByRole("button", { name: /2nightstay/ }));
    await user.upload(
      screen.getByLabelText("Upload template image"),
      new File(["png"], "offer.png", { type: "image/png" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    resolve({ mediaId: "stale" });
    await open();
    expect(screen.queryByText("Ready · offer.png")).not.toBeInTheDocument();
    expect(changes).not.toHaveBeenCalled();
  });
  it("closes and resets pending selection when the sending account changes", async () => {
    const view = render(<Harness />);
    const user = await open();
    await user.click(screen.getByRole("button", { name: /2nightstay/ }));
    view.rerender(<Harness account="5678" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("builds uploaded headers using a media ID instead of a URL", () => {
    const recipient = { id: 1, name: "Test" } as OutreachRecipient;
    const result = buildOutreachTemplate(
      templates[0],
      { mediaId: "98765" },
      recipient,
    );
    expect(result.missing).toEqual([]);
    expect(result.templateComponents).toEqual([
      {
        type: "header",
        parameters: [{ type: "image", image: { id: "98765" } }],
      },
    ]);
  });
});

describe("Inbox template drawer", () => {
  it("applies an uploaded media ID and clears the payload on account changes", async () => {
    vi.mocked(api.get).mockResolvedValue({ templates });
    const onChange = vi.fn();
    const view = render(
      <InboxWhatsAppTemplate providerAccountId="1234" onChange={onChange} />,
    );
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    const user = await open();
    await user.click(await screen.findByRole("button", { name: /2nightstay/ }));
    await user.upload(
      screen.getByLabelText("Upload template image"),
      new File(["png"], "offer.png", { type: "image/png" }),
    );
    await screen.findByText("Ready · offer.png");
    await user.click(screen.getByRole("button", { name: "Use template" }));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          templateName: "2nightstay",
          templateComponents: [
            {
              type: "header",
              parameters: [{ type: "image", image: { id: "98765" } }],
            },
          ],
        }),
      ),
    );
    view.rerender(
      <InboxWhatsAppTemplate providerAccountId="5678" onChange={onChange} />,
    );
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null));
  });
});
