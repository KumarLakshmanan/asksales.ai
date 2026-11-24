import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SearchInput } from "@/components/ui/search-input";
import { Pagination, getPaginationRange } from "@/components/ui/pagination";
import { StatCard } from "@/components/ui/stat-card";
import { FileDropzone, validateFiles } from "@/components/ui/file-dropzone";
import { DataTable, sortRows, type DataTableColumn } from "@/components/ui/data-table";

afterEach(cleanup);

describe("Spinner", () => {
  it("announces a label by default and hides itself when decorative", () => {
    const { rerender } = render(<Spinner label="Loading leads" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading leads");
    rerender(<Spinner label={null} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Button loading", () => {
  it("stays focusable, blocks clicks and swaps the label", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    rerender(<Button onClick={onClick} loading loadingText="Saving…">Save</Button>);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(button).toHaveTextContent("Saving…");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not submit a form while loading", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<form onSubmit={onSubmit}><Button type="submit" loading>Send</Button></form>);
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("SearchInput", () => {
  it("debounces onSearch, trims, and fires immediately on Enter", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<SearchInput aria-label="Search leads" onSearch={onSearch} debounceMs={250} />);
    const input = screen.getByRole("searchbox", { name: "Search leads" });
    await user.type(input, "  acme ");
    expect(onSearch).not.toHaveBeenCalled();
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith("acme"));
    expect(onSearch).toHaveBeenCalledTimes(1);
    await user.type(input, "x{Enter}");
    expect(onSearch).toHaveBeenLastCalledWith("acme x");
  });

  it("clears with the button and Escape, returning focus to the field", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<SearchInput aria-label="Search" defaultValue="abc" onSearch={onSearch} />);
    const input = screen.getByRole("searchbox");
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(onSearch).toHaveBeenLastCalledWith("");
    await user.type(input, "q");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
  });

  it("lets Escape bubble when the field is already empty", () => {
    const onParentKeyDown = vi.fn();
    render(<div onKeyDown={onParentKeyDown}><SearchInput aria-label="Search" /></div>);
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(onParentKeyDown).toHaveBeenCalled();
  });

  it("works controlled and does not re-emit after an external reset", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    function Fixture() {
      const [value, setValue] = useState("");
      return (
        <>
          <SearchInput aria-label="Search" value={value} onValueChange={setValue} onSearch={onSearch} debounceMs={0} />
          <button type="button" onClick={() => setValue("")}>Reset filters</button>
        </>
      );
    }
    render(<Fixture />);
    await user.type(screen.getByRole("searchbox"), "ab");
    expect(onSearch).toHaveBeenLastCalledWith("ab");
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.getByRole("searchbox")).toHaveValue("");
    const calls = onSearch.mock.calls.length;
    await user.type(screen.getByRole("searchbox"), "a");
    expect(onSearch).toHaveBeenCalledTimes(calls + 1);
  });
});

describe("Pagination", () => {
  it("computes clamped ranges", () => {
    expect(getPaginationRange(1, 25, 0)).toMatchObject({ current: 1, totalPages: 1, from: 0, to: 0 });
    expect(getPaginationRange(3, 25, 60)).toMatchObject({ current: 3, totalPages: 3, from: 51, to: 60 });
    expect(getPaginationRange(99, 25, 60)).toMatchObject({ current: 3 });
    expect(getPaginationRange(0, 0, 10)).toMatchObject({ current: 1, totalPages: 10 });
  });

  it("navigates and disables controls at the ends", async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    const { rerender } = render(
      <Pagination page={1} pageSize={10} totalItems={35} onPageChange={onPageChange} itemLabel="leads" />,
    );
    const nav = screen.getByRole("navigation", { name: "Pagination" });
    expect(nav).toHaveTextContent("Showing 1–10 of 35 leads");
    expect(within(nav).getByRole("button", { name: "Previous page" })).toBeDisabled();
    await user.click(within(nav).getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    await user.click(within(nav).getByRole("button", { name: "Last page" }));
    expect(onPageChange).toHaveBeenLastCalledWith(4);
    rerender(<Pagination page={4} pageSize={10} totalItems={35} onPageChange={onPageChange} />);
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("navigation")).toHaveTextContent("Showing 31–35 of 35");
  });
});

describe("StatCard", () => {
  it("states the trend in words and colours by which direction is good", () => {
    render(
      <StatCard
        label="Cost per lead"
        value="₹42"
        delta={{ value: "8%", trend: "up", positiveDirection: "down", label: "vs last week" }}
      />,
    );
    const delta = screen.getByText("8%").closest("span");
    expect(delta).toHaveTextContent("Up 8%");
    expect(delta?.className).toContain("text-destructive");
  });

  it("shows a placeholder rather than zero when there is no value, and a skeleton while loading", () => {
    const { rerender, container } = render(<StatCard label="Replies" value={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    rerender(<StatCard label="Replies" value={12} loading />);
    expect(screen.queryByText("12")).toBeNull();
    expect(container.querySelector("article")).toHaveAttribute("aria-busy", "true");
  });
});

describe("FileDropzone", () => {
  const csv = (name: string, bytes = 10) => new File(["x".repeat(bytes)], name, { type: "text/csv" });

  it("validates type, size, emptiness and count", () => {
    const png = new File(["x"], "logo.png", { type: "image/png" });
    const { accepted, rejected } = validateFiles(
      [csv("a.csv"), png, csv("big.csv", 2000), csv("empty.csv", 0), csv("b.csv"), csv("c.csv")],
      { accept: ".csv", maxSize: 1000, multiple: true, maxFiles: 2 },
    );
    expect(accepted.map((f) => f.name)).toEqual(["a.csv", "b.csv"]);
    expect(rejected.map((r) => r.reason)).toEqual(["file-type", "file-too-large", "file-empty", "too-many-files"]);
    expect(validateFiles([png], { accept: "image/*" }).accepted).toHaveLength(1);
  });

  it("accepts picked files through a labelled native input and lists rejections", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const onFilesAccepted = vi.fn();
    const onFilesRejected = vi.fn();
    render(
      <FileDropzone accept=".csv" maxSize={1000} onFilesAccepted={onFilesAccepted} onFilesRejected={onFilesRejected} />,
    );
    const input = screen.getByLabelText(/choose a file/i);
    expect(input).toHaveAccessibleDescription(/CSV · up to 1000 B/);
    await user.upload(input, csv("leads.csv"));
    expect(onFilesAccepted).toHaveBeenCalledWith([expect.objectContaining({ name: "leads.csv" })]);
    await user.upload(input, new File(["x"], "photo.png", { type: "image/png" }));
    expect(onFilesRejected).toHaveBeenCalled();
    expect(screen.getByText(/photo.png isn’t a supported file type/)).toBeInTheDocument();
  });

  it("builds a readable constraint hint from accept", () => {
    render(<FileDropzone accept="image/*,application/pdf,.csv" onFilesAccepted={vi.fn()} />);
    expect(screen.getByText("Images, PDF, CSV")).toBeInTheDocument();
  });

  it("ignores drops while loading", () => {
    const onFilesAccepted = vi.fn();
    render(<FileDropzone onFilesAccepted={onFilesAccepted} loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Uploading…");
    const zone = screen.getByText("Uploading…").closest("label")!;
    fireEvent.drop(zone, { dataTransfer: { files: [csv("a.csv")] } });
    expect(onFilesAccepted).not.toHaveBeenCalled();
  });
});

describe("DataTable", () => {
  type Lead = { id: string; name: string; score: number | null };
  const leads: Lead[] = [
    { id: "1", name: "Beta", score: 40 },
    { id: "2", name: "alpha", score: null },
    { id: "3", name: "Gamma", score: 90 },
  ];
  const columns: DataTableColumn<Lead>[] = [
    { id: "name", header: "Name", cell: (row) => row.name, sortValue: (row) => row.name },
    { id: "score", header: "Score", cell: (row) => row.score ?? "—", sortValue: (row) => row.score, align: "right" },
  ];
  const names = () =>
    screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent);

  it("sorts case-insensitively and keeps empty values last in both directions", () => {
    expect(sortRows(leads, columns, { columnId: "name", direction: "asc" }).map((l) => l.name)).toEqual(["alpha", "Beta", "Gamma"]);
    expect(sortRows(leads, columns, { columnId: "score", direction: "asc" }).map((l) => l.id)).toEqual(["1", "3", "2"]);
    expect(sortRows(leads, columns, { columnId: "score", direction: "desc" }).map((l) => l.id)).toEqual(["3", "1", "2"]);
  });

  it("cycles sort through asc, desc and none with aria-sort", async () => {
    const user = userEvent.setup();
    render(<DataTable caption="Leads" columns={columns} data={leads} getRowId={(l) => l.id} />);
    const header = screen.getByRole("columnheader", { name: /Name/ });
    expect(header).toHaveAttribute("aria-sort", "none");
    await user.click(within(header).getByRole("button"));
    expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(names()).toEqual(["alpha", "Beta", "Gamma"]);
    await user.click(within(header).getByRole("button"));
    expect(header).toHaveAttribute("aria-sort", "descending");
    await user.click(within(header).getByRole("button"));
    expect(names()).toEqual(["Beta", "alpha", "Gamma"]);
  });

  it("shows skeletons on first load, then empty, error and retry states", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(<DataTable caption="Leads" columns={columns} data={undefined} loading getRowId={(l) => l.id} />);
    expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByRole("row")).toHaveLength(1); // skeleton rows are aria-hidden
    rerender(<DataTable caption="Leads" columns={columns} data={[]} getRowId={(l) => l.id} emptyState={<p>No leads yet</p>} />);
    expect(screen.getByText("No leads yet")).toBeInTheDocument();
    rerender(<DataTable caption="Leads" columns={columns} data={leads} error="Couldn’t load leads." onRetry={onRetry} getRowId={(l) => l.id} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t load leads.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("selects rows, with an indeterminate select-all", async () => {
    const user = userEvent.setup();
    function Fixture() {
      const [selected, setSelected] = useState<Set<string>>(new Set());
      return (
        <DataTable
          caption="Leads"
          columns={columns}
          data={leads}
          getRowId={(l) => l.id}
          selectedRowIds={selected}
          onSelectedRowIdsChange={setSelected}
          getRowSelectionLabel={(l) => `Select ${l.name}`}
        />
      );
    }
    render(<Fixture />);
    await user.click(screen.getByRole("checkbox", { name: "Select Beta" }));
    expect(screen.getByRole("checkbox", { name: "Select all rows" })).toHaveAttribute("data-state", "indeterminate");
    await user.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(screen.getByRole("checkbox", { name: "Select Gamma" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Deselect all rows" }));
    expect(screen.getByRole("checkbox", { name: "Select Gamma" })).not.toBeChecked();
  });

  it("disables select-all when an error hides the rows", () => {
    render(
      <DataTable caption="Leads" columns={columns} data={leads} getRowId={(l) => l.id} error="Failed"
        selectedRowIds={new Set(["1"])} onSelectedRowIdsChange={vi.fn()} />,
    );
    const selectAll = screen.getByRole("checkbox", { name: "Select all rows" });
    expect(selectAll).toBeDisabled();
    expect(selectAll).toHaveAttribute("data-state", "unchecked");
  });

  it("opens rows by click and keyboard but not from controls inside the row", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const onAction = vi.fn();
    const withAction: DataTableColumn<Lead>[] = [
      ...columns,
      { id: "action", header: "Action", cell: () => <button type="button" onClick={onAction}>Archive</button> },
    ];
    render(
      <DataTable caption="Leads" columns={withAction} data={leads} getRowId={(l) => l.id} onRowClick={onRowClick} getRowLabel={(l) => `Open ${l.name}`} />,
    );
    await user.click(screen.getAllByRole("button", { name: "Archive" })[0]);
    expect(onAction).toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
    const row = screen.getByRole("row", { name: "Open Gamma" });
    row.focus();
    await user.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenCalledWith(leads[2]);
  });
});
