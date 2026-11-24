import { createHmac, timingSafeEqual } from "node:crypto";
import { isValidIanaTimezone } from "../../utils/timezone.js";
import type { TemplateRenderContext } from "../../../shared/templateRenderContext.js";

function signingKeys(): string[] {
  const primary =
    process.env.JWT_SECRET ||
    (process.env.NODE_ENV === "test"
      ? "test-only-secret-not-for-production"
      : "");
  if (!primary)
    throw new Error(
      "Template rendering requires the configured application signing key.",
    );
  return [
    primary,
    ...(process.env.JWT_SECRET_PREVIOUS || "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean),
  ];
}
function sign(
  key: string,
  owner: number,
  templateId: number,
  version: number,
  context: Omit<TemplateRenderContext, "signature">,
) {
  return createHmac("sha256", key)
    .update(
      JSON.stringify([
        "approved-template-clock-v1",
        owner,
        templateId,
        version,
        context.renderedAt,
        context.timeZone,
      ]),
    )
    .digest("hex");
}
export function issueTemplateRenderContext(
  owner: number,
  templateId: number,
  version: number,
  timeZone: string,
  now = new Date(),
): TemplateRenderContext {
  if (!isValidIanaTimezone(timeZone))
    throw new Error("Invalid template rendering timezone.");
  const context = {
    version: 1 as const,
    renderedAt: now.toISOString(),
    timeZone,
  };
  return {
    ...context,
    signature: sign(signingKeys()[0], owner, templateId, version, context),
  };
}
export function verifyTemplateRenderContext(
  owner: number,
  templateId: number,
  version: number,
  value: unknown,
): TemplateRenderContext {
  const context = value as TemplateRenderContext | undefined;
  if (
    !context ||
    context.version !== 1 ||
    typeof context.renderedAt !== "string" ||
    !Number.isFinite(Date.parse(context.renderedAt)) ||
    typeof context.timeZone !== "string" ||
    !isValidIanaTimezone(context.timeZone) ||
    typeof context.signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(context.signature)
  )
    throw new Error(
      "Review the template again to obtain a valid rendering context.",
    );
  if (
    !signingKeys().some((key) =>
      timingSafeEqual(
        Buffer.from(context.signature, "hex"),
        Buffer.from(sign(key, owner, templateId, version, context), "hex"),
      ),
    )
  )
    throw new Error(
      "The approved template rendering context changed. Review the template again.",
    );
  return context;
}
