/**
 * Add authoritative locale, currency, and three-state theme preferences.
 * Legacy columns remain for compatibility with older deployments and clients.
 */
export async function up(client) {
  await client.query(`
    ALTER TABLE user_preferences
      ADD COLUMN IF NOT EXISTS locale VARCHAR(35) NOT NULL DEFAULT 'en-US',
      ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'USD',
      ADD COLUMN IF NOT EXISTS theme VARCHAR(10) NOT NULL DEFAULT 'system';

    UPDATE user_preferences
    SET locale = CASE language
      WHEN 'es' THEN 'es-ES'
      WHEN 'fr' THEN 'fr-FR'
      WHEN 'de' THEN 'de-DE'
      WHEN 'hi' THEN 'hi-IN'
      WHEN 'ta' THEN 'ta-IN'
      ELSE 'en-US'
    END;

    UPDATE user_preferences
    SET currency = UPPER(currency)
    WHERE currency <> UPPER(currency);

    UPDATE user_preferences
    SET theme = CASE WHEN dark_mode = true THEN 'dark' ELSE 'system' END;

    ALTER TABLE user_preferences
      DROP CONSTRAINT IF EXISTS user_preferences_currency_format,
      DROP CONSTRAINT IF EXISTS user_preferences_theme_valid;

    ALTER TABLE user_preferences
      ADD CONSTRAINT user_preferences_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
      ADD CONSTRAINT user_preferences_theme_valid CHECK (theme IN ('light', 'dark', 'system'));
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE user_preferences
      DROP CONSTRAINT IF EXISTS user_preferences_currency_format,
      DROP CONSTRAINT IF EXISTS user_preferences_theme_valid,
      DROP COLUMN IF EXISTS locale,
      DROP COLUMN IF EXISTS currency,
      DROP COLUMN IF EXISTS theme;
  `);
}
