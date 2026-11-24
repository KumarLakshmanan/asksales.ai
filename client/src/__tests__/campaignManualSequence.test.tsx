import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import api from "@/lib/api";
import { loadReusableTemplates } from "@/lib/contentTemplateLibrary";
import {
  CampaignManualSequencePanel,
  formatDelayHint,
  useCampaignManualSequence,
} from "@/components/outreach/create/CampaignManualSequence";
import type { ManualSequence } from "../../../shared/campaignManualFollowUps";
vi.mock("@/lib/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));
vi.mock("@/lib/contentTemplateLibrary", () => ({
  loadReusableTemplates: vi.fn(),
}));
vi.mock("@/components/outreach/EmailMessageContent", () => ({
  EmailMessageContent: ({ content }: { content: string }) => <p>{content}</p>,
}));
const campaigns = [
  { kind: "chat_thread", id: 1, name: "HR" },
  { kind: "chat_thread", id: 2, name: "CXO" },
];
const sequence = (id: number, version = 1): ManualSequence => ({
  campaign: { kind: "chat_thread", id },
  channel: "email",
  mode: "manual",
  version,
  steps: [
    {
      delayMinutes: 60,
      templateId: id,
      templateName: id === 1 ? "HR template" : "CXO template",
      templateVersion: 1,
    },
  ],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation(async (url: string) =>
    url.endsWith("campaign-options")
      ? { campaigns }
      : (sequence(
          Number(
            new URL(url, "https://example.test").searchParams.get("campaignId"),
          ),
        ) as never),
  );
  const templates = [
    { id: 1, name: "HR template", isApproved: true },
    { id: 2, name: "CXO template", isApproved: true },
  ];
  vi.mocked(loadReusableTemplates).mockResolvedValue(templates);
  vi.mocked(api.put).mockImplementation(
    async (_url, input: any) =>
      ({
        ...sequence(input.campaign.id, input.expectedVersion + 1),
        mode: input.mode,
        steps: input.steps,
      }) as never,
  );
});
afterEach(cleanup);
describe("campaign the composer was opened from", () => {
  function Harness() {
    const model = useCampaignManualSequence('email', 'owner:10', undefined, { kind: 'chat_thread', id: 2 });
    return <CampaignManualSequencePanel model={model} />;
  }
  it('is preselected when the sequence is turned on, without loading it before then', async () => {
    render(<Harness />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/outreach/manual-follow-ups/campaign-options'));
    expect(vi.mocked(api.get).mock.calls.some(([url]) => String(url).includes('campaignId='))).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use a campaign manual sequence' }));
    await waitFor(() => expect(screen.getByLabelText('Manual follow-up campaign')).toHaveValue('chat_thread:2'));
    expect(await screen.findByText('Saved campaign revision 1')).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });
  it('does not ask for steps while the saved sequence is still loading', async () => {
    const pending = deferred<never>();
    vi.mocked(api.get).mockImplementation(async (url: string) => url.endsWith('campaign-options') ? { campaigns } as never : pending.promise);
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use a campaign manual sequence' }));
    await screen.findByText('Loading campaign sequence…');
    expect(screen.queryByText(/Add at least one step/)).toBeNull();
    pending.resolve(sequence(2) as never);
    expect(await screen.findByText('Saved campaign revision 1')).toBeInTheDocument();
  });
  it('shows long delays in days next to the minutes', async () => {
    vi.mocked(api.get).mockImplementation(async (url: string) => url.endsWith('campaign-options')
      ? { campaigns } as never
      : { ...sequence(2), steps: [{ delayMinutes: 4320, templateId: 2, templateName: 'CXO template', templateVersion: 1 }] } as never);
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use a campaign manual sequence' }));
    expect(await screen.findByText('(3 days)')).toBeInTheDocument();
  });
});

describe("formatDelayHint", () => {
  it.each([[30, ''], [60, '1 hour'], [4320, '3 days'], [10080, '7 days'], [1530, '1 day 1 hour 30 min']])('%i minutes → %s', (minutes, expected) => {
    expect(formatDelayHint(minutes)).toBe(expected);
  });
});

describe("campaign sequence editor state isolation", () => {
  it('distinguishes approved manual step templates with duplicate names while retaining numeric values', async () => {
    const approvedTemplates = [
      { id: 1, name: 'Shared follow-up', isApproved: true },
      { id: 2, name: 'Shared follow-up', isApproved: true },
      { id: 3, name: 'Unique follow-up', isApproved: true },
    ];
    vi.mocked(loadReusableTemplates).mockResolvedValue(approvedTemplates);
    function Harness() {
      const model = useCampaignManualSequence('email', 'owner:10', { kind: 'chat_thread', id: 1 });
      return <CampaignManualSequencePanel model={model} />;
    }
    render(<Harness />);
    expect(await screen.findByRole('option', { name: 'Shared follow-up · Template #1' })).toHaveValue('1');
    expect(screen.getByRole('option', { name: 'Shared follow-up · Template #2' })).toHaveValue('2');
    expect(screen.getByRole('option', { name: 'Unique follow-up' })).toHaveValue('3');
    await screen.findByText('Saved campaign revision 1');
    fireEvent.change(screen.getByLabelText('Step 1 template'), { target: { value: '2' } });
    expect(screen.getByLabelText('Step 1 template')).toHaveValue('2');
    expect(api.put).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });
  it('distinguishes duplicate campaign names and loads the selected kind and ID without saving', async () => {
    const duplicateCampaigns = [
      { kind: 'chat_thread', id: 187, name: 'Shared campaign' },
      { kind: 'chat_thread', id: 188, name: 'Shared campaign' },
      { kind: 'outreach_campaign', id: 187, name: 'Shared campaign' },
      { kind: 'chat_thread', id: 189, name: 'Unique campaign' },
    ];
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.endsWith('campaign-options')) return { campaigns: duplicateCampaigns } as never;
      const query = new URL(url, 'https://fixture.test').searchParams;
      const id = Number(query.get('campaignId'));
      const kind = query.get('kind');
      const workspace = kind === 'chat_thread';
      return { ...sequence(id, id === 187 ? 2 : 1), campaign: { kind, id }, steps: [{ delayMinutes: workspace ? (id === 187 ? 1500 : 2880) : 60, templateId: workspace && id === 187 ? 1 : 2, templateName: workspace && id === 187 ? 'HR template' : 'CXO template', templateVersion: 1 }] } as never;
    });
    function Harness() {
      const model = useCampaignManualSequence('email', 'owner:10');
      return <CampaignManualSequencePanel model={model} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use a campaign manual sequence' }));
    expect(await screen.findByRole('option', { name: 'Shared campaign · Campaign workspace #187' })).toHaveValue('chat_thread:187');
    expect(screen.getByRole('option', { name: 'Shared campaign · Campaign workspace #188' })).toHaveValue('chat_thread:188');
    expect(screen.getByRole('option', { name: 'Shared campaign · Outreach campaign' })).toHaveValue('outreach_campaign:187');
    expect(screen.getByRole('option', { name: 'Unique campaign · Campaign workspace' })).toHaveValue('chat_thread:189');
    const picker = screen.getByLabelText('Manual follow-up campaign');
    for (const expected of [
      { value: 'chat_thread:187', kind: 'chat_thread', id: 187, delay: 1500, template: '1', revision: 2 },
      { value: 'chat_thread:188', kind: 'chat_thread', id: 188, delay: 2880, template: '2', revision: 1 },
      { value: 'outreach_campaign:187', kind: 'outreach_campaign', id: 187, delay: 60, template: '2', revision: 2 },
    ]) {
      fireEvent.change(picker, { target: { value: expected.value } });
      await waitFor(() => expect(screen.getByLabelText('Step 1 delay minutes')).toHaveValue(expected.delay));
      expect(screen.getByLabelText('Step 1 template')).toHaveValue(expected.template);
      expect(screen.getByText(`Saved campaign revision ${expected.revision}`)).toBeInTheDocument();
      expect(picker).toHaveValue(expected.value);
      expect(api.get).toHaveBeenCalledWith(`/api/outreach/manual-follow-ups?kind=${expected.kind}&campaignId=${expected.id}&channel=email`);
    }
    expect(api.put).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("keeps new-campaign edits made before its initial 404 and enables save when loading finishes", async () => {
    const pending = deferred<ManualSequence>();
    vi.mocked(api.get).mockImplementation(async (url: string) =>
      url.endsWith("campaign-options")
        ? { campaigns }
        : (pending.promise as never),
    );
    vi.mocked(api.post).mockResolvedValue({
      kind: "chat_thread",
      id: 99,
      name: "New HR campaign",
    } as never);
    function Harness() {
      const model = useCampaignManualSequence("email", "owner:10");
      return <CampaignManualSequencePanel model={model} />;
    }
    render(<Harness />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Use a campaign manual sequence" }),
    );
    fireEvent.change(screen.getByLabelText("New manual campaign name"), {
      target: { value: "New HR campaign" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await screen.findByText("Loading campaign sequence…");
    fireEvent.click(screen.getByRole("button", { name: "Add manual step" }));
    fireEvent.change(screen.getByLabelText("Step 1 delay minutes"), {
      target: { value: "90" },
    });
    fireEvent.change(screen.getByLabelText("Step 1 template"), {
      target: { value: "1" },
    });
    expect(
      screen.getByRole("button", { name: "Save campaign sequence" }),
    ).toBeDisabled();
    await act(async () =>
      pending.reject(
        Object.assign(new Error("No sequence saved yet"), { status: 404 }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("Loading campaign sequence…"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Step 1 delay minutes")).toHaveValue(90);
    expect(screen.getByLabelText("Step 1 template")).toHaveValue("1");
    const save = screen.getByRole("button", { name: "Save campaign sequence" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/api/outreach/manual-follow-ups",
        expect.objectContaining({
          campaign: { kind: "chat_thread", id: 99 },
          expectedVersion: 0,
          mode: "manual",
          steps: [{ delayMinutes: 90, templateId: 1 }],
        }),
      ),
    );
    await screen.findByText("Saved campaign revision 1");
  });
  it.each(["manual", "off"] as const)(
    "preserves early %s edits while learning the existing campaign head version",
    async (mode) => {
      const pending = deferred<ManualSequence>();
      vi.mocked(api.get).mockImplementation(async (url: string) =>
        url.endsWith("campaign-options")
          ? { campaigns }
          : (pending.promise as never),
      );
      const hook = renderHook(() =>
        useCampaignManualSequence("email", "owner:10", {
          kind: "chat_thread",
          id: 1,
        }),
      );
      await waitFor(() => expect(hook.result.current.loading).toBe(true));
      act(() => {
        hook.result.current.setSteps([{ delayMinutes: 90, templateId: 2 }]);
        hook.result.current.setMode(mode);
      });
      await act(async () => hook.result.current.save());
      expect(api.put).not.toHaveBeenCalled();
      await act(async () => pending.resolve(sequence(1, 7)));
      await waitFor(() => expect(hook.result.current.loading).toBe(false));
      expect(hook.result.current.sequence?.version).toBe(7);
      expect(hook.result.current.steps).toEqual([
        { delayMinutes: 90, templateId: 2 },
      ]);
      expect(hook.result.current.mode).toBe(mode);
      expect(hook.result.current.dirty).toBe(true);
      expect(hook.result.current.ready).toBe(false);
      await act(async () => hook.result.current.save());
      expect(api.put).toHaveBeenCalledWith(
        "/api/outreach/manual-follow-ups",
        expect.objectContaining({
          expectedVersion: 7,
          mode,
          steps: mode === "off" ? [] : [{ delayMinutes: 90, templateId: 2 }],
        }),
      );
      expect(hook.result.current.sequence?.version).toBe(8);
      expect(hook.result.current.ready).toBe(true);
    },
  );
  it("settles a pending sequence read after reselecting the same campaign without edits", async () => {
    const pending = deferred<ManualSequence>();
    vi.mocked(api.get).mockImplementation(async (url: string) =>
      url.endsWith("campaign-options")
        ? { campaigns }
        : (pending.promise as never),
    );
    const hook = renderHook(() =>
      useCampaignManualSequence("email", "owner:10", {
        kind: "chat_thread",
        id: 1,
      }),
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(true));
    act(() => hook.result.current.setSelected("chat_thread:1"));
    await act(async () => pending.resolve(sequence(1, 7)));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.sequence?.version).toBe(7);
    expect(hook.result.current.steps[0].templateId).toBe(1);
    expect(hook.result.current.dirty).toBe(false);
    expect(hook.result.current.ready).toBe(true);
    await act(async () => hook.result.current.save());
    expect(api.put).toHaveBeenCalledWith(
      "/api/outreach/manual-follow-ups",
      expect.objectContaining({
        expectedVersion: 7,
        campaign: { kind: "chat_thread", id: 1 },
      }),
    );
  });
  it("clears loading after a failed initial read, keeps edits and blocks saving an unknown head", async () => {
    const pending = deferred<ManualSequence>();
    vi.mocked(api.get).mockImplementation(async (url: string) =>
      url.endsWith("campaign-options")
        ? { campaigns }
        : (pending.promise as never),
    );
    const hook = renderHook(() =>
      useCampaignManualSequence("email", "owner:10", {
        kind: "chat_thread",
        id: 1,
      }),
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(true));
    act(() =>
      hook.result.current.setSteps([{ delayMinutes: 90, templateId: 2 }]),
    );
    await act(async () =>
      pending.reject(
        Object.assign(new Error("Sequence read unavailable"), { status: 503 }),
      ),
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.steps).toEqual([
      { delayMinutes: 90, templateId: 2 },
    ]);
    expect(hook.result.current.loadFailed).toBe(true);
    expect(hook.result.current.error).toContain("read unavailable");
    await act(async () => hook.result.current.save());
    expect(api.put).not.toHaveBeenCalled();
  });
  it("loads HR and CXO saved sequences independently and reuses HR in a later batch", async () => {
    const hook = renderHook(() =>
      useCampaignManualSequence("email", "owner:10"),
    );
    await waitFor(() => expect(hook.result.current.campaigns).toHaveLength(2));
    act(() => {
      hook.result.current.setEnabled(true);
      hook.result.current.setSelected("chat_thread:1");
    });
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(hook.result.current.steps[0].templateId).toBe(1);
    act(() => hook.result.current.setSelected("chat_thread:2"));
    await waitFor(() =>
      expect(hook.result.current.sequence?.campaign.id).toBe(2),
    );
    expect(hook.result.current.steps[0].templateId).toBe(2);
    hook.unmount();
    const later = renderHook(() =>
      useCampaignManualSequence("email", "owner:10", {
        kind: "chat_thread",
        id: 1,
      }),
    );
    await waitFor(() => expect(later.result.current.ready).toBe(true));
    expect(later.result.current.enabled).toBe(true);
    expect(later.result.current.steps[0].templateId).toBe(1);
    expect(api.put).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(api.get)
        .mock.calls.every(
          ([url]) => !String(url).includes("/settings/integrations/"),
        ),
    ).toBe(true);
  });
  it("ignores an old sequence GET completing after selection switches to CXO", async () => {
    const old = deferred<ManualSequence>();
    vi.mocked(api.get).mockImplementation(async (url: string) =>
      url.endsWith("campaign-options")
        ? { campaigns }
        : url.includes("campaignId=1")
          ? old.promise
          : (sequence(2) as never),
    );
    const hook = renderHook(() =>
      useCampaignManualSequence("email", "owner:10"),
    );
    await waitFor(() => expect(hook.result.current.campaigns).toHaveLength(2));
    act(() => hook.result.current.setSelected("chat_thread:1"));
    await waitFor(() => expect(hook.result.current.loading).toBe(true));
    act(() => {
      hook.result.current.setSteps([{ delayMinutes: 90, templateId: 1 }]);
      hook.result.current.setMode("off");
    });
    act(() => hook.result.current.setSelected("chat_thread:2"));
    await waitFor(() =>
      expect(hook.result.current.sequence?.campaign.id).toBe(2),
    );
    await act(async () => old.resolve(sequence(1, 99)));
    expect(hook.result.current.sequence?.campaign.id).toBe(2);
    expect(hook.result.current.sequence?.version).toBe(1);
  });
  it("ignores a stale save after campaign selection changes", async () => {
    const save = deferred<ManualSequence>();
    vi.mocked(api.put).mockReturnValue(save.promise as never);
    const hook = renderHook(() =>
      useCampaignManualSequence("email", "owner:10", {
        kind: "chat_thread",
        id: 1,
      }),
    );
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    let saving: Promise<void>;
    act(() => {
      saving = hook.result.current.save();
    });
    act(() => hook.result.current.setSelected("chat_thread:2"));
    await waitFor(() =>
      expect(hook.result.current.sequence?.campaign.id).toBe(2),
    );
    await act(async () => {
      save.resolve(sequence(1, 8));
      await saving;
    });
    expect(hook.result.current.sequence?.campaign.id).toBe(2);
    expect(hook.result.current.saving).toBe(false);
  });
  it("ignores create completion after a business/channel switch", async () => {
    const creation = deferred<{ kind: string; id: number; name: string }>();
    vi.mocked(api.post).mockReturnValue(creation.promise as never);
    const hook = renderHook(
      ({ scope, channel }: { scope: string; channel: "email" | "sms" }) =>
        useCampaignManualSequence(channel, scope),
      { initialProps: { scope: "owner:10", channel: "email" } },
    );
    await waitFor(() => expect(hook.result.current.campaigns).toHaveLength(2));
    let creating: Promise<void>;
    act(() => {
      creating = hook.result.current.create("Old business campaign");
    });
    hook.rerender({ scope: "owner:20", channel: "sms" });
    await act(async () => {
      creation.resolve({
        kind: "chat_thread",
        id: 99,
        name: "Old business campaign",
      });
      await creating;
    });
    expect(hook.result.current.selected).toBe("");
    expect(hook.result.current.campaigns.some((item) => item.id === 99)).toBe(
      false,
    );
    expect(hook.result.current.ready).toBe(false);
    expect(hook.result.current.saving).toBe(false);
  });
  it("ignores old business campaign-list and old-channel template responses", async () => {
    const list = deferred<{ campaigns: typeof campaigns }>(),
      templates = deferred<any[]>();
    vi.mocked(api.get)
      .mockReturnValueOnce(list.promise as never)
      .mockResolvedValue({
        campaigns: [{ kind: "chat_thread", id: 3, name: "New business" }],
      } as never);
    const smsTemplates = [{ id: 3, name: "SMS template", isApproved: true }];
    vi.mocked(loadReusableTemplates)
      .mockReturnValueOnce(templates.promise)
      .mockResolvedValue(smsTemplates);
    const hook = renderHook(
      ({ scope, channel }: { scope: string; channel: "email" | "sms" }) =>
        useCampaignManualSequence(channel, scope),
      { initialProps: { scope: "owner:10", channel: "email" } },
    );
    hook.rerender({ scope: "owner:20", channel: "sms" });
    await waitFor(() => expect(hook.result.current.campaigns[0]?.id).toBe(3));
    await act(async () => {
      list.resolve({ campaigns });
      templates.resolve([{ id: 1, name: "Old email", isApproved: true }]);
    });
    expect(hook.result.current.campaigns[0].id).toBe(3);
    expect(hook.result.current.templates[0].name).toBe("SMS template");
  });
  it("keeps edits blocked after a stale version conflict until explicit reload and review", async () => {
    vi.mocked(api.put).mockRejectedValue(
      new Error("This campaign sequence changed. Reload and review."),
    );
    const hook = renderHook(() =>
      useCampaignManualSequence("email", "owner:10", {
        kind: "chat_thread",
        id: 1,
      }),
    );
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    act(() =>
      hook.result.current.setSteps([{ delayMinutes: 90, templateId: 1 }]),
    );
    expect(hook.result.current.ready).toBe(false);
    await act(async () => hook.result.current.save());
    expect(hook.result.current.error).toContain("Reload and review");
    expect(hook.result.current.steps[0].delayMinutes).toBe(90);
    expect(hook.result.current.ready).toBe(false);
    expect(api.put).toHaveBeenCalledWith(
      "/api/outreach/manual-follow-ups",
      expect.objectContaining({
        expectedVersion: 1,
        campaign: { kind: "chat_thread", id: 1 },
      }),
    );
  });
  it("offers campaign draft setup while delivery providers/assistant are absent", async () => {
    function Harness() {
      const model = useCampaignManualSequence("email", "owner:10", {
        kind: "chat_thread",
        id: 1,
      });
      return <CampaignManualSequencePanel model={model} />;
    }
    render(<Harness />);
    await screen.findByText("Saved campaign revision 1");
    fireEvent.click(
      screen.getByRole("button", { name: "Save campaign sequence" }),
    );
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Step 1 template")).toHaveValue("1");
  });
});
