/** Versioned presentation only: these designs never add offers, claims or links. */
export const EMAIL_DESIGNS = [
  { id: 'classic', name: 'Classic', description: 'A familiar branded card.', background: '#f3f6fa', accent: '#2563eb', align: 'center', radius: 16, border: 'bottom', font: 'Arial,Helvetica,sans-serif' },
  { id: 'letter', name: 'Personal letter', description: 'Quiet, direct and personal.', background: '#ffffff', accent: '#64748b', align: 'left', radius: 0, border: 'none', font: 'Arial,Helvetica,sans-serif' },
  { id: 'hospitality', name: 'Warm welcome', description: 'Warm neutrals for thoughtful service.', background: '#f5f0e8', accent: '#98734c', align: 'center', radius: 20, border: 'bottom', font: 'Georgia,serif' },
  { id: 'editorial', name: 'Editorial', description: 'A refined, spacious reading experience.', background: '#f4f3ef', accent: '#27272a', align: 'left', radius: 0, border: 'top', font: 'Georgia,serif' },
  { id: 'bold', name: 'Brand spotlight', description: 'A confident accent with a clear message.', background: '#edf2fb', accent: '#4f46e5', align: 'left', radius: 12, border: 'top', font: 'Arial,Helvetica,sans-serif' },
  { id: 'executive', name: 'Executive', description: 'Structured and polished for business.', background: '#e9eef3', accent: '#18354c', align: 'left', radius: 4, border: 'bottom', font: 'Arial,Helvetica,sans-serif' },
  { id: 'conversation', name: 'Conversation', description: 'A friendly card for ongoing replies.', background: '#eff7f5', accent: '#0f766e', align: 'left', radius: 24, border: 'left', font: 'Arial,Helvetica,sans-serif' },
  { id: 'framed', name: 'Framed', description: 'A fine border around your message.', background: '#fafafa', accent: '#71717a', align: 'center', radius: 0, border: 'frame', font: 'Georgia,serif' },
  { id: 'midnight', name: 'Midnight', description: 'A dark surround with a readable white card.', background: '#162338', accent: '#60a5fa', align: 'center', radius: 16, border: 'top', font: 'Arial,Helvetica,sans-serif' },
  { id: 'compact', name: 'Compact', description: 'Less space, the same clear branding.', background: '#f8fafc', accent: '#475569', align: 'left', radius: 8, border: 'left', font: 'Arial,Helvetica,sans-serif' },
] as const;
export type EmailDesignId = typeof EMAIL_DESIGNS[number]['id'];
export interface EmailBrand { companyName: string; logoUrl: string | null; primaryColor: string }
export interface EmailDesignPreferences { outreach: EmailDesignId; assistant: EmailDesignId; revision: string }
export const DEFAULT_EMAIL_DESIGN_PREFERENCES: EmailDesignPreferences = { outreach: 'classic', assistant: 'classic', revision: 'initial' };
export function isEmailDesignId(value: unknown): value is EmailDesignId { return EMAIL_DESIGNS.some(design => design.id === value); }
export function escapeEmailAttribute(value: string): string { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
/** Only public HTTPS or development HTTP image sources are usable in Gmail. */
export function absoluteEmailLogo(value: string | null | undefined, origin: string): string | null {
  if (!value || value.startsWith('//')) return null;
  try {
    const base = new URL(origin);
    const url = new URL(value, base);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) return null;
    return url.href;
  } catch { return null; }
}
export function renderEmailDesign({ brand, body, designId = 'classic', preheader, footerText }: {
  brand: EmailBrand; body: string; designId?: EmailDesignId; preheader?: string; footerText?: string;
}): string {
  const design = EMAIL_DESIGNS.find(item => item.id === designId) || EMAIL_DESIGNS[0];
  const content = body.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? body;
  const name = escapeEmailAttribute(brand.companyName);
  const color = /^#[\da-f]{6}$/i.test(brand.primaryColor) ? brand.primaryColor : design.accent;
  const logo = absoluteEmailLogo(brand.logoUrl, 'https://asksales.ai');
  const padding = design.id === 'compact' ? 20 : 36;
  const edge = design.border === 'top' ? `border-top:6px solid ${color};` : design.border === 'left' ? `border-left:4px solid ${color};` : design.border === 'frame' ? `border:1px solid ${color};` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title></head>
<body style="margin:0;padding:0;background:${design.background};color:#243247;font-family:${design.font}">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeEmailAttribute(preheader)}</div>` : ''}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${design.background};border-collapse:collapse"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" data-email-design="${design.id}" style="max-width:600px;background:#ffffff;border-radius:${design.radius}px;${edge}">
<tr><td style="padding:${padding}px ${padding}px 22px;text-align:${design.align};background:#ffffff;${design.border === 'bottom' ? `border-bottom:2px solid ${color};` : ''}">
${logo ? `<img src="${escapeEmailAttribute(logo)}" alt="${name}" height="48" style="display:inline-block;height:auto;max-height:48px;max-width:200px;border:0;vertical-align:middle">` : `<span style="font-size:23px;font-weight:700;color:${color}">${name}</span>`}</td></tr>
<tr><td style="padding:${padding}px;font-size:15px;line-height:1.75;overflow-wrap:anywhere">${content}</td></tr>
<tr><td style="padding:20px ${padding}px;border-top:1px solid #e7eaf0;text-align:${design.align};font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#64748b">${footerText ? escapeEmailAttribute(footerText) : `&copy; ${new Date().getFullYear()} ${name}. All rights reserved.`}</td></tr>
</table></td></tr></table></body></html>`;
}
