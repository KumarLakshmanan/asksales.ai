import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContactAutomationRecovery } from "@/components/crm/ContactAutomationRecovery";
import CRMImportPage from "@/app/dashboard/(main)/crm/import/page";
import { ApiError } from "@/lib/api";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  postForm: vi.fn(),
  toast: vi.fn(),
  navigate:vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  default: mocks,
  api: mocks,
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.navigate }) }));
const clients: QueryClient[] = [];
function mount(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.setItem("user", JSON.stringify({ id: 9 }));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});
const receipt = {
  transitionId: 73,
  status: "pending",
  events: [
    {
      type: "pipeline_status_change",
      status: "pending",
      oldValue: "new",
      newValue: "qualified_custom",
    },
  ],
};
it("reads saved recovery receipts after mounting and retries pending discovery by exact transition", async () => {
  mocks.get.mockResolvedValue({
    data: [receipt],
    pagination: { page: 1, totalPages: 1 },
  });
  mocks.post.mockResolvedValue({});
  const changed = vi.fn();
  mount(
    <ContactAutomationRecovery
      contactId={42}
      scope="9:101"
      onChanged={changed}
    />,
  );
  expect(await screen.findByText(/Saved transition #73/)).toBeVisible();
  expect(mocks.post).not.toHaveBeenCalled();
  mocks.get.mockResolvedValue({
    data: [
      {
        ...receipt,
        status: "completed",
        events: [{ ...receipt.events[0], status: "completed" }],
      },
    ],
    pagination: { page: 1, totalPages: 1 },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Retry pending evaluation" }),
  );
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/crm/contacts/42/automation-handoffs/73/retry",
      {},
    ),
  );
  expect(
    await screen.findByText(/Saved transition #73 · Evaluation completed/),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Retry pending evaluation" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Link to transition #73" }),
  ).toHaveAttribute("href", "#automation-transition-73");
});
it("offers no replay for processing or uncertain legacy evaluations", async () => {
  mocks.get.mockResolvedValue({
    data: [
      {
        ...receipt,
        status: "review_required",
        events: [{ ...receipt.events[0], status: "processing" }],
      },
    ],
    pagination: { page: 1, totalPages: 1 },
  });
  mount(
    <ContactAutomationRecovery
      contactId={42}
      scope="9:101"
      onChanged={vi.fn()}
    />,
  );
  expect(await screen.findByText(/Review this transition/)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Retry pending evaluation" }),
  ).not.toBeInTheDocument();
  expect(mocks.post).not.toHaveBeenCalled();
});
async function upload(view: ReturnType<typeof render>) {
  const file = new File(
    ["email,company\nfixture@example.test,Synthetic"],
    "fixture.csv",
    { type: "text/csv" },
  );
  fireEvent.change(view.container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
  await screen.findByRole("button", { name: "Import Contacts" });
  return file;
}
it("reconciles a 503 import receipt instead of presenting partial committed work as a fresh failure", async () => {
  mocks.postForm.mockRejectedValueOnce(
    new ApiError("Interrupted", 503, { importId: 73, retryable: true }),
  );
  mocks.get.mockResolvedValue({
    id: 73,
    importId: 73,
    totalRecords: 2,
    processedRecords: 1,
    successCount: 1,
    duplicateCount: 0,
    errorCount: 0,
    skippedCount: 0,
    warningCount: 0,
    issues: [],
    importStatus: "processing",
    recovery: { needsResubmission: true, canResumeByFingerprint: true },
  });
  const view = mount(<CRMImportPage />);
  await upload(view);
  fireEvent.click(screen.getByRole("button", { name: "Import Contacts" }));
  await waitFor(() =>
    expect(mocks.get).toHaveBeenCalledWith("/api/crm/imports/73"),
  );
  expect(await screen.findByText(/Import #73/)).toBeVisible();
});
const completeImport = {
  importId: 73,
  totalRecords: 1,
  successCount: 1,
  duplicateCount: 0,
  errorCount: 0,
  skippedCount: 0,
  warningCount: 0,
  issues: [],
  importStatus: "completed",
};
it('retains a background import receipt across reload without claiming the import finished',async()=>{
  const id='10000000-0000-4000-8000-000000000073';
  mocks.postForm.mockResolvedValueOnce({operationId:id,importStatus:'queued'});
  const view=mount(<CRMImportPage/>);await upload(view);fireEvent.click(screen.getByRole('button',{name:'Import Contacts'}));
  fireEvent.click(await screen.findByRole('button',{name:'View background import'}));
  expect(mocks.navigate).toHaveBeenCalledWith(`/dashboard/crm/import/analyze?operationId=${id}`);
  expect(screen.queryByText('Import Complete')).not.toBeInTheDocument();
  view.unmount();mount(<CRMImportPage/>);
  expect(await screen.findByRole('button',{name:'View background import'})).toBeVisible();
  expect(mocks.postForm).toHaveBeenCalledTimes(1);
});
it("reconciles a lost response with the identical file and frozen mapping", async () => {
  mocks.postForm
    .mockRejectedValueOnce(new TypeError("Synthetic lost response"))
    .mockResolvedValueOnce(completeImport);
  const view = mount(<CRMImportPage />);
  const file = await upload(view);
  fireEvent.click(screen.getByRole("button", { name: "Import Contacts" }));
  expect(await screen.findByText(/The response was lost/)).toBeVisible();
  expect(mocks.postForm).toHaveBeenCalledTimes(1);
  expect(
    screen
      .getAllByRole("combobox")
      .every((input) => (input as HTMLButtonElement).disabled),
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Reconcile same import" }),
  );
  await waitFor(() =>
    expect(screen.getByText("Import Complete")).toBeVisible(),
  );
  expect(mocks.postForm).toHaveBeenCalledTimes(2);
  const first = mocks.postForm.mock.calls[0][1] as FormData,
    second = mocks.postForm.mock.calls[1][1] as FormData;
  expect(first.get("file")).toBe(file);
  expect(second.get("file")).toBe(file);
  expect(first.get("columnMapping")).toBe(second.get("columnMapping"));
});
it("reads a completed receipt after interruption and remount without another import write", async () => {
  mocks.postForm.mockRejectedValueOnce(
    new ApiError("Interrupted", 503, { importId: 73, retryable: true }),
  );
  mocks.get.mockResolvedValue(completeImport);
  const view = mount(<CRMImportPage />);
  await upload(view);
  fireEvent.click(screen.getByRole("button", { name: "Import Contacts" }));
  await waitFor(() =>
    expect(screen.getByText("Import Complete")).toBeVisible(),
  );
  view.unmount();
  mount(<CRMImportPage />);
  await waitFor(() =>
    expect(screen.getByText("Import Complete")).toBeVisible(),
  );
  expect(mocks.postForm).toHaveBeenCalledTimes(1);
  expect(mocks.get).toHaveBeenCalledTimes(2);
  const stored = Object.values(sessionStorage).join("");
  expect(stored).not.toContain("fixture@example.test");
  expect(stored).not.toContain("Synthetic");
});
it("rejects a different CSV when resuming a preserved receipt", async () => {
  mocks.postForm.mockRejectedValueOnce(
    new ApiError("Interrupted", 503, { importId: 73, retryable: true }),
  );
  mocks.get.mockResolvedValue({
    ...completeImport,
    importStatus: "processing",
    totalRecords: 2,
    processedRecords: 1,
  });
  const view = mount(<CRMImportPage />);
  await upload(view);
  fireEvent.click(screen.getByRole("button", { name: "Import Contacts" }));
  await screen.findByText(/Import #73/);
  view.unmount();
  const next = mount(<CRMImportPage />);
  await screen.findByText(/Import #73/);
  fireEvent.change(next.container.querySelector('input[type="file"]')!, {
    target: {
      files: [
        new File(
          ["email,company\nother@example.test,Different"],
          "fixture.csv",
          { type: "text/csv" },
        ),
      ],
    },
  });
  await waitFor(() =>
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          "Choose the exact original CSV file to resume this import.",
      }),
    ),
  );
  expect(mocks.postForm).toHaveBeenCalledTimes(1);
});
it("does not refresh a former contact scope when its recovery response arrives after unmount", async () => {
  mocks.get.mockResolvedValue({
    data: [receipt],
    pagination: { page: 1, totalPages: 1 },
  });
  let resolve!: (value: unknown) => void;
  mocks.post.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const changed = vi.fn();
  const view = mount(
    <ContactAutomationRecovery
      contactId={42}
      scope="9:101"
      onChanged={changed}
    />,
  );
  await screen.findByRole("button", { name: "Retry pending evaluation" });
  fireEvent.click(
    screen.getByRole("button", { name: "Retry pending evaluation" }),
  );
  view.unmount();
  resolve({});
  await Promise.resolve();
  await Promise.resolve();
  expect(changed).not.toHaveBeenCalled();
});
it("can start another import explicitly without implying rollback of already saved contacts", async () => {
  mocks.postForm.mockRejectedValueOnce(
    new ApiError("Interrupted", 503, { importId: 73, retryable: true }),
  );
  mocks.get.mockResolvedValue({
    ...completeImport,
    importStatus: "processing",
    totalRecords: 2,
    processedRecords: 1,
  });
  const view = mount(<CRMImportPage />);
  await upload(view);
  fireEvent.click(screen.getByRole("button", { name: "Import Contacts" }));
  await screen.findByText(/Import #73/);
  fireEvent.click(screen.getByRole("button", { name: "Start another import" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Reconcile same import" }),
    ).not.toBeInTheDocument(),
  );
  expect(view.container.querySelector("input[type=file]")).toBeInTheDocument();
  expect(mocks.postForm).toHaveBeenCalledTimes(1);
});
