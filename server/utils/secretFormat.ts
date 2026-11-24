/** True when the value looks like SecretsManager ciphertext (hex:hex:payload); false for legacy base64 rows. */
export const isEncryptedFormat = (val: string | null | undefined): boolean => {
  if (!val) return false;
  const parts = val.split(':');
  return parts.length === 3 && /^[0-9a-f]+$/i.test(parts[0]) && /^[0-9a-f]+$/i.test(parts[1]);
};
