import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { widgetRegistry } from "@/components/widgets/registry";
import type { WidgetState, WidgetType } from "@/components/widgets/types";

vi.mock("@/lib/api", () => ({
  default: {
    get: vi.fn().mockReturnValue(new Promise(() => undefined)),
    post: vi.fn().mockResolvedValue({ success: true }),
  },
  api: {
    get: vi.fn().mockReturnValue(new Promise(() => undefined)),
    post: vi.fn().mockResolvedValue({ success: true }),
  },
}));

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => cleanup());
afterAll(() => vi.unstubAllGlobals());

describe("agent widget registry", () => {
  it.each(Object.entries(widgetRegistry))(
    "renders %s with empty persisted form data",
    (widgetType, definition) => {
      const widget: WidgetState = {
        id: 1,
        threadId: 133,
        messageId: 1,
        toolName: definition.toolName,
        widgetType: widgetType as WidgetType,
        formValues: {},
        status: "active",
        agentType: "orchestrator",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      const Component = definition.component;

      expect(() => render(
        <Component
          widget={widget}
          onClose={vi.fn()}
          onSubmit={vi.fn()}
          onFormChange={vi.fn()}
        />,
      )).not.toThrow();
    },
  );

  it.each([
    ["publish_ads", ["meta", "google"]],
    ["publish_meta_ads", ["meta"]],
    ["publish_google_ads", ["google"]],
  ] as const)("preserves the campaign contract while waiting for the authoritative %s review", async (toolName, platforms) => {
    const onFormChange = vi.fn();
    const definition = widgetRegistry.publish_ads;
    const widget: WidgetState = {
      id: 7,
      threadId: 133,
      messageId: 9,
      toolName,
      widgetType: "publish_ads",
      formValues: {
        ...(toolName === "publish_ads" ? { platforms: ["meta", "google"] } : {}),
        campaign_id: "42",
        asset_ids: [101, 102],
        campaign_name: "Launch campaign",
        objective: "leads",
        budget_amount_minor: 12500,
        currency: "INR",
        landing_url: "https://example.com/offer",
        provider_account_ids: { meta: "act_123", google: "customers/456" },
        creative_revision: 3,
        locations: [{ countryCode: "US" }],
      },
      status: "active",
      agentType: "performance_marketing",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    const view = render(
      <definition.component
        widget={widget}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        onFormChange={onFormChange}
      />,
    );

    expect(view.getByRole('status')).toHaveTextContent('Loading the saved campaign, accounts and creative');
    expect(view.queryByLabelText('Lifetime Budget')).not.toBeInTheDocument();
    await waitFor(() => expect(onFormChange).toHaveBeenCalled());
    expect(onFormChange.mock.calls.at(-1)?.[0]).toMatchObject({
      campaign_id: "42",
      platforms,
      asset_ids: [101, 102],
      budget_amount_minor: 12500,
      currency: "INR",
      landing_url: "https://example.com/offer",
      budget_type: "lifetime",
      provider_account_ids: { meta: "act_123", google: "customers/456" },
      creative_revision: 3,
      locations: [{ countryCode: "US" }],
      _review_validation_error: 'Loading the saved campaign review…',
    });
    expect(onFormChange.mock.calls.at(-1)?.[0]).not.toHaveProperty('review_revision');
  });
});
