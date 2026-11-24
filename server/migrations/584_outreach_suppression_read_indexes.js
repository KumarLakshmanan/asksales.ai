// Include retired leads: a previous opt-out still protects the destination.
// Index only the small suppressed subset before address normalization and RLS.
export async function up(client) {
  await client.query(`
    CREATE INDEX lead_outreach_phone_suppression_idx ON leads(user_id,business_profile_id)
      WHERE COALESCE(blacklisted,false) OR COALESCE(do_not_contact,false);
    CREATE INDEX lead_outreach_email_suppression_idx ON leads(user_id,business_profile_id)
      WHERE COALESCE(blacklisted,false) OR COALESCE(do_not_contact,false) OR COALESCE(email_unsubscribed,false);
  `);
}

export async function down(client) {
  await client.query('DROP INDEX lead_outreach_phone_suppression_idx, lead_outreach_email_suppression_idx');
}
