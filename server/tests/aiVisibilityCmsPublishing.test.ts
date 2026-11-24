import { describe, expect, it } from '@jest/globals';
import {
  cmsDraftHandle,
  extractCmsBody,
  normalizeShopifyStoreDomain,
  normalizeWordPressSiteUrl,
  requireExactAiVisibilityAssetApproval,
} from '../services/aiVisibility/CmsDraftPublishingService.js';

describe('AI Visibility CMS draft publishing helpers', () => {
  it('normalizes public CMS destinations without retaining URL secrets', () => {
    expect(normalizeWordPressSiteUrl('example.com/')).toBe('https://example.com');
    expect(normalizeWordPressSiteUrl('https://example.com/site///')).toBe('https://example.com/site');
    expect(() => normalizeWordPressSiteUrl('https://user:secret@example.com')).toThrow('without credentials');
    expect(() => normalizeWordPressSiteUrl('file:///etc/passwd')).toThrow('valid public website');
  });

  it('accepts only permanent Shopify store domains', () => {
    expect(normalizeShopifyStoreDomain('https://orbit-store.myshopify.com/')).toBe('orbit-store.myshopify.com');
    expect(() => normalizeShopifyStoreDomain('shop.example.com')).toThrow('myshopify.com');
    expect(() => normalizeShopifyStoreDomain('orbit-store.myshopify.com/admin')).toThrow('myshopify.com');
  });

  it('creates a stable version-specific handle for remote reconciliation', () => {
    expect(cmsDraftHandle('AI Search: Buyer’s Guide!', 41, 3)).toBe('ai-search-buyer-s-guide-ai-41-v3');
    expect(cmsDraftHandle('AI Search: Buyer’s Guide!', 41, 4)).not.toBe(cmsDraftHandle('AI Search: Buyer’s Guide!', 41, 3));
  });

  it('extracts common structured content fields and preserves plain content', () => {
    expect(extractCmsBody(JSON.stringify({ title: 'Example', body: '<p>Approved body</p>' }))).toBe('<p>Approved body</p>');
    expect(extractCmsBody('  Plain approved content  ')).toBe('Plain approved content');
    expect(extractCmsBody(JSON.stringify({ unknown: true }))).toBe('{"unknown":true}');
  });

  it('requires an explicit exact-version AI Visibility decision', () => {
    const approvedAsset = {
      assetVersion: 3,
      assetApprovalStatus: 'approved',
      assetApprovedBy: 42,
      assetApprovedAt: new Date('2026-08-18T08:00:00.000Z'),
    };
    expect(() => requireExactAiVisibilityAssetApproval({
      ...approvedAsset,
      decision: null,
    })).toThrow('Approve this exact asset version in AI Visibility');
    expect(() => requireExactAiVisibilityAssetApproval({
      ...approvedAsset,
      decision: { actorUserId: 42, assetVersion: 2, decision: 'approved', createdAt: new Date() },
    })).toThrow('Approve this exact asset version in AI Visibility');
    expect(requireExactAiVisibilityAssetApproval({
      ...approvedAsset,
      decision: { actorUserId: 42, assetVersion: 3, decision: 'approved', createdAt: new Date('2026-08-18T08:00:01.000Z') },
    }).actorUserId).toBe(42);
  });
});
