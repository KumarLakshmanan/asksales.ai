import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlaybookQuestionsEditor } from "@/components/support/PlaybookQuestionsEditor";
import {
  PlaybookGraphEditor,
  type PlaybookGraph,
} from "@/components/support/PlaybookGraphEditor";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const graph: PlaybookGraph = {
  schemaVersion: 2,
  entryNodeId: "welcome",
  metadata: {
    presentationDefaults: {
      mode: "governed_hybrid",
      optionStrategy: "all",
      allowReordering: false,
      avoidRecentPhrasings: true,
      deterministicFallback: "Choose a visit.",
    },
  },
  fields: [
    {
      key: "journey.type",
      type: "single_select",
      required: true,
      pii: "none",
      prompt: "What visit are you planning?",
      options: [
        {
          value: "stay",
          label: "Stay",
          shortLabel: "Book stay",
          aliases: ["holiday"],
        },
      ],
    },
    {
      key: "stay.checkIn",
      type: "date",
      required: true,
      pii: "none",
      prompt: "When will you arrive?",
      validation: { futureOnly: true },
    },
    {
      key: "contact.fullName",
      type: "text",
      required: true,
      pii: "contact",
      prompt: "What is your name?",
      profileBinding: {
        attribute: "fullName",
        read: true,
        minimumTrust: "provider",
        writeBack: "never",
      },
    },
  ],
  nodes: [
    {
      id: "welcome",
      type: "collect",
      data: { label: "Choose visit", fieldKeys: ["journey.type"] },
    },
    {
      id: "done",
      type: "complete",
      data: { label: "Finish", instruction: "Thank the guest." },
    },
  ],
  edges: [
    {
      id: "next",
      source: "welcome",
      target: "done",
      condition: {
        operator: "field_equals",
        field: "journey.type",
        value: "stay",
      },
      priority: 42,
    },
  ],
  variants: [{ id: "main", weight: 100 }],
};

function Editor({
  steps = false,
  onChange = vi.fn(),
}: {
  steps?: boolean;
  onChange?: (g: PlaybookGraph) => void;
}) {
  const [value, setValue] = useState(graph);
  const update = (g: PlaybookGraph) => {
    setValue(g);
    onChange(g);
  };
  return steps ? (
    <PlaybookGraphEditor
      graph={value}
      onChange={update}
      section="flow"
      guided
    />
  ) : (
    <PlaybookQuestionsEditor graph={value} onChange={update} />
  );
}

describe("focused playbook questions", () => {
  it("shows only one question and keeps technical details collapsed", () => {
    render(<Editor />);
    expect(
      screen.getAllByLabelText("Question shown to the customer"),
    ).toHaveLength(1);
    expect(
      screen.getByText("Advanced: data & privacy").closest("details"),
    ).not.toHaveAttribute("open");
    expect(screen.getByLabelText("Question shown to the customer")).toHaveValue(
      "What visit are you planning?",
    );
  });
  it("searches prompts and switches to the matching question", () => {
    render(<Editor />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "arrive" },
    });
    expect(screen.getByLabelText("Question shown to the customer")).toHaveValue(
      "When will you arrive?",
    );
    expect(
      within(screen.getByRole("navigation")).getAllByRole("button"),
    ).toHaveLength(1);
  });
  it("changes only the selected wording, preserving branches, validation, bindings and variants", () => {
    const onChange = vi.fn();
    render(<Editor onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Check-in date/ }));
    fireEvent.change(screen.getByLabelText("Question shown to the customer"), {
      target: { value: "What date will you check in?" },
    });
    const updated = onChange.mock.calls.at(-1)![0];
    expect(updated).toEqual({
      ...graph,
      fields: graph.fields!.map((f, i) =>
        i === 1 ? { ...f, prompt: "What date will you check in?" } : f,
      ),
    });
  });
  it("preserves choice IDs, aliases and button labels when editing a label", () => {
    const onChange = vi.fn();
    render(<Editor onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Customer label"), {
      target: { value: "Overnight stay" },
    });
    expect(onChange.mock.calls.at(-1)![0].fields[0].options[0]).toEqual({
      ...graph.fields![0].options![0],
      label: "Overnight stay",
    });
  });
  it("adds a question without losing the rest of the graph", () => {
    const onChange = vi.fn();
    render(<Editor onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    expect(onChange.mock.calls.at(-1)![0].fields).toHaveLength(4);
    expect(screen.getByLabelText("Question shown to the customer")).toHaveValue(
      "What would you like to ask?",
    );
    expect(onChange.mock.calls.at(-1)![0].nodes).toEqual(graph.nodes);
  });
  it("does not remove a question when confirmation is cancelled", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const onChange = vi.fn();
    render(<Editor onChange={onChange} />);
    fireEvent.click(screen.getByText("Advanced: data & privacy"));
    fireEvent.click(screen.getByRole("button", { name: "Remove question" }));
    expect(onChange).not.toHaveBeenCalled();
  });
  it("disables edits in read-only mode", () => {
    render(
      <PlaybookQuestionsEditor graph={graph} onChange={vi.fn()} readOnly />,
    );
    expect(
      screen.getByLabelText("Question shown to the customer"),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add question" })).toBeDisabled();
  });
});

describe("guided flow editor", () => {
  it("opens steps without exposing every field, and edits the existing graph", () => {
    const onChange = vi.fn();
    render(<Editor steps onChange={onChange} />);
    expect(
      screen.queryByLabelText("Question shown to the customer"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Choose visit/ }));
    fireEvent.change(screen.getByLabelText("Step label"), {
      target: { value: "Choose your visit" },
    });
    expect(onChange.mock.calls.at(-1)![0].nodes[0].data).toEqual({
      ...graph.nodes[0].data,
      label: "Choose your visit",
    });
    expect(onChange.mock.calls.at(-1)![0].edges).toEqual(graph.edges);
  });
  it("opens the exact branch rule from a next-step link", () => {
    render(<Editor steps />);
    fireEvent.click(screen.getByRole("button", { name: /Choose visit/ }));
    fireEvent.click(
      within(screen.getByRole("region", { name: "Next steps" })).getByRole(
        "button",
        { name: /Finish/ },
      ),
    );
    expect(screen.getByText("Branch condition")).toBeInTheDocument();
    expect(screen.getByDisplayValue("stay")).toBeInTheDocument();
    expect(screen.getByDisplayValue("42")).toBeInTheDocument();
  });
});
