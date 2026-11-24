/**
 * Migration: Create policy_pages and account_deletion_requests tables
 *
 * - policy_pages: Markdown-based public legal pages managed in admin panel
 * - account_deletion_requests: Stores user-initiated account deletion requests
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS policy_pages (
      id SERIAL PRIMARY KEY,
      slug VARCHAR(120) NOT NULL UNIQUE,
      title VARCHAR(255) NOT NULL,
      content_markdown TEXT NOT NULL,
      published BOOLEAN NOT NULL DEFAULT TRUE,
      created_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      updated_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_policy_pages_published ON policy_pages(published);

    CREATE TABLE IF NOT EXISTS account_deletion_requests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      email VARCHAR(255) NOT NULL,
      full_name VARCHAR(255),
      reason TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      admin_notes TEXT,
      source VARCHAR(50) NOT NULL DEFAULT 'public_page',
      requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at TIMESTAMP,
      processed_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_account_deletion_requests_status ON account_deletion_requests(status);
    CREATE INDEX IF NOT EXISTS idx_account_deletion_requests_requested_at ON account_deletion_requests(requested_at);
    CREATE INDEX IF NOT EXISTS idx_account_deletion_requests_email ON account_deletion_requests(email);

    INSERT INTO policy_pages (slug, title, content_markdown, published)
    VALUES
      (
        'privacy-policy',
        'Privacy Policy',
        '# Privacy Policy\n\nWe respect your privacy and process your data responsibly.\n\n- We collect only the information required to operate the service.\n- We apply strong security practices to protect your data.\n- You can contact us to request access, correction, or deletion of your data.\n\nFor privacy questions, contact: privacy@asksales.ai',
        TRUE
      ),
      (
        'terms-of-use',
        'Terms of Use',
        '# Terms of Use\n\nBy using this platform, you agree to these terms.\n\n- Use the platform in compliance with applicable laws.\n- Keep your account credentials secure.\n- Do not attempt unauthorized access or abuse of service resources.\n\nThese terms may be updated periodically.',
        TRUE
      ),
      (
        'refund-policy',
        'Refund Policy',
        '# Refund Policy\n\nRefund requests are reviewed on a case-by-case basis.\n\n- Submit refund requests through support with transaction details.\n- Approved refunds are processed to the original payment method when possible.\n- Processing timelines may vary by payment provider.',
        TRUE
      ),
      (
        'cancellation-policy',
        'Cancellation Policy',
        '# Cancellation Policy\n\nYou can cancel subscriptions according to your active plan terms.\n\n- Cancellation stops future billing from the next billing cycle unless otherwise stated.\n- Access may continue until the current billing period ends.\n- Contact support for cancellation assistance if needed.',
        TRUE
      )
    ON CONFLICT (slug) DO NOTHING;
  `);
}

export async function down(client) {
  await client.query(`
    DROP TABLE IF EXISTS account_deletion_requests;
    DROP TABLE IF EXISTS policy_pages;
  `);
}
