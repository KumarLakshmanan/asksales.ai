import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CreativeResearchPanel } from "@/components/performance-marketing/CreativeResearchPanel";
import { CreativeBriefHandoff } from "@/components/content-studio/CreativeBriefHandoff";
import api from "@/lib/api";
const navigation = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.params,
  useRouter: () => ({ replace: navigation.replace, push: navigation.push }),
}));
vi.mock("@/lib/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));
beforeEach(() => {
  vi.clearAllMocks();
  navigation.params = new URLSearchParams();
});
afterEach(cleanup);
const concept = {
  id: "concept-a",
  title: "Show the workflow",
  format: "video",
  hook: "Open on the product",
  headline: "One shared calendar",
  copyDirection: "Use approved features",
  visualDirection: "Screen capture",
  scenes: ["Show rescheduling"],
  ctaText: "Book a demo",
  ctaType: "book_now",
  rationale: "Test clarity",
  evidenceIds: ["1:1"],
  uncertainty: "Untested hypothesis",
  testVariable: "Opening hook",
  requiredAssets: ["Approved product recording"],
};
const brief = {
  id: 7,
  status: "ready",
  revision: 2,
  selected_concept_id: "concept-a",
  input: { language: "English" },
  concepts: [concept],
  evidence: [
    {
      id: "1:1",
      pageName: "Competitor",
      bodies: ["Observed copy"],
      url: "https://example.com/ad",
    },
  ],
};
it("keeps the panel visible when disabled and explains setup instead of disappearing", async () => {
  vi.mocked(api.get).mockImplementation(async (url) =>
    String(url).endsWith("/capabilities")
      ? ({ enabled: false, commercialLibraryCountries: [] } as never)
      : ([] as never),
  );
  render(<CreativeResearchPanel />);
  expect(await screen.findByText(/New competitor research is not enabled/)).toBeInTheDocument();
  expect(screen.getByText("Competitor creative research")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save research" })).not.toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
});
it("restores the latest saved suggestions on entering Recommendations", async () => {
  vi.mocked(api.get).mockImplementation(async (url) =>
    String(url).endsWith("/capabilities")
      ? ({ enabled: true, commercialLibraryCountries: [] } as never)
      : ([{ id: 7, title: "CRM campaign", status: "ready" }] as never),
  );
  render(<CreativeResearchPanel />);
  await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith(
    "/dashboard/ads?tab=recommendations&creativeBrief=7", { scroll: false },
  ));
});
it("offers an actionable empty state and prevents empty manual research", async () => {
  vi.mocked(api.get).mockImplementation(async (url) =>
    String(url).endsWith("/capabilities")
      ? ({ enabled: true, commercialLibraryCountries: [] } as never)
      : ([] as never),
  );
  render(<CreativeResearchPanel />);
  expect(await screen.findByText(/No competitor suggestions yet/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save research" })).toBeDisabled();
});
it("offers public India and All ads discovery without a Meta account", async () => {
  vi.mocked(api.get).mockImplementation(async (url) => {
    if (String(url).endsWith("/capabilities"))
      return { enabled: true, commercialLibraryCountries: ["GB"] } as never;
    if (String(url).endsWith("/competitor-profiles"))
      return {status:"provider_error",profiles:[],message:"Public Meta Ad Library search is unavailable."} as never;
    return [] as never;
  });
  render(<CreativeResearchPanel />);
  const link = await screen.findByRole("link", { name: "Open public Meta Ads Library" });
  expect(link).toHaveAttribute("href", expect.stringContaining("ad_type=all&country=IN"));
  fireEvent.click(screen.getByRole("button", { name: "Fetch competitor profiles" }));
  await waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/campaigns/creative-intelligence/competitor-profiles"));
  expect(await screen.findByText(/Public Meta Ad Library search is unavailable/)).toBeInTheDocument();
  expect(api.get).not.toHaveBeenCalledWith("/api/campaigns/accounts");
});
it("copies a public advertiser observation into manual research", async () => {
  vi.mocked(api.get).mockImplementation(async (url) => {
    const path = String(url);
    if (path.endsWith("/capabilities")) return { enabled: true, commercialLibraryCountries: ["GB"] } as never;
    if (path.includes("/competitor-profiles/Advertiser/ads")) return {status:"succeeded",message:"Research sample",references:[{id:"123456789",pageName:"Advertiser",titles:["Ad"],bodies:["Copy"],descriptions:[],platforms:[],format:"video",engagement:{likes:null,comments:null,shares:null},startDate:null,endDate:null,url:"https://business.facebook.com/ads/library/?id=123456789",estimatedEuReach:null}]} as never;
    if (path.includes("/competitor-ads/123456789/details")) return {status:"succeeded",reach:145709,reachLocation:"European Union",regionalReach:[{location:"European Union",reach:145709},{location:"United Kingdom",reach:30110}],reachBreakdown:[{location:"Austria",ageRange:"25-34",gender:"Female",reach:150}],engagement:{likes:null,comments:null,shares:null},message:"Estimated reach from Meta transparency."} as never;
    if (path.endsWith("/competitor-profiles")) return {status:"succeeded",message:"Found",profiles:[{pageName:"Advertiser",sampleAdCount:1,matchedTerms:["software"],libraryUrl:"https://www.facebook.com/ads/library/?q=Advertiser"}]} as never;
    return [] as never;
  });
  vi.mocked(api.post).mockResolvedValue({id:21,status:"queued",references:[]} as never);
  render(<CreativeResearchPanel />);
  const fetchProfiles = await screen.findByRole("button", {name:"Fetch competitor profiles"});
  expect(api.get).not.toHaveBeenCalledWith("/api/campaigns/creative-intelligence/competitor-profiles");
  fireEvent.click(fetchProfiles);
  expect(api.get).toHaveBeenCalledWith("/api/campaigns/creative-intelligence/competitor-profiles");
  fireEvent.click(await screen.findByRole("button", {name:"Fetch ads"}));
  await screen.findByText("Creative suggestion from this evidence");
  expect(await screen.findByText(`Estimated reach in European Union: ${(145709).toLocaleString()}`)).toBeInTheDocument();
  expect(screen.getByText(`Estimated reach in United Kingdom: ${(30110).toLocaleString()}`)).toBeInTheDocument();
  expect(screen.getByText(/Likes\/reactions: unavailable · Comments: unavailable · Shares: unavailable/)).toBeInTheDocument();
  const useFormat = screen.getByRole("link", {name:"Use this format"});
  expect(useFormat).toHaveAttribute("href", expect.stringContaining("sourceFormat=video"));
  expect(useFormat).toHaveAttribute("href", expect.stringContaining("sourceAdId=123456789"));
  fireEvent.click(await screen.findByRole("button", {name:"Add observed ad to research"}));
  expect(screen.getByLabelText("Competitor name")).toHaveValue("Advertiser");
  fireEvent.click(screen.getByRole("button", {name:"Save research"}));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/campaigns/creative-intelligence/research", expect.objectContaining({source:"manual",country:"IN"})));
});
it("renders a saved brief with evidence and an explicit draft handoff without publishing", async () => {
  navigation.params = new URLSearchParams("creativeBrief=7");
  vi.mocked(api.get).mockImplementation(async (url) => {
    if (String(url).endsWith("/capabilities"))
      return { enabled: true, commercialLibraryCountries: ["GB"] } as never;
    if (String(url).endsWith("/briefs/7")) return brief as never;
    return [] as never;
  });
  render(<CreativeResearchPanel />);
  expect(await screen.findByText("Show the workflow")).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Review ad-generation inputs" })).toBeEnabled();
  expect(screen.getByText("Untested hypothesis")).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
  expect(api.patch).not.toHaveBeenCalled();
});
it("opens a canonical draft review after a click without a chat/ICP detour", async () => {
  navigation.params = new URLSearchParams("creativeBriefId=7");
  vi.mocked(api.get).mockResolvedValue(brief as never);
  vi.mocked(api.post).mockResolvedValue({ threadId: 28, widgetId: 91 } as never);
  render(<CreativeBriefHandoff />);
  const button = await screen.findByRole("button", {
    name: "Open ad-generation review",
  });
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/dashboard/conversations/28"));
  expect(api.post).toHaveBeenCalledWith("/api/campaigns/creative-intelligence/briefs/7/draft-review", { revision: 2, conceptId: "concept-a" });
});
it("rejects an unselected handoff without inserting content", async () => {
  navigation.params = new URLSearchParams("creativeBriefId=7");
  vi.mocked(api.get).mockResolvedValue({
    ...brief,
    selected_concept_id: null,
  } as never);
  render(<CreativeBriefHandoff />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Choose a ready concept",
  );
  expect(api.post).not.toHaveBeenCalled();
});
it("carries saved competitor research into suggestions and requires concept selection before handoff", async () => {
  navigation.params = new URLSearchParams("tab=recommendations&account=2&period=7d&creativeCampaign=42");
  vi.mocked(api.get).mockImplementation(async (url) =>
    String(url).endsWith("/capabilities")
      ? ({ enabled: true, commercialLibraryCountries: ["GB"] } as never)
      : ([] as never),
  );
  const savedResearch = {
    id: 21,
    status: "succeeded",
    message: "Manual observations",
    references: [
      {
        id: "manual-1",
        pageName: "Competitor",
        bodies: ["Observed copy"],
        notes: "",
        format: "image",
        signals: [],
        source: "manual",
        observedAt: "2026-10-06T00:00:00Z",
      },
    ],
  };
  vi.mocked(api.post).mockImplementation(async (url) =>
    String(url).endsWith("/research")
      ? (savedResearch as never)
      : ({
          ...brief,
          selected_concept_id: null,
          input: { language: "English", objective: "leads" },
        } as never),
  );
  vi.mocked(api.patch).mockResolvedValue({
    ...brief,
    input: { language: "English", objective: "leads" },
  } as never);
  render(<CreativeResearchPanel />);
  fireEvent.change(await screen.findByLabelText("Competitor name"), {
    target: { value: "Competitor" },
  });
  fireEvent.change(screen.getByLabelText("Observed ad copy"), {
    target: { value: "Observed copy" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save research" }));
  fireEvent.change(
    await screen.findByLabelText("Product, offer and verified benefits"),
    { target: { value: "A shared appointment calendar" } },
  );
  fireEvent.change(screen.getByLabelText("Target audience"), {
    target: { value: "Salon owners" },
  });
  const researchUrl = new URL(navigation.replace.mock.calls.at(-1)![0], "https://asksales.test");
  expect(Object.fromEntries(researchUrl.searchParams)).toMatchObject({ account: "2", period: "7d", creativeCampaign: "42", creativeResearch: "21" });
  fireEvent.click(screen.getByRole("button", { name: "Suggest ad creatives" }));
  await screen.findByText("Show the workflow");
  expect(
    screen.queryByRole("button", { name: "Review ad-generation inputs" }),
  ).not.toBeInTheDocument();
  expect(api.post).toHaveBeenCalledWith(
    "/api/campaigns/creative-intelligence/briefs",
    expect.objectContaining({
      researchRunIds: [21],
      businessFacts: "A shared appointment calendar",
      audience: "Salon owners",
      requestId: expect.any(String),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose concept" }));
  expect(await screen.findByRole("button", { name: "Review ad-generation inputs" })).toBeEnabled();
  const briefUrl = new URL(navigation.replace.mock.calls.at(-1)![0], "https://asksales.test");
  expect(Object.fromEntries(briefUrl.searchParams)).toMatchObject({ account: "2", period: "7d", creativeCampaign: "42", creativeBrief: "7" });
  expect(briefUrl.searchParams.has("creativeResearch")).toBe(false);
  expect(api.patch).toHaveBeenCalledWith(
    "/api/campaigns/creative-intelligence/briefs/7",
    { revision: 2, conceptId: "concept-a" },
  );
  expect(
    vi
      .mocked(api.post)
      .mock.calls.every(([url]) =>
        String(url).startsWith("/api/campaigns/creative-intelligence/"),
      ),
  ).toBe(true);
});

it("restores saved research after reload so suggestions can be generated", async () => {
  navigation.params = new URLSearchParams("creativeResearch=21");
  vi.mocked(api.get).mockImplementation(async (url) => {
    if (String(url).endsWith("/capabilities")) return { enabled: true, commercialLibraryCountries: [] } as never;
    if (String(url).endsWith("/research/21")) return {
      id: 21, status: "succeeded", references: [{
        id: "manual-1", pageName: "Competitor", bodies: ["Observed copy"],
        format: "image", signals: [], source: "manual", observedAt: "2026-10-06",
      }],
    } as never;
    return [] as never;
  });
  render(<CreativeResearchPanel />);
  expect(await screen.findByLabelText("Product, offer and verified benefits")).toBeInTheDocument();
  expect(screen.getByText("Observed copy")).toBeInTheDocument();
  expect(navigation.replace).not.toHaveBeenCalled();
});
it("recovers from a capability request failure without losing the panel", async () => {
  vi.mocked(api.get).mockRejectedValueOnce(new Error("Connection unavailable"));
  render(<CreativeResearchPanel />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection unavailable");
  vi.mocked(api.get).mockImplementation(async (url) =>
    String(url).endsWith("/capabilities")
      ? ({ enabled: true, commercialLibraryCountries: [] } as never)
      : ([] as never),
  );
  fireEvent.click(screen.getByRole("button", { name: "Check availability again" }));
  expect(await screen.findByLabelText("Competitor name")).toBeInTheDocument();
});
