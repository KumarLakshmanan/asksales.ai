import {
  canonicalizeTemplateVariable,
  findUnknownTemplateVariables,
  renderContentTemplate,
  sanitizeEmailHtml,
} from '../utils/contentTemplateRendering.js';

describe('content template rendering', () => {
  it('normalizes legacy aliases into the canonical taxonomy', () => {
    expect(canonicalizeTemplateVariable('company')).toBe('company_name');
    expect(canonicalizeTemplateVariable('jobtitle')).toBe('job_title');
    expect(canonicalizeTemplateVariable('first-name')).toBe('first_name');
  });

  it('renders aliases and blocks on unresolved tokens', () => {
    const result = renderContentTemplate(
      'Hello {{firstname}} at {{company_name}} — {{missing_value}}',
      { first_name: 'Asha', company: 'Acme' },
      { now: new Date('2026-07-30T00:00:00Z') },
    );
    expect(result.rendered).toContain('Hello Asha at Acme');
    expect(result.unresolved).toEqual(['{{missing_value}}']);
    expect(result.unknown).toEqual(['{{missing_value}}']);
    expect(findUnknownTemplateVariables(result.rendered)).toEqual(['{{missing_value}}']);
  });
  it.each(['{{First Name}}', '{{first Name}}', '{{ first name }}', '{{firstName}}', '{{First\u00a0Name}}'])('resolves saved display-label alias %s', token => {
    expect(renderContentTemplate(`Hi ${token}`, { first_name: 'Uma' })).toMatchObject({ rendered: 'Hi Uma', unresolved: [], unknown: [] });
  });

  it('escapes recipient values when rendering HTML', () => {
    const result = renderContentTemplate(
      '<p>Hello {{first_name}}</p>',
      { first_name: '<img src=x onerror=alert(1)>' },
      { escapeHtml: true },
    );
    expect(result.rendered).toContain('&lt;img');
    expect(result.rendered).not.toContain('<img');
  });
});

describe('email HTML sanitization', () => {
  it('removes scripts, event handlers, embedded frames, and unsafe URLs', () => {
    const sanitized = sanitizeEmailHtml(`
      <html><body onload="alert(1)">
        <script>alert(1)</script>
        <iframe src="https://evil.example"></iframe>
        <a href="javascript:alert(1)">bad</a>
        <img src="https://cdn.example/logo.png" onerror="alert(1)">
      </body></html>
    `);
    expect(sanitized).not.toMatch(/script|iframe|onload|onerror|javascript:/i);
    expect(sanitized).toContain('https://cdn.example/logo.png');
  });
});

describe('strict placeholder grammar and explicit timezone', () => {
  it.each(['{{1}}','{{ unknown label }}','{{}}','{{{first_name}}}','{{first_name','}}'])('does not classify malformed %s as resolved', token => {
    expect(renderContentTemplate(token,{first_name:'Ada'}).unresolved.length).toBeGreaterThan(0);
  });
  it('uses the declared timezone and a host-independent UTC default across year boundaries', () => {
    const now = new Date('2027-01-01T00:30:00Z');
    const text = '{{current_date}} / {{current_year}} / {{current_month}}';
    expect(renderContentTemplate(text,{}, {now}).rendered).toBe('1/1/2027 / 2027 / January');
    expect(renderContentTemplate(text,{}, {now,timeZone:'America/Los_Angeles'}).rendered).toBe('12/31/2026 / 2026 / December');
    expect(renderContentTemplate(text,{}, {now,timeZone:'Asia/Kolkata'}).rendered).toBe('1/1/2027 / 2027 / January');
  });
});
