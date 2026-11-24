/**
 * Lead Deduplication Service
 * Handles duplicate detection and merging for leads
 */

import { db } from "../../models/db";
import { leadsTable } from "../../models/leads/schema";
import { eq, and, or, like } from "drizzle-orm";
import { logger } from '../../utils/logger.js';

interface LeadDuplicateMatch {
  existingLeadId: number;
  similarity: number;
  matchType: 'email' | 'company_role' | 'linkedin' | 'partial';
}

export class LeadDeduplicationService {
  /**
   * Check if a lead is a duplicate and return matches
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async findDuplicates(leadData: any): Promise<LeadDuplicateMatch[]> {
    const matches: LeadDuplicateMatch[] = [];

    // 1. Exact email match (highest priority - 100%)
    if (leadData.email) {
      const emailMatch = await db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(eq(leadsTable.email, leadData.email.toLowerCase()))
        .limit(1);

      if (emailMatch.length > 0) {
        matches.push({
          existingLeadId: emailMatch[0].id,
          similarity: 1.0,
          matchType: 'email',
        });
        return matches; // Return immediately for email match
      }
    }

    // 2. Company + Role match (90%)
    if (leadData.company && leadData.role) {
      const roleMatch = await db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.company, leadData.company),
            eq(leadsTable.role, leadData.role),
            or(
              eq(leadsTable.firstName, leadData.firstName || ''),
              eq(leadsTable.lastName, leadData.lastName || '')
            )
          )
        )
        .limit(1);

      if (roleMatch.length > 0) {
        matches.push({
          existingLeadId: roleMatch[0].id,
          similarity: 0.9,
          matchType: 'company_role',
        });
      }
    }

    // 3. LinkedIn profile match (85%)
    if (leadData.linkedinUsername) {
      const linkedinMatch = await db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(eq(leadsTable.linkedinUsername, leadData.linkedinUsername))
        .limit(1);

      if (linkedinMatch.length > 0) {
        matches.push({
          existingLeadId: linkedinMatch[0].id,
          similarity: 0.85,
          matchType: 'linkedin',
        });
      }
    }

    // 4. Name + Email partial match (75%)
    if (leadData.firstName && leadData.email) {
      const firstEmail = leadData.email.split('@')[0];
      const partialMatches = await db
        .select({ id: leadsTable.id, email: leadsTable.email })
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.firstName, leadData.firstName),
            like(leadsTable.email, `%${firstEmail}%`)
          )
        )
        .limit(3);

      for (const match of partialMatches) {
        matches.push({
          existingLeadId: match.id,
          similarity: 0.75,
          matchType: 'partial',
        });
      }
    }

    return matches;
  }

  /**
   * Deduplicate a single lead - returns the ID to use (new or existing)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async deduplicateLeadBeforeSave(leadData: any, threshold = 0.85): Promise<{ isDuplicate: boolean; leadId?: number; action: 'create' | 'merge' | 'skip' }> {
    const matches = await this.findDuplicates(leadData);

    if (matches.length === 0) {
      return { isDuplicate: false, action: 'create' };
    }

    const bestMatch = matches[0]; // Highest similarity first

    if (bestMatch.similarity >= threshold) {
      logger.info(
        `[LeadDeduplication] Found duplicate (${bestMatch.matchType}, ${(bestMatch.similarity * 100).toFixed(0)}%): Lead ${bestMatch.existingLeadId}`
      );

      return {
        isDuplicate: true,
        leadId: bestMatch.existingLeadId,
        action: 'merge',
      };
    }

    return { isDuplicate: false, action: 'create' };
  }

  /**
   * Merge duplicate lead data into existing lead
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async mergeLead(existingLeadId: number, newLeadData: any): Promise<void> {
    const [existing] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, existingLeadId))
      .limit(1);

    if (!existing) {
      throw new Error(`Lead ${existingLeadId} not found`);
    }

    // Merge strategy: keep existing data unless new data is more complete
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mergedData: any = {
      ...existing,
    };

    // Update fields that are missing in existing but present in new
    if (!existing.email && newLeadData.email) mergedData.email = newLeadData.email;
    if (!existing.phone && newLeadData.phone) mergedData.phone = newLeadData.phone;
    if (!existing.linkedinUsername && newLeadData.linkedinUsername) mergedData.linkedinUsername = newLeadData.linkedinUsername;
    if (!existing.twitter && newLeadData.twitter) mergedData.twitter = newLeadData.twitter;
    if (!existing.website && newLeadData.website) mergedData.website = newLeadData.website;
    if (!existing.headline && newLeadData.headline) mergedData.headline = newLeadData.headline;
    if (!existing.bio && newLeadData.bio) mergedData.bio = newLeadData.bio;

    // Add source to sources array if not present
    if (newLeadData.source && (!existing.sources || !existing.sources.includes(newLeadData.source))) {
      mergedData.sources = [...(existing.sources || []), newLeadData.source];
    }

    // Update import batch to track multiple sources
    if (newLeadData.importBatchId) {
      const batches = existing.importBatchId ? existing.importBatchId.split('|') : [];
      if (!batches.includes(newLeadData.importBatchId)) {
        batches.push(newLeadData.importBatchId);
      }
      mergedData.importBatchId = batches.join('|');
    }

    mergedData.updatedAt = new Date();

    await db
      .update(leadsTable)
      .set(mergedData)
      .where(eq(leadsTable.id, existingLeadId));

    logger.info({ existingLeadId: existingLeadId }, '[LeadDeduplication] Merged lead into');
  }

  /**
   * Batch deduplicate multiple leads
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  static async batchDeduplicateLeads(leadsData: any[], threshold = 0.75): Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toCreate: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toMerge: Array<{ existingId: number; newData: any }>;
    duplicates: number;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toCreate: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toMerge: Array<{ existingId: number; newData: any }> = [];
    let duplicateCount = 0;

    for (const leadData of leadsData) {
      const result = await this.deduplicateLeadBeforeSave(leadData);

      if (result.action === 'create') {
        toCreate.push(leadData);
      } else if (result.action === 'merge' && result.leadId) {
        toMerge.push({ existingId: result.leadId, newData: leadData });
        duplicateCount++;
      }
    }

    logger.info(
      `[LeadDeduplication] Batch processed: ${toCreate.length} new, ${toMerge.length} merges, ${duplicateCount} duplicates`
    );

    return { toCreate, toMerge, duplicates: duplicateCount };
  }
}
