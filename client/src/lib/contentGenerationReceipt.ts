/** A provider result is not proof that a library asset was saved. */
export function hasSavedMediaReceipt(value: { persisted?: unknown; assetId?: unknown }): value is { persisted: true; assetId: number } {
  return value.persisted === true && Number.isSafeInteger(value.assetId) && Number(value.assetId) > 0;
}
