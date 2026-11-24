/** Explicit local-only browser fixture. Does not send mail or provider messages. */
import dotenv from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';
import bcrypt from 'bcryptjs';

const userId = Number(process.argv[2]);
if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Provide the authorized local workspace user ID.');
dotenv.config({ path: resolve(import.meta.dirname, '../.env.development'), override: true, quiet: true });
dotenv.config({ path: resolve(import.meta.dirname, '../.env'), override: true, quiet: true });
if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST || '')) throw new Error('Local PostgreSQL only.');
const client = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || process.env.DB_DATABASE, user: process.env.DB_USER, password: process.env.DB_PASSWORD || '',
  connectionTimeoutMillis: 5000, options: '-c timezone=UTC' });
await client.connect();
try {
  await client.query('BEGIN');
  const owner = await client.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL', [userId]);
  if (owner.rowCount !== 1) throw new Error('Authorized local workspace unavailable.');
  const runId = randomBytes(6).toString('hex');
  const password = `Qa!${randomBytes(24).toString('base64url')}`;
  const email = `support-qa-${runId}@example.invalid`;
  const hash = await bcrypt.hash(password, 12);
  const [team] = (await client.query(`INSERT INTO support_teams(user_id,name,description,is_active)
    VALUES($1,$2,'Disposable local support QA team. No external notifications.',TRUE) RETURNING id`,
  [userId, `Support QA ${runId}`])).rows;
  const preferences = Object.fromEntries(['email','whatsapp','slack','teams'].map(channel =>
    [channel, { enabled: false, recipient: '', events: { newTicketAssignment: false, humanHandoff: false } }]));
  const [member] = (await client.query(`INSERT INTO team_members(team_id,user_id,role,name,email,password_hash,is_active,notification_preferences)
    VALUES($1,$2,'member','Local QA Support Member',$3,$4,TRUE,$5::jsonb) RETURNING id`,
  [team.id, userId, email, hash, JSON.stringify(preferences)])).rows;
  const customerEmail = `support-customer-${runId}@example.invalid`;
  const [lead] = (await client.query(`INSERT INTO leads(uuid,user_id,source,name,first_name,last_name,email,status)
    VALUES($1,$2,'local_support_qa','Synthetic QA Customer','Synthetic','QA Customer',$3,'replied') RETURNING id`,
  [randomUUID(), userId, customerEmail])).rows;
  const [contact] = (await client.query(`INSERT INTO crm_contacts(user_id,lead_id,first_name,last_name,email,source,status,pipeline_status,total_replies)
    VALUES($1,$2,'Synthetic','QA Customer',$3,'local_support_qa','replied','replied',1) RETURNING id`,
  [userId, lead.id, customerEmail])).rows;
  const [conversation] = (await client.query(`INSERT INTO outreach_conversations(user_id,lead_id,crm_contact_id,channel,lead_name,lead_email,subject,automation_mode,metadata,total_messages,unread_count)
    VALUES($1,$2,$3,'email','Synthetic QA Customer',$4,$5,'human_owned',$6::jsonb,1,1) RETURNING id`,
  [userId, lead.id, contact.id, customerEmail, `Local support QA ${runId}`, JSON.stringify({ localSupportQa: runId })])).rows;
  const content = 'Synthetic local QA: verify assigned ticket visibility and an internal support note. Do not send external messages.';
  const [ticket] = (await client.query(`INSERT INTO support_tickets(user_id,contact_id,lead_id,outreach_conversation_id,team_id,assigned_member_id,ticket_number,subject,description,status,priority,total_messages,unread_count,tags,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'open','medium',1,1,'["local_support_qa"]'::jsonb,$10::jsonb) RETURNING id,ticket_number`,
  [userId, contact.id, lead.id, conversation.id, team.id, member.id, `QA-${runId}`, `Local support QA ${runId}`, content, JSON.stringify({ localSupportQa: runId })])).rows;
  const [nativeMessage] = (await client.query(`INSERT INTO outreach_messages(conversation_id,user_id,direction,content,redacted_content,status,external_message_id)
    VALUES($1,$2,'inbound',$3,$3,'received',$4) RETURNING id`,
  [conversation.id, userId, content, `qa-inbound-${runId}`])).rows;
  const [ticketMessage] = (await client.query(`INSERT INTO support_ticket_messages(ticket_id,user_id,direction,content,is_internal)
    VALUES($1,$2,'inbound',$3,FALSE) RETURNING id`, [ticket.id, userId, content])).rows;
  await client.query('UPDATE outreach_messages SET metadata=$1::jsonb WHERE id=$2 AND conversation_id=$3',
    [JSON.stringify({ supportTicketRouting: { ticketId: ticket.id, ticketMessageId: ticketMessage.id,
      conversationId: conversation.id, inboundMessageId: nativeMessage.id }, localSupportQa: runId }), nativeMessage.id, conversation.id]);
  await client.query('COMMIT');
  // The disposable credential is emitted only to the invoking QA operator,
  // never persisted in source, logs, or a public artifact by this script.
  console.log(JSON.stringify({ runId, userId, teamId: team.id, memberId: member.id, email, password,
    leadId: lead.id, contactId: contact.id, conversationId: conversation.id, ticketId: ticket.id,
    ticketNumber: ticket.ticket_number, nativeMessageId: nativeMessage.id, ticketMessageId: ticketMessage.id }));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { await client.end(); }
