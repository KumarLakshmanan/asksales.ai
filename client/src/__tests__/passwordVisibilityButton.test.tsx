import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordVisibilityButton } from "@/components/settings/PasswordVisibilityButton";
import { Input } from "@/components/ui/input";

afterEach(cleanup);

describe("PasswordVisibilityButton", () => {
  it("accepts complete localized labels in both visibility states", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const props = {
      inputId: "fixture-password", onToggle,
      showLabel: "Afficher le mot de passe actuel",
      hideLabel: "Masquer le mot de passe actuel",
    };
    const { rerender } = render(<PasswordVisibilityButton {...props} visible={false} />);
    const button = screen.getByRole("button", { name: props.showLabel });
    await user.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(<PasswordVisibilityButton {...props} visible />);
    expect(screen.getByRole("button", { name: props.hideLabel })).toBe(button);
    expect(button).toHaveAttribute("aria-controls", "fixture-password");
    expect(button).not.toHaveAttribute("aria-pressed");
  });

  it("leaves synthetic input values, help/error relationships, and validation intact", async () => {
    const user = userEvent.setup();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    function Fixture() {
      const [visible, setVisible] = useState(false);
      return (
        <form onSubmit={submit}>
          <label htmlFor="fixture-password">Fixture password</label>
          <Input id="fixture-password" name="fixturePassword" required
            type={visible ? "text" : "password"} defaultValue="Synthetic!123"
            aria-describedby="fixture-help fixture-error" aria-invalid="true" />
          <p id="fixture-help">Synthetic help text</p>
          <p id="fixture-error">Synthetic error text</p>
          <PasswordVisibilityButton inputId="fixture-password" visible={visible}
            onToggle={() => setVisible(value => !value)}
            showLabel="Show fixture password" hideLabel="Hide fixture password" />
        </form>
      );
    }
    render(<Fixture />);
    const input = screen.getByLabelText("Fixture password") as HTMLInputElement;
    const button = screen.getByRole("button", { name: "Show fixture password" });
    for (let activation = 0; activation < 2; activation++) {
      await user.click(button);
      expect(input).toHaveAttribute("type", activation === 0 ? "text" : "password");
      expect(input).toHaveValue("Synthetic!123");
      expect(input).toBeRequired();
      expect(input).toHaveAttribute("name", "fixturePassword");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAccessibleDescription("Synthetic help text Synthetic error text");
      expect(input.validity.valueMissing).toBe(false);
      expect(screen.getByLabelText("Fixture password")).toBe(input);
    }
    await user.clear(input);
    expect(input.validity.valueMissing).toBe(true);
    await user.click(button);
    expect(input.validity.valueMissing).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });
});
