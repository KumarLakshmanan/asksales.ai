/** bcrypt consumes at most 72 UTF-8 bytes. Apply this to new credentials;
 * existing password verification retains its historical behavior. */
export const BCRYPT_PASSWORD_MAX_BYTES = 72;

export function passwordFitsBcrypt(password: string): boolean {
  return new TextEncoder().encode(password).byteLength <= BCRYPT_PASSWORD_MAX_BYTES;
}
