import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessageViewport } from "@/components/conversation/ChatMessageViewport";
import { SourceTray } from "@/components/conversation/SourceTray";

let resize: () => void;
let frame: FrameRequestCallback | undefined;
const disconnect = vi.fn();
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn(() => {
      frame = undefined;
    }),
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  frame = undefined;
});

describe("support message viewport", () => {
  it("keeps a new conversation at the top and follows its first message", () => {
    const view = render(
      <ChatMessageViewport sessionKey={1} messages={[{ role: "assistant" }]}>
        Saved messages
      </ChatMessageViewport>,
    );
    const viewport = screen.getByRole("region", { name: "Support messages" });
    Object.defineProperties(viewport, {
      scrollHeight: { value: 1200 },
      clientHeight: { value: 400 },
    });
    act(() => {
      resize();
      frame?.(0);
    });
    expect(viewport.scrollTop).toBe(1200);
    view.rerender(
      <ChatMessageViewport sessionKey={null} messages={[]}>
        Start a conversation
      </ChatMessageViewport>,
    );
    expect(viewport.scrollTop).toBe(0);
    act(() => {
      resize();
      frame?.(0);
    });
    expect(viewport.scrollTop).toBe(0);
    view.rerender(
      <ChatMessageViewport sessionKey={null} messages={[{ role: "user" }]}>
        First question
      </ChatMessageViewport>,
    );
    expect(viewport.scrollTop).toBe(1200);
  });

  it("scrolls only the message viewport, never clipped ancestors", () => {
    const messages = [{ role: "user" }];
    const view = render(
      <div data-testid="outer">
        <ChatMessageViewport sessionKey={1} messages={messages}>
          Message
        </ChatMessageViewport>
      </div>,
    );
    const viewport = screen.getByRole("region", { name: "Support messages" });
    Object.defineProperties(viewport, {
      scrollHeight: { value: 1800, configurable: true },
      clientHeight: { value: 500 },
    });
    view.rerender(
      <div data-testid="outer">
        <ChatMessageViewport
          sessionKey={1}
          messages={[...messages, { role: "assistant" }]}
        >
          Long response
        </ChatMessageViewport>
      </div>,
    );
    expect(viewport.scrollTop).toBe(1800);
    expect(screen.getByTestId("outer").scrollTop).toBe(0);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(viewport.className).toContain("min-h-0");
    expect(viewport.className).toContain("overflow-y-auto");
  });

  it("follows growing responses but respects reading older history until a new send", () => {
    const messages = [{ role: "assistant" }];
    const view = render(
      <ChatMessageViewport sessionKey={1} messages={messages}>
        Message
      </ChatMessageViewport>,
    );
    const viewport = screen.getByRole("region", { name: "Support messages" });
    Object.defineProperties(viewport, {
      scrollHeight: { value: 1800, configurable: true },
      clientHeight: { value: 500 },
    });
    act(() => {
      resize();
      frame?.(0);
    });
    expect(viewport.scrollTop).toBe(1800);
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    Object.defineProperty(viewport, "scrollHeight", { value: 2200 });
    act(() => {
      resize();
      frame?.(0);
    });
    view.rerender(
      <ChatMessageViewport
        sessionKey={1}
        messages={[...messages, { role: "assistant" }]}
      >
        More content
      </ChatMessageViewport>,
    );
    expect(viewport.scrollTop).toBe(100);
    view.rerender(
      <ChatMessageViewport
        sessionKey={1}
        messages={[...messages, { role: "user" }]}
      >
        New question
      </ChatMessageViewport>,
    );
    expect(viewport.scrollTop).toBe(2200);
  });

  it("resets on session change and follows history loaded later", () => {
    const view = render(
      <ChatMessageViewport sessionKey={1} messages={[{ role: "assistant" }]}>
        First
      </ChatMessageViewport>,
    );
    const viewport = screen.getByRole("region", { name: "Support messages" });
    Object.defineProperties(viewport, {
      scrollHeight: { value: 1400 },
      clientHeight: { value: 500 },
    });
    act(() => {
      resize();
      frame?.(0);
    });
    viewport.scrollTop = 30;
    fireEvent.scroll(viewport);
    view.rerender(
      <ChatMessageViewport sessionKey={2} messages={[]} busy>
        Loading
      </ChatMessageViewport>,
    );
    view.rerender(
      <ChatMessageViewport sessionKey={2} messages={[{ role: "assistant" }]}>
        Loaded
      </ChatMessageViewport>,
    );
    expect(viewport.scrollTop).toBe(1400);
    act(() => resize());
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it("does not mistake scroll anchoring during resize for manual history scrolling", () => {
    render(
      <ChatMessageViewport sessionKey={1} messages={[{ role: "assistant" }]}>
        Message
      </ChatMessageViewport>,
    );
    const viewport = screen.getByRole("region", { name: "Support messages" });
    Object.defineProperties(viewport, {
      scrollHeight: { value: 1800, configurable: true },
      clientHeight: { value: 500 },
    });
    act(() => {
      resize();
      frame?.(0);
    });
    Object.defineProperty(viewport, "scrollHeight", { value: 3000 });
    viewport.scrollTop = 1600;
    fireEvent.scroll(viewport);
    act(() => {
      resize();
      frame?.(0);
    });
    expect(viewport.scrollTop).toBe(3000);
  });
});

describe("grounding evidence labels", () => {
  it.each([1, 0.9, 0, Number.NaN])(
    "never labels a source-free response highly grounded (%s)",
    (confidence) => {
      render(<SourceTray sources={[]} confidence={confidence} />);
      expect(screen.queryByText("High grounding")).not.toBeInTheDocument();
      expect(screen.getByText("No source evidence")).toBeInTheDocument();
    },
  );
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1])(
    "rejects invalid confidence with evidence (%s)",
    (confidence) => {
      render(
        <SourceTray sources={[{ title: "Policy" }]} confidence={confidence} />,
      );
      expect(screen.getByText("Review suggested")).toBeInTheDocument();
    },
  );
});
