import { describe, expect, it } from 'vitest';
import { populateEmailMessageWindow } from '../lib/email-message-window';

describe('email print and pop-out windows', () => {
  it.each(['print', 'pop-out'])('renders hostile %s fields as inert text and isolates the opener', () => {
    const document = window.document.implementation.createHTMLDocument('preview');
    const target = { document, opener: window } as unknown as Window;
    const payload = '<img src=x onerror="alert(1)"><svg onload="alert(2)"></svg><script>alert(3)</script>';
    populateEmailMessageWindow(target, { subject: `</title>${payload}`, sender: payload, email: payload, receivedAt: payload, content: payload });
    expect(target.opener).toBeNull();
    expect(document.querySelector('script,img,svg,iframe,object,a')).toBeNull();
    expect(document.querySelector('main')?.textContent).toBe(payload);
    expect(document.title).toBe(`</title>${payload}`);
    expect(document.querySelector('meta')?.getAttribute('content')).toContain("script-src 'none'");
  });
});
