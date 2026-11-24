import { createHash } from "node:crypto";
export function setupRequestHash(data: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter(
                ([key, item]) =>
                  item !== undefined &&
                  !["idempotencyKey", "approvedAt", "updatedAt"].includes(key),
              )
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return createHash("sha256")
    .update(JSON.stringify(canonical(data)))
    .digest("hex");
}
export function setupRequestKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 100)
    throw new Error("Invalid setup request key.");
  return value;
}
