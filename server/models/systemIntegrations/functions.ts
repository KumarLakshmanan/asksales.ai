/**
 * System Integrations Model Functions
 */

import { db } from '../db';
import { logger } from '../../utils/logger.js';
import { systemIntegrationsTable, SystemIntegrationRecord, InsertSystemIntegration } from './schema';
 
import { eq } from 'drizzle-orm';

export const SystemIntegrationModel = {
  /**
   * Get all integrations
   */
  async findAll(): Promise<SystemIntegrationRecord[]> {
    return db.select().from(systemIntegrationsTable).orderBy(systemIntegrationsTable.name);
  },

  /**
   * Get all enabled integrations
   */
  async findEnabled(): Promise<SystemIntegrationRecord[]> {
    return db
      .select()
      .from(systemIntegrationsTable)
      .where(eq(systemIntegrationsTable.isEnabled, true))
      .orderBy(systemIntegrationsTable.name);
  },

  /**
   * Get integrations by category
   */
  async findByCategory(category: string): Promise<SystemIntegrationRecord[]> {
    return db
      .select()
      .from(systemIntegrationsTable)
      .where(eq(systemIntegrationsTable.category, category))
      .orderBy(systemIntegrationsTable.name);
  },

  /**
   * Get integration by ID
   */
  async findById(id: number): Promise<SystemIntegrationRecord | undefined> {
    const [integration] = await db
      .select()
      .from(systemIntegrationsTable)
      .where(eq(systemIntegrationsTable.id, id))
      .limit(1);
    return integration;
  },

  /**
   * Get integration by integrationId string
   */
  async findByIntegrationId(integrationId: string): Promise<SystemIntegrationRecord | undefined> {
    const [integration] = await db
      .select()
      .from(systemIntegrationsTable)
      .where(eq(systemIntegrationsTable.integrationId, integrationId))
      .limit(1);
    return integration;
  },

  /**
   * Create a new integration
   */
  async create(data: InsertSystemIntegration): Promise<SystemIntegrationRecord> {
    const [integration] = await db
      .insert(systemIntegrationsTable)
      .values(data)
      .returning();
    return integration;
  },

  /**
   * Update an integration
   */
  async update(
    id: number,
    data: Partial<InsertSystemIntegration>
  ): Promise<SystemIntegrationRecord | undefined> {
    const [updated] = await db
      .update(systemIntegrationsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(systemIntegrationsTable.id, id))
      .returning();
    return updated;
  },

  /**
   * Toggle integration enabled status
   */
  async toggleEnabled(id: number): Promise<SystemIntegrationRecord | undefined> {
    const integration = await this.findById(id);
    if (!integration) return undefined;

    const [updated] = await db
      .update(systemIntegrationsTable)
      .set({ 
        isEnabled: !integration.isEnabled, 
        updatedAt: new Date() 
      })
      .where(eq(systemIntegrationsTable.id, id))
      .returning();
    return updated;
  },

  /**
   * Update integration status
   */
  async updateStatus(
    id: number,
    status: 'available' | 'beta' | 'coming_soon' | 'maintenance' | 'disabled'
  ): Promise<SystemIntegrationRecord | undefined> {
    const [updated] = await db
      .update(systemIntegrationsTable)
      .set({ status, updatedAt: new Date() })
      .where(eq(systemIntegrationsTable.id, id))
      .returning();
    return updated;
  },

  /**
   * Delete an integration
   */
  async delete(id: number): Promise<void> {
    await db.delete(systemIntegrationsTable).where(eq(systemIntegrationsTable.id, id));
  },

  /**
   * Get integration stats
   */
  async getStats(): Promise<{
    total: number;
    enabled: number;
    byCategory: Record<string, number>;
    byStatus: Record<string, number>;
  }> {
    const integrations = await this.findAll();
    
    const byCategory: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let enabled = 0;

    for (const integration of integrations) {
      // Count by category
      byCategory[integration.category] = (byCategory[integration.category] || 0) + 1;
      
      // Count by status
      byStatus[integration.status] = (byStatus[integration.status] || 0) + 1;
      
      // Count enabled
      if (integration.isEnabled) enabled++;
    }

    return {
      total: integrations.length,
      enabled,
      byCategory,
      byStatus,
    };
  },

  /**
   * Seed default integrations if not exists
   */
  async seedDefaults(): Promise<void> {
    const existing = await this.findAll();
    if (existing.length > 0) return;

    const defaultIntegrations: InsertSystemIntegration[] = [
      {
        integrationId: 'email_gmail',
        name: 'Gmail',
        description: 'Send emails through Gmail API. Supports OAuth authentication, email tracking, and scheduled sends.',
        category: 'email',
        type: 'official',
        status: 'available',
        isEnabled: true,
        features: ['OAuth Authentication', 'Email Tracking', 'Scheduled Sends', 'Template Support'],
        oauthSettings: {
          clientIdEnvVar: 'GMAIL_CLIENT_ID',
          clientSecretEnvVar: 'GMAIL_CLIENT_SECRET',
          scopes: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'],
        },
        documentationUrl: 'https://developers.google.com/gmail/api',
        iconName: 'Mail',
      },
      {
        integrationId: 'email_smtp',
        name: 'SMTP Email',
        description: 'Generic SMTP email integration for custom email providers.',
        category: 'email',
        type: 'official',
        status: 'available',
        isEnabled: true,
        features: ['Custom SMTP Server', 'SSL/TLS Support', 'Multiple Providers'],
        iconName: 'Mail',
      },
      {
        integrationId: 'instagram_official',
        name: 'Instagram (Official API)',
        description: 'Official Meta Graph API integration for Instagram Business/Creator accounts. Supports webhooks for real-time message notifications.',
        category: 'social',
        type: 'official',
        status: 'available',
        isEnabled: true,
        features: ['OAuth Login', 'Webhook Notifications', 'Send/Receive Messages', 'Profile Access'],
        oauthSettings: {
          clientIdEnvVar: 'META_APP_ID',
          clientSecretEnvVar: 'META_APP_SECRET',
          scopes: [
            'instagram_basic',
            'instagram_manage_messages',
            'instagram_manage_comments',
            'pages_manage_metadata',
            'pages_read_engagement',
            'pages_show_list',
            'pages_messaging',
          ],
          webhookSupported: true,
        },
        documentationUrl: 'https://developers.facebook.com/docs/instagram-api',
        iconName: 'Instagram',
      },
      {
        integrationId: 'linkedin_official',
        name: 'LinkedIn (Official API)',
        description: 'Official LinkedIn Marketing API for messaging and engagement.',
        category: 'social',
        type: 'official',
        status: 'coming_soon',
        isEnabled: false,
        features: ['OAuth Login', 'Connection Requests', 'InMail'],
        documentationUrl: 'https://developer.linkedin.com',
        iconName: 'MessageSquare',
      },
      {
        integrationId: 'whatsapp_api',
        name: 'WhatsApp Business API',
        description: 'Official WhatsApp Business API for customer messaging.',
        category: 'messaging',
        type: 'official',
        status: 'coming_soon',
        isEnabled: false,
        features: ['Business Messaging', 'Template Messages', 'Webhook Notifications'],
        documentationUrl: 'https://developers.facebook.com/docs/whatsapp',
        iconName: 'MessageSquare',
      },
    ];

    for (const integration of defaultIntegrations) {
      await this.create(integration);
    }

    logger.info(`[SystemIntegrations] Seeded ${defaultIntegrations.length} default integrations`);
  },
};
