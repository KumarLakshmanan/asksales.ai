import { describe, expect, it } from '@jest/globals';
import { absoluteEmailLogo, EMAIL_DESIGNS, isEmailDesignId, renderEmailDesign } from '../../shared/emailDesigns.js';
const brand = { companyName: 'ORO & Circle', primaryColor: '#2563eb', logoUrl: '/uploads/9/brand_asset/oro.png' };
describe('email layout transport compatibility', () => {
  it('offers exactly ten stable, unique choices', () => {
    expect(EMAIL_DESIGNS).toHaveLength(10);
    expect(new Set(EMAIL_DESIGNS.map(item => item.id)).size).toBe(10);
    expect(isEmailDesignId('classic')).toBe(true);
    expect(isEmailDesignId('__proto__')).toBe(false);
  });
  it.each(EMAIL_DESIGNS.map(item => item.id))('%s preserves the exact approved message and booking URL', designId => {
    const body = '<p>Thank you.</p><a href="https://bookings.orocircle.com/?adults=2&amp;rooms=1">Book your stay</a>';
    const html = renderEmailDesign({ brand, body, designId });
    expect(html).toContain(body);
    expect(html).toContain(`data-email-design="${designId}"`);
    expect(html).toContain('src="https://asksales.ai/uploads/9/brand_asset/oro.png"');
    expect(html).toContain('alt="ORO &amp; Circle"');
    expect(html).toContain('role="presentation"');
    expect(html).not.toContain('display:grid');
    expect(html).not.toContain('/email-events/');
  });
  it('escapes presentation labels and rejects unsafe image sources and colors', () => {
    const html = renderEmailDesign({ brand: { companyName: '<img src=x onerror=alert(1)>', logoUrl: 'javascript:alert(1)', primaryColor: 'red;display:none' }, body: '<p>Safe message</p>', preheader: '<script>bad</script>', footerText: '<b>footer</b>' });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('red;display:none');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;b&gt;footer&lt;/b&gt;');
  });
  it('normalizes site-relative logos using the configured public origin', () => {
    expect(absoluteEmailLogo('/uploads/oro logo.png', 'https://asksales.ai')).toBe('https://asksales.ai/uploads/oro%20logo.png');
    expect(absoluteEmailLogo('https://cdn.example.com/logo.png', 'https://asksales.ai')).toBe('https://cdn.example.com/logo.png');
    for (const value of ['//elsewhere.example/logo.png', 'data:image/png;base64,abc', 'http://example.com/logo.png', 'https://secret@example.com/logo.png']) expect(absoluteEmailLogo(value, 'https://asksales.ai')).toBeNull();
  });
  it('renders full-document content and its body fragment identically in previews and delivery', () => {
    const body = '<p>Visit <a href="https://bookings.orocircle.com/">our booking page</a>.</p>';
    const document = `<!doctype html><html><head><style>body{color:red}</style></head><body>${body}</body></html>`;
    expect(renderEmailDesign({ brand, body: document, designId: 'hospitality' })).toBe(renderEmailDesign({ brand, body, designId: 'hospitality' }));
  });
});
