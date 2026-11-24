import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

describe('WhatsApp provider readiness presentation', () => {
  const page = read('src/app/dashboard/(main)/integrations/whatsapp/page.tsx');
  const connection = read('src/app/dashboard/(main)/integrations/whatsapp/components/WhatsAppConnection.tsx');
  const summary = read('src/app/dashboard/(main)/integrations/whatsapp/components/WhatsAppConnectionSummary.tsx');
  const adminMeta = read('src/app/admin/dashboard/integrations/meta_app/page.tsx');

  it('does not present a stored credential as connected while provider action is required', () => {
    expect(page).toContain("config?.connectionStatus === 'ready'");
    expect(page).toContain('"Action required"');
    expect(connection).toContain("settings?.connectionStatus === 'ready'");
    expect(connection).toContain("settings?.connectionStatus === 'reauth_required'");
  });

  it('keeps Meta billing and review advisories out of client presentation', () => {
    expect(page).toContain("config?.connectionStatus === 'limited'");
    expect(page).not.toContain('Reply ready · proactive messaging limited');
    expect(page).not.toContain('payment method before using proactive');
    expect(connection).toContain("settings?.readinessErrorCode === 'WABA_HEALTH'");
    expect(connection).toContain("settings?.readinessErrorCode === 'APP_REVIEW'");
    expect(connection).not.toContain('Customer-initiated service replies remain available');
    expect(connection).not.toContain('business-initiated or template messaging');
    expect(connection).not.toContain('WhatsApp connected with proactive messaging limited');
    expect(connection).not.toContain('Proactive and template messaging require Meta billing');
    expect(page).toContain('<WhatsAppConnectionSummary');
    expect(summary).toContain('Customer replies');
    expect(summary).toContain('Test connection');
    expect(summary).toContain('status.readiness?.customerReplies && status.readiness?.webhook');
    expect(page).toContain("connectedLabel=\"Connected\"");
  });

  it('explains a missing Meta phone-number binding without recommending a blind reconnect', () => {
    expect(connection).toContain("settings?.readinessErrorCode === 'meta_100_33'");
    expect(connection).toContain('Meta no longer exposes the selected phone number');
    expect(connection).toContain('Reconnecting alone cannot restore a disabled account.');
    expect(connection).toContain('Open WhatsApp Manager');
  });

  it('surfaces OAuth callback outcomes and removes them from browser history', () => {
    expect(page).toContain('params.get("error")');
    expect(page).toContain('params.get("whatsapp_connected") === "true"');
    expect(page).toContain('title: "WhatsApp connection failed"');
    expect(page).toContain('window.history.replaceState');
  });

  it('makes the governed WhatsApp Embedded Signup configuration editable by platform administrators', () => {
    expect(adminMeta).toContain('WhatsApp Embedded Signup Configuration ID');
    expect(adminMeta).toContain('configId: configId.trim() || undefined');
    expect(connection).toContain('title: "Connection could not start"');
  });
});
