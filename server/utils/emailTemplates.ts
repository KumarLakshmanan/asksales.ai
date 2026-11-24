/**
 * Unified Email Templates for Admin/System Emails
 * Provides a premium, consistent design across all system-generated emails.
 */

import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { currentBusinessScope } from '../tenancy/businessContext.js';
import { absoluteEmailLogo, renderEmailDesign, type EmailDesignId } from '../../shared/emailDesigns.js';

interface EmailTemplateOptions {
  title: string;
  preheader?: string;
  name?: string;
  content: string; // HTML allowed
  cta?: {
    label: string;
    url: string;
  };
  otp?: string;
  otpLabel?: string;
  footer?: string;
}

export function renderAdminEmail({
  title,
  preheader,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  name,
  content,
  cta,
  otp,
  otpLabel,
  footer
}: EmailTemplateOptions): string {
  const currentYear = new Date().getFullYear();
  const primaryColor = '#7c4dff'; // AskSales Indigo (based on 259 75% 60%)
  const textColor = '#18181b';
  const mutedTextColor = '#71717a';
  const codeLabel = otpLabel || 'Your Code';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <!--[if mso]>
  <style type="text/css">
    body, table, td, a { font-family: Arial, Helvetica, sans-serif !important; }
  </style>
  <![endif]-->
</head>
<body style="margin: 0; padding: 0; font-family: 'Outfit', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: ${textColor};">
  <div style="display: none; max-height: 0px; overflow: hidden;">
    ${preheader || title}
  </div>
  
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f8fafc;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <!-- Container -->
        <table role="presentation" style="width: 100%; max-width: 600px; border-collapse: collapse; background-color: #ffffff; border-radius: 20px; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.05);">
          <!-- Header/Logo -->
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center;">
              <h2 style="margin: 0; font-size: 24px; font-weight: 800; color: ${primaryColor}; letter-spacing: -0.5px;">
                AskSales.ai
              </h2>
            </td>
          </tr>
          
          <!-- Main Content -->
          <tr>
            <td style="padding: 20px 40px 40px;">
              <h1 style="margin: 0 0 24px; font-size: 22px; font-weight: 700; color: ${textColor}; line-height: 1.2;">
                ${title}
              </h1>
              
              <div style="margin: 0 0 30px; font-size: 16px; line-height: 26px; color: ${mutedTextColor};">
                ${content}
              </div>
              
              <!-- Verification OTP box if present -->
              ${otp ? `
              <div style="width: 100%; max-width: 100%; box-sizing: border-box; background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px; text-align: center; margin-bottom: 30px;">
                <div style="font-size: 12px; font-weight: 700; color: ${mutedTextColor}; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 12px;">${codeLabel}</div>
                <div style="display: block; max-width: 100%; box-sizing: border-box; color: ${primaryColor}; margin-bottom: 8px; font-family: 'Courier New', monospace; font-size: 42px; line-height: 50px; font-weight: 800; letter-spacing: 12px; overflow-wrap: anywhere; word-break: break-all; white-space: normal;">
                  ${otp}
                </div>
              </div>
              ` : ''}
              
              <!-- CTA Button if present -->
              ${cta ? `
              <div style="text-align: center; margin-bottom: 30px;">
                <a href="${cta.url}" style="display: inline-block; padding: 16px 36px; background-color: ${primaryColor}; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 700; border-radius: 12px; box-shadow: 0 4px 10px rgba(124, 77, 255, 0.3);">
                  ${cta.label}
                </a>
              </div>
              ` : ''}
              
              <p style="margin: 0; font-size: 14px; line-height: 22px; color: ${mutedTextColor};">
                If you have any questions, feel free to reply to this email.
              </p>
            </td>
          </tr>
          
          <!-- Footer Divider -->
          <tr>
            <td style="padding: 0 40px;">
              <div style="border-top: 1px solid #f1f5f9;"></div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px 40px; text-align: center;">
              <p style="margin: 0 0 10px; font-size: 13px; color: ${mutedTextColor};">
                ${footer || `© ${currentYear} AskSales.ai Platform. All rights reserved.`}
              </p>
              <div style="font-size: 12px; color: #a1a1aa;">
                Building the future of AI-powered sales marketing.
              </div>
            </td>
          </tr>
        </table>
        
        <!-- Bottom Link -->
        <table role="presentation" style="width: 100%; max-width: 600px; border-collapse: collapse;">
          <tr>
            <td style="padding-top: 24px; text-align: center;">
              <p style="margin: 0; font-size: 12px; color: #a1a1aa;">
                You received this email because you are a registered user of AskSales.ai.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

// ─── Branded Email Template (User's Brand Toolkit) ──────────────────────────

interface BrandInfo {
  companyName: string;
  logoUrl: string | null;
  primaryColor: string;
}

/** A stored workflow brand ID, or null when the item has no explicit brand. */
export function savedBrandToolkitId(value: unknown): number | null {
  const id = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Fetch the brand toolkit used for email branding.
 *
 * A workflow (campaign, outreach thread, follow-up) passes the brand it was
 * created with; that brand is used even after the business changes its default.
 * Only items without a saved brand fall back to the current default toolkit.
 * The explicit lookup is bound to the owner and the active business profile.
 * Background jobs without a business scope pass the record's business so the
 * fallback default comes from that business, not another one of the owner's.
 */
export async function getBrandInfo(userId: number, brandToolkitId?: number | null, recordBusinessProfileId?: number | null): Promise<BrandInfo> {
  try {
    const scope = currentBusinessScope();
    const businessId = scope?.businessProfileId ?? savedBrandToolkitId(recordBusinessProfileId);
    const businessFilter = businessId ? sql`AND business_profile_id = ${businessId}` : sql``;
    const explicitId = savedBrandToolkitId(brandToolkitId);
    let row: Record<string, unknown> | undefined;
    if (explicitId) {
      const explicit = await db.execute(sql`
        SELECT name, logo_url, primary_brand_color
        FROM brand_toolkits
        WHERE id = ${explicitId} AND user_id = ${userId} AND is_active = true
          ${businessFilter}
        LIMIT 1
      `);
      row = explicit.rows[0] as Record<string, unknown> | undefined;
    }
    if (!row) {
      const result = await db.execute(sql`
        SELECT name, logo_url, primary_brand_color
        FROM brand_toolkits
        WHERE user_id = ${userId} AND is_active = true
          ${businessFilter}
        ORDER BY is_default DESC, created_at DESC
        LIMIT 1
      `);
      row = result.rows[0] as Record<string, unknown> | undefined;
    }
    if (row) {
      return {
        companyName: (row.name as string) || 'Our Company',
        logoUrl: absoluteEmailLogo(row.logo_url as string, process.env.CLIENT_URL || process.env.FRONTEND_URL || process.env.APP_URL || 'https://asksales.ai'),
        primaryColor: (row.primary_brand_color as string) || '#2563eb',
      };
    }
  } catch {
    // Fall through to defaults
  }
  return { companyName: 'Our Company', logoUrl: null, primaryColor: '#2563eb' };
}

interface BrandedEmailOptions {
  designId?: EmailDesignId;
  brand: BrandInfo;
  preheader?: string;
  recipientName?: string;
  body: string; // HTML content
  footerText?: string;
}

/**
 * Render a branded email using the user's brand toolkit (logo, colors, company name).
 * Used for customer-facing emails: ticket ack, support offers, proposals, staff replies.
 */
export function renderBrandedEmail(options: BrandedEmailOptions): string {
  return renderEmailDesign({ ...options, brand: { ...options.brand,
    logoUrl: absoluteEmailLogo(options.brand.logoUrl, process.env.CLIENT_URL || process.env.FRONTEND_URL || process.env.APP_URL || 'https://asksales.ai') } });
}

interface SupportReplyEmailOptions {
  brand: BrandInfo;
  preheader?: string;
  agentName?: string;
  body: string; // HTML content
  ticketNumber?: string;
  footerText?: string;
}

/**
 * Render a support reply email styled like a chat message bubble.
 * No "Hi" greeting — directly shows the reply content in a bubble.
 */
export function renderSupportReplyEmail({
  brand,
  preheader,
  agentName,
  body,
  ticketNumber,
  footerText,
}: SupportReplyEmailOptions): string {
  const { companyName, primaryColor } = brand;
  const logoUrl = absoluteEmailLogo(brand.logoUrl, process.env.CLIENT_URL || process.env.FRONTEND_URL || process.env.APP_URL || 'https://asksales.ai');
  const currentYear = new Date().getFullYear();
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true, day: 'numeric', month: 'short' });

  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" alt="${companyName}" style="max-height:36px;max-width:160px;" />`
    : `<span style="font-size:18px;font-weight:700;color:${primaryColor};">${companyName}</span>`;

  const agentInitial = agentName ? agentName.charAt(0).toUpperCase() : 'S';
  const displayName = agentName || 'Support';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${companyName} Support</title>
</head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#f0f2f5;color:#1a1a1a;">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;">${preheader}</div>` : ''}
  <table role="presentation" style="width:100%;border-collapse:collapse;background-color:#f0f2f5;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <!-- Header bar -->
        <table role="presentation" style="width:100%;max-width:560px;border-collapse:collapse;">
          <tr>
            <td style="padding:0 0 16px;text-align:center;">
              ${logoHtml}
            </td>
          </tr>
        </table>
        <!-- Message bubble container -->
        <table role="presentation" style="width:100%;max-width:560px;border-collapse:collapse;">
          <tr>
            <td style="padding:0;">
              <!-- Agent avatar + name -->
              <table role="presentation" style="border-collapse:collapse;margin-bottom:6px;">
                <tr>
                  <td style="width:32px;height:32px;background-color:${primaryColor};border-radius:50%;text-align:center;vertical-align:middle;color:#fff;font-size:14px;font-weight:700;">
                    ${agentInitial}
                  </td>
                  <td style="padding-left:10px;font-size:13px;font-weight:600;color:#555;">
                    ${displayName}
                    <span style="font-weight:400;color:#999;margin-left:8px;">${timestamp}</span>
                  </td>
                </tr>
              </table>
              <!-- Message bubble -->
              <table role="presentation" style="width:100%;border-collapse:collapse;">
                <tr>
                  <td style="padding:16px 20px;background-color:#ffffff;border-radius:4px 16px 16px 16px;box-shadow:0 1px 3px rgba(0,0,0,0.08);font-size:15px;line-height:1.7;color:#333;">
                    ${body}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <!-- Ticket reference + footer -->
        <table role="presentation" style="width:100%;max-width:560px;border-collapse:collapse;">
          <tr>
            <td style="padding:16px 0 0;text-align:center;">
              ${ticketNumber ? `<p style="margin:0 0 8px;font-size:12px;color:#999;">Ticket: #${ticketNumber}</p>` : ''}
              <p style="margin:0;font-size:12px;color:#aaa;">
                ${footerText || `&copy; ${currentYear} ${companyName}`}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
