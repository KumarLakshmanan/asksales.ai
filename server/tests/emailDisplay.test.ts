import { describe, expect, it } from '@jest/globals';
import { emailDisplayText, legacyEmailFormat } from '../utils/emailDisplay.js';
describe('email text projection', () => {
  it('uses explicit receipt metadata before historical template recognition', () => {
    expect(legacyEmailFormat('<p>Literal text</p>', 'gmail', 'text')).toBe('text');
    expect(legacyEmailFormat('<p>HTML body</p>', 'gmail', 'html')).toBe('html');
    expect(legacyEmailFormat('<script>literal example</script>', 'gmail')).toBe('text');
    expect(legacyEmailFormat('<style>literal CSS</style>', 'gmail')).toBe('text');
    expect(legacyEmailFormat('Contact <sales@example.com>', 'gmail')).toBe('text');
    expect(legacyEmailFormat('<p>Literal SMS text</p>', 'sms')).toBe('text');
  });
  it('strips CSS, executable and hidden content while decoding escaped fillers and preserving paragraphs', () => {
    const input = '<html><head><style>body,table {width:600px}</style></head><body><div style="display:none">hidden preview</div><p>Welcome &amp; thanks</p><p>&amp;#847;&amp;#8199;&amp;#65279;Next line</p><script>danger()</script><img src="https://invalid.test/track"></body></html>';
    expect(emailDisplayText(input, 'html')).toBe('Welcome & thanks\nNext line');
  });
  it.each([
    ['Contact <sales@example.com> tomorrow', 'Contact <sales@example.com> tomorrow'],
    ['Contact &lt;sales@example.com&gt; tomorrow', 'Contact <sales@example.com> tomorrow'],
    ['Use <script> as a literal example', 'Use <script> as a literal example'],
    ['Use &amp;lt;script&amp;gt; as a literal example', 'Use <script> as a literal example'],
    ['<style>literal CSS</style>\n\n<script>literal example</script>', '<style>literal CSS</style>\n\n<script>literal example</script>'],
  ])('preserves plain-text MIME semantics: %s', (input, expected) => {
    expect(emailDisplayText(input)).toBe(expected);
  });
  it('preserves escaped examples inside actual HTML while stripping executable tags', () => {
    expect(emailDisplayText('<p>Use &lt;script&gt; as text</p><script>danger()</script><p>Contact &lt;sales@example.com&gt;</p>', 'html')).toBe('Use <script> as text\nContact <sales@example.com>');
  });
  it('keeps literal escaped markup as text and preserves emoji joiners', () => {
    expect(emailDisplayText('Example &lt;script&gt; is text\nFamily 👩‍👩‍👦')).toBe('Example <script> is text\nFamily 👩‍👩‍👦');
  });
});
