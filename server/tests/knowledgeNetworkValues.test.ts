import { describe, expect, it } from '@jest/globals';
import { isNonPersonalDottedQuad, redactKnowledgeText, scanKnowledgeContent } from '../services/knowledge/KnowledgePrivacyService.js';
import { redactPiiWithStableTokens } from '../services/agents/orchestration/PrivacyVaultService.js';

describe('knowledge network and version values', () => {
  it('does not classify LAN setup addresses or version numbers as personal data', () => {
    const scan = scanKnowledgeContent('Open the setup page at 192.168.77.1 or 10.0.0.1. Firmware 4.2.300.18 fixes Wi-Fi drops. Version 1.2.3.4 is current.');
    expect(scan.containsPersonalData).toBe(false);
    expect(scan.classification).toBe('business');
    expect(scan.searchText).toContain('192.168.77.1');
    expect(scan.searchText).toContain('4.2.300.18');
  });
  it('still treats a public address as personal data in knowledge content', () => {
    const scan = scanKnowledgeContent('The customer connected from 8.8.4.4 yesterday.');
    expect(scan.containsPersonalData).toBe(true);
    expect(scan.reasons).toEqual(expect.arrayContaining(['personal_data_detected', 'personal_data:ip_address']));
  });
  it('keeps other personal data detection when a LAN address is present', () => {
    const scan = scanKnowledgeContent('Setup page 192.168.1.1. Contact jane.doe@example.com for help.');
    expect(scan.containsPersonalData).toBe(true);
    expect(scan.searchText).toContain('192.168.1.1');
    expect(scan.searchText).not.toContain('jane.doe@example.com');
  });
  it('answers from knowledge keep the LAN address while customer messages stay redacted', () => {
    expect(redactKnowledgeText('Visit 192.168.77.1 to configure.')).toBe('Visit 192.168.77.1 to configure.');
    expect(redactPiiWithStableTokens('My router is 192.168.77.1').redactedText).not.toContain('192.168.77.1');
  });
  it('classifies ranges precisely', () => {
    expect(isNonPersonalDottedQuad('172.16.0.1')).toBe(true);
    expect(isNonPersonalDottedQuad('172.32.0.1')).toBe(false);
    expect(isNonPersonalDottedQuad('203.0.113.9')).toBe(true);
    expect(isNonPersonalDottedQuad('1.2.3.4', 'build ')).toBe(true);
    expect(isNonPersonalDottedQuad('1.2.3.4')).toBe(false);
  });
});
