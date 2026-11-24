const priority: Record<string, number> = {
  sent: 1,
  failed: 2,
  delivered: 3,
  read: 4,
};

/** Delivery evidence takes precedence over an HTTP acceptance acknowledgement. */
export function applyWhatsAppReceipts(
  message: { status: string; deliveredAt?: Date | null; readAt?: Date | null },
  rows: Record<string, unknown>[],
) {
  const receipt = rows
    .filter((row) => typeof row.event_type === "string")
    .map((row) => ({
      timestamp: row.timestamp,
      raw_data: row.raw_data,
      status: String(row.event_type).replace("whatsapp_", ""),
    }))
    .sort((a, b) => (priority[b.status] || 0) - (priority[a.status] || 0))[0];
  if (
    !receipt ||
    !priority[receipt.status] ||
    priority[receipt.status] < (priority[message.status] || 0)
  )
    return null;
  const timestamp = new Date(String(receipt.timestamp));
  if (!Number.isFinite(timestamp.getTime())) return null;
  const raw = receipt.raw_data as
    | { status?: { errors?: Array<{ message?: string }> } }
    | undefined;
  return {
    status: receipt.status,
    ...(receipt.status === "failed"
      ? {
          failedAt: timestamp,
          errorMessage: String(
            raw?.status?.errors?.[0]?.message || "WhatsApp delivery failed",
          ).slice(0, 1000),
        }
      : {}),
    ...(["delivered", "read"].includes(receipt.status)
      ? { deliveredAt: message.deliveredAt || timestamp, errorMessage: null }
      : {}),
    ...(receipt.status === "read"
      ? { readAt: message.readAt || timestamp }
      : {}),
  };
}
