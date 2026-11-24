import React, { createRef } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandToolkitForm, type BrandToolkitFormHandle } from "@/components/BrandToolkitForm";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), postForm: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/api", () => ({ default: mocks }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function form() {
  const ref = createRef<BrandToolkitFormHandle>();
  const onSave = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <BrandToolkitForm ref={ref} isCreateMode onSave={onSave} />
    </QueryClientProvider>,
  );
  return { ...view, ref, onSave };
}

async function navigate(panel: string) {
  await userEvent.click(screen.getByRole("button", { name: panel }));
  await screen.findByRole("heading", { name: panel });
}

function expectUniqueIds() {
  const ids = Array.from(document.querySelectorAll("[id]"), (element) => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const element of document.querySelectorAll("[aria-describedby], [aria-labelledby]")) {
    for (const attribute of ["aria-describedby", "aria-labelledby"]) {
      for (const id of element.getAttribute(attribute)?.split(" ") ?? []) {
        expect(document.getElementById(id)).not.toBeNull();
      }
    }
  }
}

const panels = [
  ["Brand Details", ["Auto-fill from Website", "Brand Name", "Tagline", "Website", "Industry", "Contact Email", "Phone Number", "Mission Statement", "Business Description"]],
  ["Visual Identity", ["Logo Usage Guidelines", "Image Style Reference", "Image & Video Instructions", "Primary Colors 1 hex value", "Secondary Colors 1 hex value", "Accent Color hex value", "Heading Font", "Body Font", "Accent Font"]],
  ["Voice & Values", ["Voice Type", "Custom Tone Guidelines", "Brand Values", "Brand Keywords", "Personality Traits", "Voice Keywords", "Voice Do's", "Voice Don'ts"]],
  ["Content Settings", ["Global Generation Instructions", "Approved Sample Content", "Content Pillars", "Content Formats", "Default Hashtags", "Default CTAs", "Audience Pain Points", "Audience Goals", "Audience Language Style", "Audience Triggers"]],
  ["Social Media", ["LinkedIn Page", "Twitter / X", "Instagram Profile", "Facebook Page", "YouTube Channel"]],
] as const;

describe("AS008 Brand Toolkit setup accessibility", () => {
  it.each(panels)("names every textbox on %s with persistent labels", async (panel, labels) => {
    form();
    await navigate(panel);
    for (const name of labels) {
      const field = screen.getByRole("textbox", { name });
      expect(screen.getByLabelText(name === "Brand Name" ? /^Brand Name/ : name, { exact: true })).toBe(field);
      expect(field.id).not.toBe("");
    }
    expect(screen.getAllByRole("textbox")).toHaveLength(labels.length);
    expectUniqueIds();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.postForm).not.toHaveBeenCalled();
  });

  it("announces Brand Name required state and associates the existing validation error", async () => {
    const { ref, onSave } = form();
    expect(screen.getByRole("textbox", { name: "Brand Name" })).toBeRequired();
    await navigate("Social Media");
    // Required-field validation is handled in the form, including animated-section focus.
    await act(async () => {
      await expect(ref.current?.triggerSave()).resolves.toBeUndefined();
    });
    const field = await screen.findByRole("textbox", { name: "Brand Name" });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveFocus();
    expect(field).toHaveAccessibleDescription("Please enter a brand name");
    expect(screen.getByRole("alert")).toHaveTextContent("Please enter a brand name");
    expect(onSave).not.toHaveBeenCalled();
    await userEvent.type(field, "Test brand");
    expect(field).not.toHaveAttribute("aria-invalid", "true");
    await ref.current?.triggerSave();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ brandName: "Test brand" }));
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("announces helper text and specific token actions, retaining keyboard focus on updates", async () => {
    form();
    await navigate("Voice & Values");
    const field = screen.getByRole("textbox", { name: "Brand Values" });
    expect(field).toHaveAccessibleDescription("Core principles guiding your business decisions.");
    for (const name of ["Brand Values", "Brand Keywords", "Personality Traits", "Voice Keywords", "Voice Do's", "Voice Don'ts"]) {
      expect(screen.getByRole("button", { name: `Add ${name}` })).toBeInTheDocument();
    }
    await userEvent.click(field);
    await userEvent.type(field, "Trust{Enter}");
    expect(field).toHaveFocus();
    expect(field).toHaveValue("");
    await userEvent.type(field, "Clarity");
    await userEvent.tab();
    const add = screen.getByRole("button", { name: "Add Brand Values" });
    expect(add).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(add).toHaveFocus();
    expect(screen.getByRole("button", { name: "Remove Trust from Brand Values" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove Clarity from Brand Values" }));
    expect(screen.queryByText("Clarity")).not.toBeInTheDocument();
    expectUniqueIds();
    await navigate("Content Settings");
    expect(screen.getByRole("textbox", { name: "Content Pillars" })).toHaveAccessibleDescription("Primary themes around which your content is built.");
    expect(screen.getByRole("textbox", { name: "Global Generation Instructions" })).toHaveAccessibleDescription("Applied to every email, SMS, social post, DM, ad, blog, image, and video prompt.");
    for (const name of panels[3][1].slice(2)) {
      expect(screen.getByRole("button", { name: `Add ${name}` })).toBeInTheDocument();
    }
  });

  it("keeps color controls distinct, with unique IDs after adding, removing and revisiting panels", async () => {
    form();
    const nameId = screen.getByRole("textbox", { name: "Brand Name" }).id;
    await navigate("Visual Identity");
    expect(screen.getByRole("checkbox")).toHaveAccessibleDescription("The approved logo will be sent to the image or video model as a visual reference and used with the rules below.");
    expect(screen.getByRole("textbox", { name: "Image & Video Instructions" })).toHaveAccessibleDescription("These rules are added to direct and background image/video generations.");
    const primaryId = screen.getByRole("textbox", { name: "Primary Colors 1 hex value" }).id;
    expect(screen.getByLabelText("Primary Colors 1 color picker")).toHaveAttribute("type", "color");
    expect(screen.getByLabelText("Secondary Colors 1 color picker")).toHaveAttribute("type", "color");
    expect(screen.getByLabelText("Accent Color color picker")).toHaveAttribute("type", "color");
    await userEvent.click(screen.getByRole("button", { name: "Add Color to primary palette" }));
    await userEvent.click(screen.getByRole("button", { name: "Add Color to secondary palette" }));
    expect(screen.getByRole("textbox", { name: "Primary Colors 2 hex value" })).toBeInTheDocument();
    expect(screen.getByLabelText("Secondary Colors 2 color picker")).toBeInTheDocument();
    expectUniqueIds();
    await userEvent.click(screen.getByRole("button", { name: "Remove primary color 1" }));
    expectUniqueIds();
    await navigate("Voice & Values");
    const tokenId = screen.getByRole("textbox", { name: "Brand Values" }).id;
    await navigate("Content Settings");
    expectUniqueIds();
    await navigate("Voice & Values");
    expect(screen.getByRole("textbox", { name: "Brand Values" }).id).toBe(tokenId);
    await navigate("Visual Identity");
    expect(screen.getByRole("textbox", { name: "Primary Colors 1 hex value" }).id).toBe(primaryId);
    await navigate("Brand Details");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Brand Name" }).id).toBe(nameId));
    expectUniqueIds();
  });

  it("does not duplicate IDs when two form instances render together", async () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <BrandToolkitForm isCreateMode />
        <BrandToolkitForm isCreateMode />
      </QueryClientProvider>,
    );
    expectUniqueIds();
    const fields = screen.getAllByRole("textbox", { name: "Brand Name" });
    expect(fields[0].id).not.toBe(fields[1].id);
    for (const button of screen.getAllByRole("button", { name: "Visual Identity" })) {
      await userEvent.click(button);
    }
    await waitFor(() => expect(container.querySelectorAll('input[type="color"]')).toHaveLength(6));
    expectUniqueIds();
  });
});
