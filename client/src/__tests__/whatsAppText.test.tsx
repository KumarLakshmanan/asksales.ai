import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { WhatsAppText, whatsAppDisplayBody, whatsAppPlainText, whatsAppPreviewText } from '@/components/outreach/WhatsAppText';

describe('WhatsApp message text', () => {
  it('links http(s) URLs safely and leaves trailing punctuation outside the link', () => {
    const { container } = render(<p><WhatsAppText text={'See https://www.instagram.com/reel/Df0_aEQxIFa/?vrfl=bj, thanks'} /></p>);
    const link = container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://www.instagram.com/reel/Df0_aEQxIFa/?vrfl=bj');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(container.textContent).toBe('See https://www.instagram.com/reel/Df0_aEQxIFa/?vrfl=bj, thanks');
  });

  it('never links other schemes or renders markup from the text', () => {
    const { container } = render(<p><WhatsAppText text={'javascript:alert(1) <b>x</b>'} /></p>);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toBe('javascript:alert(1) <b>x</b>');
  });

  it('formats bold, italic, strikethrough and monospace like WhatsApp', () => {
    const { container } = render(<p><WhatsAppText text={'*WEEKDAY OFFER* get the *2nd night at 50% off* _soon_ ~old~ ```code```'} /></p>);
    expect([...container.querySelectorAll('strong')].map(node => node.textContent)).toEqual(['WEEKDAY OFFER', '2nd night at 50% off']);
    expect(container.querySelector('em')?.textContent).toBe('soon');
    expect(container.querySelector('s')?.textContent).toBe('old');
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect(container.textContent).not.toContain('*');
  });

  it('leaves lone markers and snake_case words alone', () => {
    const { container } = render(<p><WhatsAppText text={'5 * 3 = 15 and file_name_here'} /></p>);
    expect(container.querySelector('strong, em')).toBeNull();
    expect(container.textContent).toBe('5 * 3 = 15 and file_name_here');
  });

  it('builds plain previews and explains media that was not saved', () => {
    expect(whatsAppPlainText('*WEEKDAY OFFER at ORO*')).toBe('WEEKDAY OFFER at ORO');
    expect(whatsAppPreviewText('[video message]')).toBe('Video');
    expect(whatsAppDisplayBody('[video message]', true)).toBeNull();
    expect(whatsAppDisplayBody('[video message]', false)).toBe("This video wasn't saved, so it can't be shown here.");
    expect(whatsAppDisplayBody('Hello', false)).toBe('Hello');
  });
});
