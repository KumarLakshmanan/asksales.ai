import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "@/app/dashboard/(main)/settings/page";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), toast: vi.fn(),
  logout: vi.fn(), push: vi.fn(), replace: vi.fn(),
}));
const router = { push: mocks.push, replace: mocks.replace };
const searchParams = new URLSearchParams("tab=security");
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/dashboard/settings",
  useSearchParams: () => searchParams,
}));
vi.mock("@/lib/api", () => ({ default: mocks }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ logout: mocks.logout }) }));

const fields = [
  { id: "currentPassword", label: "Current Password", context: "current" },
  { id: "newPassword", label: "New Password", context: "new" },
  { id: "confirmPassword", label: "Confirm New Password", context: "confirm" },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => url.endsWith("notification-preferences")
    ? { leadAlerts: true, campaignUpdates: true }
    : { name: "Synthetic User", email: "synthetic@example.test", avatar: "", bio: "", phone: "" });
});
afterEach(cleanup);

async function renderSecurity() {
  render(<SettingsPage />);
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
}

function expectNoAccountEffects() {
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.put).not.toHaveBeenCalled();
  expect(mocks.logout).not.toHaveBeenCalled();
  expect(mocks.replace).not.toHaveBeenCalled();
}

describe("Settings Security password visibility", () => {
  it("gives each hidden control a unique field-specific name and input relationship", async () => {
    await renderSecurity();
    for (const field of fields) {
      const input = screen.getByLabelText(field.label, { exact: true });
      const button = screen.getByRole("button", { name: `Show ${field.context} password` });
      expect(input).toHaveAttribute("id", field.id);
      expect(input).toHaveAttribute("name", field.id);
      expect(input).toHaveAttribute("type", "password");
      expect(input).toBeRequired();
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveAttribute("aria-controls", field.id);
      expect(button).not.toHaveAttribute("aria-pressed");
      expect(button.textContent).toBe("");
      expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("repeatedly toggles only the associated blank input without submitting, validating, or resetting", async () => {
    const user = userEvent.setup();
    await renderSecurity();
    const form = screen.getByLabelText(fields[0].label).closest("form")!;
    const submit = vi.fn();
    form.addEventListener("submit", submit);
    for (const field of fields) {
      const button = screen.getByRole("button", { name: `Show ${field.context} password` });
      await user.click(button);
      expect(button).toHaveAccessibleName(`Hide ${field.context} password`);
      expect(button).toHaveFocus();
      for (const other of fields) {
        expect(screen.getByLabelText(other.label, { exact: true }))
          .toHaveAttribute("type", other.id === field.id ? "text" : "password");
        expect(screen.getByLabelText(other.label, { exact: true })).toHaveValue("");
      }
      await user.click(button);
      expect(button).toHaveAccessibleName(`Show ${field.context} password`);
      expect(screen.getByLabelText(field.label, { exact: true })).toHaveAttribute("type", "password");
    }
    expect(submit).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expectNoAccountEffects();
  });

  it("reaches every control with Tab and preserves focus through Enter and Space activation", async () => {
    const user = userEvent.setup();
    await renderSecurity();
    screen.getByLabelText(fields[0].label).focus();
    for (const [index, field] of fields.entries()) {
      await user.tab();
      const button = screen.getByRole("button", { name: `Show ${field.context} password` });
      expect(button).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(button).toHaveFocus();
      expect(button).toHaveAccessibleName(`Hide ${field.context} password`);
      expect(screen.getByLabelText(field.label, { exact: true })).toHaveAttribute("type", "text");
      await user.keyboard(" ");
      expect(button).toHaveFocus();
      expect(button).toHaveAccessibleName(`Show ${field.context} password`);
      expect(screen.getByLabelText(field.label, { exact: true })).toHaveAttribute("type", "password");
      if (index < fields.length - 1) {
        await user.tab();
        expect(screen.getByLabelText(fields[index + 1].label)).toHaveFocus();
      }
    }
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expectNoAccountEffects();
  });

  it("preserves synthetic values, input labels, required constraints, and form associations", async () => {
    const user = userEvent.setup();
    await renderSecurity();
    // Deliberately synthetic local values; never read from a real account.
    const values = ["FixtureOld!234", "FixtureNew!234", "FixtureNew!234"];
    for (const [index, field] of fields.entries()) {
      const input = screen.getByLabelText(field.label, { exact: true }) as HTMLInputElement;
      expect(input.validity.valueMissing).toBe(true);
      fireEvent.change(input, { target: { value: values[index] } });
    }
    for (const field of fields) {
      const button = screen.getByRole("button", { name: `Show ${field.context} password` });
      const input = screen.getByLabelText(field.label, { exact: true }) as HTMLInputElement;
      const form = input.form;
      const attributes = ["name", "required", "placeholder", "aria-describedby", "aria-invalid"]
        .map(name => input.getAttribute(name));
      for (let activation = 0; activation < 2; activation++) {
        await user.click(button);
        expect(screen.getByLabelText(field.label, { exact: true })).toBe(input);
        expect(input.form).toBe(form);
        expect(["name", "required", "placeholder", "aria-describedby", "aria-invalid"]
          .map(name => input.getAttribute(name))).toEqual(attributes);
        expect(input.validity.valueMissing).toBe(false);
        for (const [index, other] of fields.entries()) {
          expect(screen.getByLabelText(other.label, { exact: true })).toHaveValue(values[index]);
        }
      }
    }
    expectNoAccountEffects();
  });

  it("retains mismatch and strength validation after visibility changes using local mocked actions", async () => {
    const user = userEvent.setup();
    await renderSecurity();
    fireEvent.change(screen.getByLabelText("Current Password"), { target: { value: "FixtureOld!234" } });
    fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "FixtureNew!234" } });
    fireEvent.change(screen.getByLabelText("Confirm New Password"), { target: { value: "FixtureMismatch!234" } });
    await user.click(screen.getByRole("button", { name: "Show new password" }));
    await user.click(screen.getByRole("button", { name: "Update Password" }));
    await user.click(screen.getByRole("button", { name: "Confirm Change" }));
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: "Passwords do not match" }));
    expectNoAccountEffects();

    fireEvent.change(screen.getByLabelText("New Password"), { target: { value: "weakfixture" } });
    fireEvent.change(screen.getByLabelText("Confirm New Password"), { target: { value: "weakfixture" } });
    await user.click(screen.getByRole("button", { name: "Hide new password" }));
    await user.click(screen.getByRole("button", { name: "Update Password" }));
    await user.click(screen.getByRole("button", { name: "Confirm Change" }));
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Password is not strong enough" }));
    expectNoAccountEffects();
  });
});
