import { installReadyCustomerDeliveryMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock();
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { emailDisplayText } from '../utils/emailDisplay.js';
import { simpleParser } from 'mailparser';

const statements: Array<{ sql: string; params: unknown[] }> = [];
const dialect = new PgDialect();
const createMessage = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const providerSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const providerGet = jest.fn<(...args: unknown[]) => Promise<unknown>>();
let cooldownUntil: string | null = null;
const updateLastUsed = jest.fn<(...args: unknown[]) => Promise<void>>();
const generate = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../services/EmailOpenTrackingService.js', () => ({ prepareEmailOpenTracking: async (_userId: number, html: string) => ({ html }), confirmEmailOpenTracking: async () => {} }));
jest.unstable_mockModule('googleapis', () => ({ google: { gmail: () => ({ users: { messages: {
  send: providerSend,
  get: providerGet,
} } }) } }));
jest.unstable_mockModule('../controllers/gmailOAuthController.js', () => ({
  getGmailClientForUser: async () => ({ client: {}, credential: { id: 31, accountIdentifier: 'qa@example.test', accountName: 'QA' } }),
}));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: async (statement: SQL) => {
  const query = dialect.sqlToQuery(statement);
  statements.push(query);
  if (query.sql.includes('SELECT gmail_cooldown_until')) return { rows: [{ gmail_cooldown_until: cooldownUntil }] };
  if (query.sql.includes('gmail_cooldown_until=GREATEST')) cooldownUntil = String(query.params[0]);
  return { rows: [{ id: 1, email: 'recipient@example.test', name: 'Synthetic recipient', company: 'QA' }] };
} } }));
jest.unstable_mockModule('../models/channelCredentials/functions.js', () => ({ ChannelCredentialModel: {
  updateLastUsed,
} }));
jest.unstable_mockModule('../models/outreachConversations/functions.js', () => ({
  getMessageByExternalId: async () => undefined,
  getConversationByProviderThread: async () => ({ id: 55 }),
  createOutreachConversation: async () => ({ id: 55 }),
  createOutreachMessage: createMessage,
}));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {
  createProviderForUser: async () => ({ createChatCompletion: generate, defaultModel: 'fixture' }),
} }));
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: {} }));
jest.unstable_mockModule('../services/CRMService.js', () => ({ crmService: { autoCreateContactOnOutreachSend: async () => {} } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const { gmailApiService } = await import('../services/gmailApiService.js');

beforeEach(() => {
  statements.length = 0;
  jest.clearAllMocks();
  cooldownUntil = null;
  providerSend.mockResolvedValue({ data: { id: 'fixture-provider-id', threadId: 'fixture-thread' } });
  providerGet.mockReset().mockResolvedValue({ data: { payload: { headers: [{ name: 'Message-ID', value: '<fixture@example.test>' }] } } });
  updateLastUsed.mockResolvedValue(undefined);
  createMessage.mockResolvedValue({ id: 77 });
});

describe('Gmail acceptance evidence at the provider boundary', () => {
  const send = () => gmailApiService.sendEmail(1, {
    to: 'recipient@example.test', subject: 'Synthetic acceptance', body: 'Fixture only',
    leadId: 1, skipCreditDeduction: true,
  });

  it('preserves native and RFC identifiers and never claims recipient delivery', async () => {
    expect(await send()).toMatchObject({ success: true, providerMessageId: 'fixture-provider-id',
      rfcMessageId: '<fixture@example.test>', deliveryAttempted: true, outcomeUncertain: false });
    expect(providerSend).toHaveBeenCalledWith(expect.anything(), { timeout: 30_000, retry: false });
    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent' }));
  });

  it.each([undefined, null, '', '   ', 123, {}, '<local@example.test>', 'bad id'])('rejects unusable native receipt %j before sent logging', async id => {
    providerSend.mockResolvedValue({ data: { id, threadId: 'fixture-thread' } });
    expect(await send()).toMatchObject({ success: false, deliveryAttempted: true, outcomeUncertain: true, retryable: false });
    expect(providerGet).not.toHaveBeenCalled();
    expect(updateLastUsed).not.toHaveBeenCalled();
    expect(statements.filter(statement => !statement.sql.includes('gmail_cooldown_until'))).toHaveLength(0);
    expect(createMessage).not.toHaveBeenCalled();
    expect(providerSend).toHaveBeenCalledTimes(1);
  });

  it('preserves acceptance when the RFC header lookup fails', async () => {
    providerGet.mockRejectedValueOnce(new Error('Synthetic metadata timeout'));
    expect(await send()).toMatchObject({ success: true, messageId: 'fixture-provider-id',
      providerMessageId: 'fixture-provider-id', outcomeUncertain: false });
    expect(providerSend).toHaveBeenCalledTimes(1);
  });

  it('preserves valid send-only acceptance when optional metadata read is scope-denied', async () => {
    providerGet.mockRejectedValueOnce(Object.assign(new Error('Synthetic metadata scope denied'), {
      response: { status: 403, data: { error: { status: 'PERMISSION_DENIED' } } },
    }));
    expect(await send()).toMatchObject({ success: true, providerMessageId: 'fixture-provider-id',
      messageId: 'fixture-provider-id', outcomeUncertain: false });
    expect(providerSend).toHaveBeenCalledTimes(1);
    expect(providerGet).toHaveBeenCalledTimes(1);
  });

  it('preserves acceptance when credential bookkeeping fails after send', async () => {
    updateLastUsed.mockRejectedValueOnce(new Error('Synthetic timestamp write failure'));
    expect(await send()).toMatchObject({ success: true, providerMessageId: 'fixture-provider-id', outcomeUncertain: false });
    expect(providerSend).toHaveBeenCalledTimes(1);
  });

  it.each([400, 429])('classifies a structured %s rejection without sent logging', async status => {
    providerSend.mockRejectedValueOnce(Object.assign(new Error('Synthetic provider rejection'), {
      response: { status, data: { error: { message: 'Fixture rejection' } } },
    }));
    expect(await send()).toMatchObject({ success: false, deliveryAttempted: true,
      outcomeUncertain: false, retryable: status === 429 });
    expect(statements.filter(statement => !statement.sql.includes('gmail_cooldown_until'))).toHaveLength(0);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it.each([undefined, 503])('holds ambiguous timeout/server response %s without retry', async status => {
    providerSend.mockRejectedValueOnce(Object.assign(new Error('Synthetic interrupted request'), {
      ...(status ? { response: { status, data: { error: {} } } } : {}),
    }));
    expect(await send()).toMatchObject({ success: false, deliveryAttempted: true, outcomeUncertain: true, retryable: false });
    expect(providerSend).toHaveBeenCalledTimes(1);
    expect(statements.filter(statement => !statement.sql.includes('gmail_cooldown_until'))).toHaveLength(0);
  });
});

describe('Gmail MIME format through actual outbound logging', () => {
  it.each([
    'QA email outreach bulk test — 29 Oct 2026',
    `A long subject ${'தமிழ் 🌴 and more '.repeat(12)}`,
  ])('encodes a Unicode subject so an email client can recover it: %s', async subject => {
    const result = await gmailApiService.sendEmail(1, { to: 'recipient@example.test', subject, body: 'Hello', skipCreditDeduction: true });
    expect(result.success).toBe(true);
    const request = providerSend.mock.calls[0][0] as { requestBody: { raw: string } };
    const raw = Buffer.from(request.requestBody.raw, 'base64url');
    const header = raw.toString('utf8').split('\r\n\r\n')[0];
    expect(header).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect([...header].every(char => char.charCodeAt(0) < 128)).toBe(true);
    for (const word of header.match(/=\?UTF-8\?B\?[^?]+\?=/g) || []) expect(word.length).toBeLessThanOrEqual(75);
    expect((await simpleParser(raw)).subject).toBe(subject);
  });

  it('keeps ASCII subjects readable and prevents injected header lines', async () => {
    const result = await gmailApiService.sendEmail(1, { to: 'recipient@example.test', subject: 'QA test\r\nBcc: other@example.test', body: 'Hello', skipCreditDeduction: true });
    expect(result.success).toBe(true);
    const request = providerSend.mock.calls[0][0] as { requestBody: { raw: string } };
    const raw = Buffer.from(request.requestBody.raw, 'base64url');
    const parsed = await simpleParser(raw);
    expect(parsed.subject).toBe('QA test  Bcc: other@example.test');
    expect(parsed.bcc).toBeUndefined();
  });

  it('keeps the initial greeting separate from a message containing bold HTML', async () => {
    const result = await gmailApiService.sendEmail(1, { to: 'recipient@example.test', subject: 'AI opportunities', body: 'Hi Uma,\n\nMany organizations face <strong>hidden inefficiencies</strong>.\n\nBest regards,\nShiv Das', isHtml: true, skipCreditDeduction: true });
    expect(result.success).toBe(true);
    const request = providerSend.mock.calls[0][0] as { requestBody: { raw: string } };
    const parsed = await simpleParser(Buffer.from(request.requestBody.raw, 'base64url'));
    expect(parsed.html).toContain('Hi Uma,<br><br>Many organizations');
    expect(parsed.html).toContain('<strong>hidden inefficiencies</strong>');
    expect(parsed.html).toContain('Best regards,<br>Shiv Das');
  });
  it('delivers rich follow-up HTML as HTML MIME instead of escaped tags', async () => {
    const { renderFollowUpTemplate } = await import('../services/followUpTemplateService.js');
    const rendered = renderFollowUpTemplate({ content: '<p>Hi {{first Name}},</p><p><b>Finance AI</b> and <em>next steps</em>.</p>', subject: 'Assessment for {{First Name}}', htmlContent: null }, { first_name: 'Uma' });
    const result = await gmailApiService.sendEmail(1, { to: 'recipient@example.test', subject: rendered.subject, body: rendered.html, isHtml: true, skipCreditDeduction: true });
    expect(result.success).toBe(true);
    const request = providerSend.mock.calls[0][0] as { requestBody: { raw: string } };
    const parsed = await simpleParser(Buffer.from(request.requestBody.raw, 'base64url'));
    expect(parsed.subject).toBe('Assessment for Uma');
    expect(parsed.html).toContain('<b>Finance AI</b>');
    expect(parsed.html).toContain('<em>next steps</em>');
    expect(parsed.html).not.toContain('&lt;b&gt;');
    expect(parsed.html).not.toContain('{{');
  });
  it.each(['{{First Name}}', '{{first_name', '{{unknown label}}'])('stops unresolved %s before Gmail is called', async token => {
    const result = await gmailApiService.sendEmail(1, { to: 'recipient@example.test', subject: 'Assessment', body: `<b>Hi ${token}</b>`, isHtml: true });
    expect(result).toMatchObject({ success: false, deliveryAttempted: false, outcomeUncertain: false });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it.each([
    { subject: 'Assessment for {{first Name}}', body: 'Resolved body', isHtml: false },
    { subject: 'Assessment', body: 'Hi {{first Name}},', isHtml: false },
    { subject: 'Assessment', body: '<p>Hi {{first Name}},</p>', isHtml: true },
    { subject: 'Assessment', body: '<p>Hi <span>{{first </span><b>Name}}</b>,</p>', isHtml: true },
    { subject: 'Assessment', body: '<p>Hi &#123;&#123;first_name&#125;&#125;,</p>', isHtml: true },
  ])('blocks reported follow-up placeholders without logging a sent row: %j', async fields => {
    const result = await gmailApiService.sendEmail(1, { to: 'recipient@example.test', leadId: 8, isFollowUp: true, followUpStep: 2, ...fields });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Missing email personalization values:'), deliveryAttempted: false, outcomeUncertain: false, retryable: false });
    expect(providerSend).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(statements).toHaveLength(0);
  });
  it('returns a known preflight cooldown without calling the sending provider', async () => {
    cooldownUntil = new Date(Date.now() + 900_000).toISOString();
    const result = await gmailApiService.sendEmail(1, { to: 'recipient@example.test', subject: 'Synthetic', body: 'Hello' });
    expect(result).toMatchObject({ success: false, retryable: true, retryAt: cooldownUntil, outcomeUncertain: false, deliveryAttempted: false });
    expect(providerSend).not.toHaveBeenCalled();
  });
  it('preserves a confirmed send if its metadata lookup is rate-limited', async () => {
    const retryAt = new Date(Date.now() + 900_000).toISOString();
    providerGet.mockRejectedValueOnce({ response: { status: 429, data: { error: { message: `User-rate limit exceeded. Retry after ${retryAt}` } } } });
    expect(await gmailApiService.sendEmail(1, { to: 'recipient@example.test', subject: 'Synthetic', body: 'Hello' }))
      .toMatchObject({ success: true, providerMessageId: 'fixture-provider-id', outcomeUncertain: false });
    expect(cooldownUntil).toBe(retryAt); expect(providerSend).toHaveBeenCalledTimes(1);
  });
  it('preserves paragraph breaks when generating an email before delivery', async () => {
    const body = 'Hi Uma,\n\nHR teams face delays.\n\nBest regards,\nShiv Das';
    generate.mockResolvedValue({ content: JSON.stringify({ subject: 'Formatting test', body }) });
    expect(await gmailApiService.generatePersonalizedEmail({ email: 'recipient@example.test', firstName: 'Uma' }))
      .toEqual({ subject: 'Formatting test', body });
  });
  it('resolves generated subject, body and follow-up sequence values for the selected recipient', async () => {
    const lead = { email: 'recipient@example.test', firstName: 'Uma', company: 'Acme', role: 'CFO' };
    generate.mockResolvedValueOnce({ content: JSON.stringify({ subject: 'For {{company}}', body: 'Hi {{first_name}},\n\nFor your {{jobtitle}}.' }) });
    expect(await gmailApiService.generatePersonalizedEmail(lead)).toEqual({ subject: 'For Acme', body: 'Hi Uma,\n\nFor your CFO.' });
    generate.mockResolvedValueOnce({ content: JSON.stringify([{ stepNumber: 1, delayDays: 1, subject: '{{Company Name}} update', body: 'Hi {{First Name}}, still interested?', triggerCondition: 'no_reply' }]) });
    expect(await gmailApiService.generateFollowUpSequence(lead, { numberOfFollowUps: 1 })).toEqual([expect.objectContaining({ subject: 'Acme update', body: 'Hi Uma, still interested?' })]);
  });

  it.each([false, true])('preserves typed or pasted paragraphs in an HTML send (attachment=%s)', async attached => {
    const body = 'Hi Uma,\r\n\r\nHR teams face delays.\r\n\r\nBest regards,\r\nShiv Das\r\nFounder, Aimplify';
    const result = await gmailApiService.sendEmail(1, {
      to: 'recipient@example.test', subject: 'Formatting regression', body, isHtml: true,
      skipCreditDeduction: true,
      attachments: attached ? [{ filename: 'note.txt', contentType: 'text/plain', content: Buffer.from('Note') }] : [],
    });
    expect(result.success).toBe(true);
    const request = providerSend.mock.calls[0][0] as { requestBody: { raw: string } };
    const parsed = await simpleParser(Buffer.from(request.requestBody.raw, 'base64url'));
    expect(parsed.html).toBe('<div>Hi Uma,<br><br>HR teams face delays.<br><br>Best regards,<br>Shiv Das<br>Founder, Aimplify</div>');
  });

  it('returns a safe, timed rejection without logging a sent message on Gmail throttling', async () => {
    const retryAt = new Date(Date.now() + 7200_000).toISOString();
    const message = `User-rate limit exceeded. Retry after ${retryAt}`;
    providerSend.mockRejectedValueOnce({ message, response: { status: 429, data: { error: { message } } } });
    const result = await gmailApiService.sendEmail(1, { to: 'recipient@example.test', subject: 'Synthetic', body: 'Hello', leadId: 1 });
    expect(result).toMatchObject({ success: false, retryable: true, retryAt, outcomeUncertain: false, deliveryAttempted: true });
    expect(providerSend).toHaveBeenCalledTimes(1);
    expect(createMessage).not.toHaveBeenCalled();
    expect(statements.some(statement => statement.sql.includes('INSERT INTO sent_messages'))).toBe(false);
    expect(statements.some(statement => statement.sql.includes('gmail_cooldown_until=GREATEST'))).toBe(true);
  });
  it.each([false, undefined])('preserves plain addresses and literal tags with isHtml=%s', async isHtml => {
    const body = 'A customer: Contact <sales@example.com>\n\nUse <script> and <p>literal examples</p>';
    const result = await gmailApiService.sendEmail(1, { to: 'recipient@example.test', subject: 'Synthetic', body, isHtml, leadId: 1, skipCreditDeduction: true });
    expect(result.success).toBe(true);
    const insert = statements.find(statement => statement.sql.includes('INSERT INTO sent_messages'))!;
    expect(insert.sql).toContain('message_format');
    expect(insert.params).toContain(body);
    expect(insert.params).toContain('text');
    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({ content: body, htmlContent: null }));
    expect(emailDisplayText(emailDisplayText(body))).toBe(body);
  });

  it('logs HTML semantics and stores readable inert conversation text', async () => {
    const body = '<style>body {color:red}</style><p>Contact &lt;sales@example.com&gt;</p><p>Literal &amp;lt;script&amp;gt;</p><script>danger()</script>';
    const result = await gmailApiService.sendEmail(1, { to: 'recipient@example.test', subject: 'Synthetic', body, isHtml: true, leadId: 1, skipCreditDeduction: true });
    expect(result.success).toBe(true);
    expect(statements.find(statement => statement.sql.includes('INSERT INTO sent_messages'))?.params).toContain('html');
    const expected = 'Contact <sales@example.com>\nLiteral <script>';
    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expected, htmlContent: body }));
    expect(emailDisplayText(expected)).toBe(expected);
  });
});
