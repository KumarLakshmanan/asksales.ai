import { describe, expect, it } from "@jest/globals";
import { extractBrandStyles } from "../services/BrandStyleExtractor.js";

describe("website logo extraction", () => {
  it("uses the brand logo instead of a social preview image", () => {
    const result = extractBrandStyles([
      {
        url: "https://example.com",
        isHomepage: true,
        html: '<meta property="og:image" content="/trading-chart.png"><header><img src="/logo.png"></header>',
      },
    ]);
    expect(result.logoUrl).toBe("https://example.com/logo.png");
  });
  it("does not label an arbitrary header or social image as a logo", () => {
    const result = extractBrandStyles([
      {
        url: "https://example.com",
        isHomepage: true,
        html: '<meta property="og:image" content="/chart.png"><header><img src="/hero.png"></header>',
      },
    ]);
    expect(result.logoUrl).toBeNull();
  });
});
