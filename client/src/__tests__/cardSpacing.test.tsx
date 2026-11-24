import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CardContent, CardFooter, CardHeader } from "@/components/ui/card";

describe("card spacing", () => {
  it("keeps the default header and content spacing", () => {
    const { getByTestId } = render(
      <>
        <CardHeader data-testid="header" />
        <CardContent data-testid="content" />
      </>,
    );

    expect(getByTestId("header")).toHaveClass("pt-5", "pr-5", "pb-5", "pl-5");
    expect(getByTestId("content")).toHaveClass("pr-5", "pb-5", "pl-5");
    expect(getByTestId("content")).not.toHaveClass("pt-0");
  });

  it("lets a full padding override control every side at every viewport", () => {
    const { getByTestId } = render(<CardContent data-testid="content" className="p-4" />);
    const content = getByTestId("content");

    expect(content).toHaveClass("p-4");
    expect(content.className).not.toMatch(/(?:^|\s)(?:sm:)?p[trbl]-[56](?:\s|$)/);
  });

  it("preserves unaffected default sides for directional overrides", () => {
    const { getByTestId } = render(<CardContent data-testid="content" className="pt-4" />);
    const content = getByTestId("content");

    expect(content).toHaveClass("pt-4", "pr-5", "pb-5", "pl-5", "sm:pr-6", "sm:pb-6", "sm:pl-6");
  });

  it("applies the same override behavior to headers and footers", () => {
    const { getByTestId } = render(
      <>
        <CardHeader data-testid="header" className="p-3" />
        <CardFooter data-testid="footer" className="p-3" />
      </>,
    );

    expect(getByTestId("header")).toHaveClass("p-3");
    expect(getByTestId("footer")).toHaveClass("p-3");
    expect(getByTestId("header").className).not.toMatch(/(?:^|\s)(?:sm:)?p[trbl]-[56](?:\s|$)/);
    expect(getByTestId("footer").className).not.toMatch(/(?:^|\s)(?:sm:)?p[trbl]-[56](?:\s|$)/);
  });
});
