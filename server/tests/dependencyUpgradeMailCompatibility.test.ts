import { describe, expect, it } from '@jest/globals';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

describe('upgraded mail dependency interoperability', () => {
  it('round-trips MIME text, HTML, recipient identity and attachments without sending mail', async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const encoded = await transport.sendMail({
      from: 'Synthetic Sender <sender@example.test>',
      to: 'Synthetic Recipient <recipient@example.test>',
      subject: 'Synthetic dependency compatibility',
      text: 'Plain message', html: '<p>HTML message</p>',
      attachments: [{ filename: 'receipt.txt', content: 'Synthetic attachment' }],
    });
    const parsed = await simpleParser(encoded.message);

    expect(parsed.from?.value[0].address).toBe('sender@example.test');
    expect(Array.isArray(parsed.to) ? parsed.to[0].value[0].address : parsed.to?.value[0].address)
      .toBe('recipient@example.test');
    expect(parsed.subject).toBe('Synthetic dependency compatibility');
    expect(parsed.text?.trim()).toBe('Plain message');
    expect(parsed.html).toContain('<p>HTML message</p>');
    expect(parsed.attachments[0].content.toString()).toBe('Synthetic attachment');
    transport.close();
  });
});
