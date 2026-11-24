/**
 * Invalidate legacy plaintext verification and password-reset tokens.
 *
 * This migration was introduced while email-verification credentials were
 * SHA-256 digests. The current flow stores six-digit verification OTPs as
 * bcrypt hashes; any remaining SHA-256 digest is no longer accepted and is
 * replaced when the user requests a fresh OTP. Existing plaintext values
 * cannot be transformed safely because the original bearer value may already
 * be exposed, so users must request a fresh credential instead.
 */
export async function up(client) {
  await client.query(`
    UPDATE users
    SET verification_token = NULL,
        verification_token_expiry = NULL
    WHERE verification_token IS NOT NULL
      AND verification_token !~ '^[0-9a-f]{64}$';

    UPDATE users
    SET reset_password_token = NULL,
        reset_password_token_expiry = NULL
    WHERE reset_password_token IS NOT NULL
      AND reset_password_token !~ '^\\$2[aby]\\$';

    UPDATE admins
    SET reset_password_token = NULL,
        reset_password_token_expiry = NULL
    WHERE reset_password_token IS NOT NULL
      AND reset_password_token !~ '^\\$2[aby]\\$';
  `);
}

export async function down() {
  // Irreversible by design: invalidated bearer credentials must not be restored.
}
