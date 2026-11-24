import { describe, expect, it } from '@jest/globals';
import { emailBodyToHtml, plainTextToEmailHtml, stripEmailPlaceholders } from '../../shared/emailFormatting.js';
import { sanitizeEmailHtml } from '../utils/contentTemplateRendering.js';

describe('outgoing email body formatting', () => {
  it('keeps the initial greeting and paragraphs on separate lines with inline formatting', () => {
    const body = 'Hi Uma,\n\nMany organizations face <strong>hidden inefficiencies</strong>.\n\nWould you be open to a brief conversation?\n\nBest regards,\nShiv Das';
    expect(emailBodyToHtml(body)).toBe('Hi Uma,<br><br>Many organizations face <strong>hidden inefficiencies</strong>.<br><br>Would you be open to a brief conversation?<br><br>Best regards,<br>Shiv Das');
    expect(emailBodyToHtml(`<div>${body}</div>`)).toBe(`<div>${emailBodyToHtml(body)}</div>`);
    expect(emailBodyToHtml('<b>Hi Uma,</b>\n\n<strong>Assessment</strong>')).toBe('<b>Hi Uma,</b><br><br><strong>Assessment</strong>');
    expect(emailBodyToHtml(emailBodyToHtml(body))).toBe(emailBodyToHtml(body));
  });
  it('leaves indentation between HTML blocks, preformatted text and tag attributes intact', () => {
    const html = '<p>Hi Uma,</p>\n\n<p><b>Assessment</b></p>\n<pre>line one\nline two</pre><a title="line one\nline two" href="https://example.test">Read more</a>';
    expect(emailBodyToHtml(html)).toBe(html);
  });
  it.each(['\n', '\r\n', '\r'])('preserves paragraphs and signature lines for %j line endings', newline => {
    const body = ['Hi Uma,', '', 'HR teams face delays.', '', 'Best regards,', 'Shiv Das', 'Founder, Aimplify'].join(newline);
    expect(emailBodyToHtml(body)).toBe('<div>Hi Uma,<br><br>HR teams face delays.<br><br>Best regards,<br>Shiv Das<br>Founder, Aimplify</div>');
  });

  it('escapes text and preserves repeated spaces before sanitization or provider routing', () => {
    const html = emailBodyToHtml('Contact <sales@example.com> & team\nUse  two spaces.');
    expect(html).toBe('<div>Contact &lt;sales@example.com&gt; &amp; team<br>Use &nbsp;two spaces.</div>');
    expect(sanitizeEmailHtml(html)).toBe(html);
    expect(emailBodyToHtml(html)).toBe(html);
    expect(plainTextToEmailHtml('"quoted" <customer>')).toBe('&quot;quoted&quot; &lt;customer&gt;');
  });

  it.each([
    '<p>Hello <strong>Uma</strong>,</p><p>Let’s talk.</p><div>Best,<br>Shiv</div>',
    '<!DOCTYPE html>\n<html><head><style>p { margin: 10px; }</style></head><body><table><tr><td>Hello</td></tr></table></body></html>',
    '<ul><li>One</li><li>Two</li></ul>',
    '<a href="https://example.com">Read more</a>',
  ])('leaves existing HTML structure and formatting intact: %s', html => {
    expect(emailBodyToHtml(html)).toBe(html);
  });

  it('keeps single-paragraph encoding stable through both email services', () => {
    const html = emailBodyToHtml('Hello & welcome <customer>');
    expect(emailBodyToHtml(html)).toBe(html);
    expect(emailBodyToHtml('')).toBe('');
  });

  it('removes generated placeholders without flattening paragraphs or signatures', () => {
    expect(stripEmailPlaceholders('Hi Uma,\n\nLearn more [Insert Link]\n\nBest,\n[Your Name]\nFounder'))
      .toBe('Hi Uma,\n\nLearn more \n\nBest,\n \nFounder');
    expect(stripEmailPlaceholders('Hi Uma,\n\nLet’s talk.\n\nBest,\nShiv')).toBe('Hi Uma,\n\nLet’s talk.\n\nBest,\nShiv');
  });
});
