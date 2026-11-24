import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContentCreatorBody,
  ContentCreatorComposer,
  ContentCreatorShell,
  ContentCreatorStage,
} from "@/components/content-studio/ContentCreatorShell";
import { CreatorScopeProvider } from "@/components/content-studio/CreatorScope";
vi.mock("@/components/content-studio/GeneratorReadiness", () => ({ GeneratorReadiness: () => null }));

// Regression: inside the campaign side pane the page is wide but the pane is
// not, so the Recent column was squeezed to one letter per line.
function renderAtWidth(width: number) {
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  render(
    <CreatorScopeProvider value={{ threadId: 235 }}>
      <ContentCreatorShell><ContentCreatorBody recentCount={2}>
        <ContentCreatorComposer><button data-creator-action>Generate</button></ContentCreatorComposer>
        <ContentCreatorStage preview={<p>Preview</p>}><p>Recent posts</p></ContentCreatorStage>
      </ContentCreatorBody></ContentCreatorShell>
    </CreatorScopeProvider>,
  );
  return rect;
}

afterEach(() => vi.restoreAllMocks());

describe("creator layout follows its own width", () => {
  it("uses Compose / Preview / Recent tabs in a narrow campaign pane", () => {
    renderAtWidth(600);
    expect(document.querySelector("[data-creator-workspace]")).toHaveAttribute("data-creator-layout", "tabs");
    expect(screen.getByRole("tablist", { name: "Creation workspace" })).not.toHaveClass("hidden");
    expect(document.querySelector("[data-creator-composer]")).toHaveClass("hidden");
    expect(document.querySelector("[data-creator-stage]")).toHaveClass("flex");
  });

  it("shows compose and preview side by side when the workspace is wide", () => {
    renderAtWidth(1200);
    expect(document.querySelector("[data-creator-workspace]")).toHaveAttribute("data-creator-layout", "wide");
    expect(screen.getByRole("tablist", { name: "Creation workspace" })).toHaveClass("hidden");
    expect(document.querySelector("[data-creator-composer]")).toHaveClass("flex");
    expect(document.querySelector("[data-creator-action-proxy]")).toBeNull();
  });
});
