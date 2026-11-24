import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from "express";
import { createIcpData, getIcpDataById, updateIcpData } from "../models/icpData/functions";
import { db } from "../models/db";
import { sql } from "drizzle-orm";
import { logger } from '../utils/logger.js';
import { NotificationService } from '../services/NotificationService.js';
import { markIcpRevisionAwaitingApproval } from '../models/conversationWorkflow/functions.js';
import { getIcpCompleteness } from '../utils/icpCompleteness.js';

// List all ICP profiles for the current user
export async function listIcpProfilesHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Authentication required" });
    const businessId = req.query.businessId ? parseInt(req.query.businessId as string) : undefined;

    let query;
    if (businessId) {
      query = sql`
        SELECT ip.id, ip.business_id, ip.campaign_name, ip.campaign_objective, ip.target_audience, 
               ip.industry, ip.sub_industry, ip.target_company_size_range, ip.primary_regions, 
               ip.primary_job_titles, ip.fit_score, ip.status, ip.created_at,
               cs.name as business_name
        FROM icp_profiles ip
        LEFT JOIN company_settings cs ON ip.business_id = cs.id
        WHERE ip.user_id = ${userId} AND ip.business_id = ${businessId}
        ORDER BY ip.updated_at DESC
      `;
    } else {
      query = sql`
        SELECT ip.id, ip.business_id, ip.campaign_name, ip.campaign_objective, ip.target_audience, 
               ip.industry, ip.sub_industry, ip.target_company_size_range, ip.primary_regions, 
               ip.primary_job_titles, ip.fit_score, ip.status, ip.created_at,
               cs.name as business_name
        FROM icp_profiles ip
        LEFT JOIN company_settings cs ON ip.business_id = cs.id
        WHERE ip.user_id = ${userId}
        ORDER BY ip.updated_at DESC
      `;
    }

    const result = await db.execute(query);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const icps = result.rows.map((row: any) => ({
      id: row.id,
      businessId: row.business_id,
      businessName: row.business_name,
      campaignName: row.campaign_name || "Untitled ICP",
      campaignObjective: row.campaign_objective,
      targetAudience: row.target_audience || "",
      industry: row.industry || "",
      subIndustry: row.sub_industry,
      targetCompanySizeRange: row.target_company_size_range,
      primaryRegions: row.primary_regions,
      primaryJobTitles: row.primary_job_titles,
      fitScore: row.fit_score || 0,
      status: row.status,
      createdAt: row.created_at,
    }));

    return res.json({ icpProfiles: icps });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error listing ICP profiles');
    return res.status(500).json({ error: "Unable to retrieve ICP profiles. Please try again." });
  }
}

// Get ICPs by business settings ID
export async function getIcpsByBusinessIdHandler(req: Request, res: Response) {
  try {
    const businessId = parseInt(req.params.businessId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    if (isNaN(businessId)) {
      return res.status(400).json({ error: "Invalid business ID" });
    }

    const result = await db.execute(sql`
      SELECT ip.*, cs.name as business_name, cs.company_name, cs.industry as business_industry
      FROM icp_profiles ip
      LEFT JOIN company_settings cs ON ip.business_id = cs.id
      WHERE ip.business_id = ${businessId} AND ip.user_id = ${userId}
      ORDER BY ip.updated_at DESC
    `);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const icps = result.rows.map((row: any) => ({
      id: row.id,
      uuid: row.uuid,
      businessId: row.business_id,
      businessName: row.business_name,
      companyName: row.company_name,
      businessIndustry: row.business_industry,
      campaignName: row.campaign_name,
      campaignObjective: row.campaign_objective,
      targetAudience: row.target_audience,
      summary: row.summary,
      industry: row.industry,
      subIndustry: row.sub_industry,
      targetCompanySizeRange: row.target_company_size_range,
      targetRevenueRange: row.target_revenue_range,
      targetBusinessModel: row.target_business_model,
      primaryRegions: row.primary_regions,
      primaryJobTitles: row.primary_job_titles,
      primaryChannels: row.primary_channels,
      budgetRange: row.budget_range,
      primaryValueProposition: row.primary_value_proposition,
      primaryPainPoint: row.primary_pain_point,
      fitScore: row.fit_score || 0,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return res.json({ icps });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error getting ICPs by business ID');
    return res.status(500).json({ error: "Unable to retrieve ICPs. Please try again." });
  }
}

// Build ICP from user input
export async function buildIcpHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { industry, companySize, location, painPoints, budget, businessId } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    // Create ICP data using the new schema
    // Note: The new ICP system is primarily driven through chat-based creation
    // This endpoint is for backward compatibility
    const icp = await createIcpData({
      userId,
      businessId: businessId || null,
      industry,
      targetCompanySizeRange: companySize,
      primaryPainPoint: painPoints ? (Array.isArray(painPoints) ? painPoints[0] : painPoints) : undefined,
      budgetRange: budget,
      targetAudience: `${industry} companies with ${companySize} employees`,
      status: 'draft',
    });

    return res.json({
      message: "ICP created successfully",
      icp,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error building ICP');
    return res.status(500).json({ error: "Unable to build the ICP. Please try again." });
  }
}

// Get ICP data by ID
export async function getIcpHandler(req: Request, res: Response) {
  try {
    const icpId = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (isNaN(icpId)) {
      return res.status(400).json({ error: "Invalid ICP ID" });
    }

    const icp = await getIcpDataById(icpId);
    if (!icp) {
      return res.status(404).json({ error: "ICP not found" });
    }

    // Verify ownership
    if (icp.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    return res.json(icp);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error getting ICP');
    return res.status(500).json({ error: "Unable to retrieve the ICP. Please try again." });
  }
}

// Get ICP by threadId (for loading ICP when refreshing chat)
export async function getIcpByThreadIdHandler(req: Request, res: Response) {
  try {
    const threadId = parseInt(req.params.threadId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    if (isNaN(threadId)) {
      return res.status(400).json({ error: "Invalid thread ID" });
    }

    // Fetch ICP from icp_profiles table by thread_id with business settings
    const result = await db.execute(sql`
      SELECT ip.*, cs.name as business_name, cs.company_name, cs.industry as business_industry,
             cs.website as business_website, cs.description as business_description
      FROM icp_profiles ip
      LEFT JOIN company_settings cs ON ip.business_id = cs.id
      WHERE ip.thread_id = ${threadId} AND ip.user_id = ${userId}
      ORDER BY ip.updated_at DESC
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      // Return empty ICP object instead of 404
      return res.json({
        id: null,
        uuid: null,
        userId: userId,
        businessId: null,
        businessName: null,
        threadId: threadId,
        campaignName: null,
        campaignObjective: null,
        targetAudience: null,
        summary: null,
        industry: null,
        subIndustry: null,
        targetCompanySizeRange: null,
        targetRevenueRange: null,
        targetBusinessModel: null,
        primaryRegions: null,
        primaryJobTitles: null,
        primaryChannels: null,
        budgetRange: null,
        primaryValueProposition: null,
        primaryPainPoint: null,
        fitScore: 0,
        userIntent: null,
        recommendedAgentScores: null,
        status: null,
        approved: false,
        approvedBy: null,
        approvedAt: null,
        createdAt: null,
        updatedAt: null,
      });
    }

    const icp = result.rows[0];

    // Return ICP with updated schema fields
    return res.json({
      id: icp.id,
      uuid: icp.uuid,
      userId: icp.user_id,
      businessId: icp.business_id,
      businessName: icp.business_name,
      companyName: icp.company_name,
      businessIndustry: icp.business_industry,
      businessWebsite: icp.business_website,
      businessDescription: icp.business_description,
      threadId: icp.thread_id,
      campaignName: icp.campaign_name,
      campaignObjective: icp.campaign_objective,
      targetAudience: icp.target_audience,
      summary: icp.summary,
      industry: icp.industry,
      subIndustry: icp.sub_industry,
      targetCompanySizeRange: icp.target_company_size_range,
      targetRevenueRange: icp.target_revenue_range,
      targetBusinessModel: icp.target_business_model,
      primaryRegions: icp.primary_regions,
      primaryJobTitles: icp.primary_job_titles,
      primaryChannels: icp.primary_channels,
      budgetRange: icp.budget_range,
      primaryValueProposition: icp.primary_value_proposition,
      primaryPainPoint: icp.primary_pain_point,
      fitScore: icp.fit_score || 0,
      userIntent: icp.user_intent,
      recommendedAgentScores: icp.recommended_agent_scores,
      status: icp.status,
      approved: icp.approved,
      approvedBy: icp.approved_by,
      approvedAt: icp.approved_at,
      revision: icp.revision,
      approvedRevision: icp.approved_revision,
      createdAt: icp.created_at,
      updatedAt: icp.updated_at,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error fetching ICP by thread ID');
    return res.status(500).json({ error: "Unable to retrieve the ICP for this thread. Please try again." });
  }
}

// Update ICP handler with fit score recalculation
export async function updateIcpHandler(req: Request, res: Response) {
  try {
    const icpId = parseInt(req.params.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const updateData = req.body;
    if (Array.isArray(updateData.primaryChannels)
      && updateData.primaryChannels.some((channel: unknown) => typeof channel === 'string' && channel.trim().toLowerCase() === 'yelp')) {
      return res.status(400).json({ error: 'Yelp lead generation is no longer available. Choose a supported channel.' });
    }

    if (isNaN(icpId)) {
      return res.status(400).json({ error: "Invalid ICP ID" });
    }

    // Verify ICP exists and user owns it
    const existingIcp = await getIcpDataById(icpId);
    if (!existingIcp) {
      return res.status(404).json({ error: "ICP not found" });
    }

    if (existingIcp.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Strip fields that should not be changed via the update endpoint
    const {
      id: _, uuid: _uuid, userId: _userId, threadId: _threadId, createdAt: _createdAt,
      approved: _approved, approvedBy: _approvedBy, approvedAt: _approvedAt,
      revision: _revision, approvedRevision: _approvedRevision,
      ...safeUpdateData
    } = updateData;

    // Merge existing ICP data with safeUpdateData before calculating fitScore
    const mergedData = {
      ...existingIcp,
      ...safeUpdateData
    };
    const fitScore = getIcpCompleteness(mergedData).score;
    
    // Update ICP with new fit score
    const updated = await updateIcpData(icpId, {
      ...safeUpdateData,
      fitScore,
      approved: false,
      approvedBy: null,
      approvedAt: null,
      approvedRevision: null,
      revision: existingIcp.revision + 1,
      updatedAt: new Date(),
    });

    if (!updated) {
      return res.status(500).json({ error: "Unable to update the ICP. Please try again." });
    }

    if (updated.threadId) {
      await markIcpRevisionAwaitingApproval({
        userId,
        threadId: updated.threadId,
        icpId: updated.id,
        revision: updated.revision,
        originalRequest: updated.campaignObjective || updated.targetAudience || undefined,
      });
    }

    return res.json({
      message: "ICP updated successfully",
      icp: updated,
      fitScore,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error updating ICP');
    return res.status(500).json({ error: "Unable to update the ICP. Please try again." });
  }
}

// Create ICP Profile handler
export async function createIcpProfileHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Authentication required" });
    const profileData = req.body;
    if (Array.isArray(profileData.primaryChannels)
      && profileData.primaryChannels.some((channel: unknown) => typeof channel === 'string' && channel.trim().toLowerCase() === 'yelp')) {
      return res.status(400).json({ error: 'Yelp lead generation is no longer available. Choose a supported channel.' });
    }

    const fitScore = getIcpCompleteness(profileData).score;

    // Create ICP profile
    const icp = await createIcpData({
      userId,
      businessId: profileData.businessId || null,
      threadId: profileData.threadId || null,
      campaignName: profileData.campaignName,
      campaignObjective: profileData.campaignObjective,
      targetAudience: profileData.targetAudience,
      industry: profileData.industry,
      subIndustry: profileData.subIndustry,
      targetCompanySizeRange: profileData.targetCompanySizeRange,
      targetRevenueRange: profileData.targetRevenueRange,
      targetBusinessModel: profileData.targetBusinessModel,
      primaryRegions: profileData.primaryRegions,
      primaryJobTitles: profileData.primaryJobTitles,
      primaryChannels: profileData.primaryChannels,
      budgetRange: profileData.budgetRange,
      primaryValueProposition: profileData.primaryValueProposition,
      primaryPainPoint: profileData.primaryPainPoint,
      summary: profileData.summary || null,
      fitScore,
      status: 'active',
    });

    // Save in-app notification
    NotificationService.icpGenerated(userId, icp.campaignName || 'Unnamed', fitScore);

    return res.status(201).json({
      message: "ICP profile created successfully",
      icp,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error creating ICP profile');
    return res.status(500).json({ error: "Unable to create the ICP profile. Please try again." });
  }
}
