import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SocialPostContentRenderer from "@/components/modals/content-fullscreen/SocialPostContentRenderer";
import { hashtagsMissingFromCaption } from "../../../shared/socialCaption";

describe("Fullscreen social post hashtags", () => {
  it("does not repeat hashtags the caption already ends with", () => {
    const caption = "Book a demo.\n\n#AimplifyAI #CustomerSupport";
    render(
      <SocialPostContentRenderer
        title="LinkedIn post"
        content=""
        platform="linkedin"
        parsedContent={{ caption, hashtags: ["AimplifyAI", "#customersupport", "SaaS"] }}
      />,
    );

    // The caption keeps its own tags; only the tag it lacks is added below it.
    expect(screen.getByText(/Book a demo\./).textContent).toContain("#AimplifyAI #CustomerSupport");
    expect(screen.getAllByText(/^#/).map((el) => el.textContent)).toEqual(["#SaaS"]);
  });

  it("still shows the hashtag list when the caption has none", () => {
    render(
      <SocialPostContentRenderer
        title="LinkedIn post"
        content=""
        parsedContent={{ caption: "Plain caption", hashtags: ["One", "##Two"] }}
      />,
    );

    expect(screen.getAllByText(/^#/).map((el) => el.textContent)).toEqual(["#One", "#Two"]);
  });

  it("drops empty and repeated tags", () => {
    expect(hashtagsMissingFromCaption("", ["A", "#a", "", "#", "B"])).toEqual(["#A", "#B"]);
  });
});
