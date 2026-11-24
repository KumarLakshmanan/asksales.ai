import { exportAdminLeads, parseAdminLeadFilters } from '../services/AdminLeadDirectoryService.js';
/**
 * Admin Management Controller
 * Thin wrappers around `adminUserService` user / overview / template
 * functions. The previous version of this file was 1284 lines of
 * drizzle select + try/catch boilerplate; see `adminUserService.ts`
 * for the data layer.
 */

import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { logger } from '../utils/logger.js';
import {
  getAllAdmins,
  getAdminById as getAdminByIdFn,
  createAdmin,
  updateAdmin,
  deleteAdmin,
} from '../models/admins/functions';
import {
  approveUser as approveUserSvc,
  changeAdminPassword as changeAdminPasswordSvc,
  createAdminCampaign as createAdminCampaignSvc,
  createAdminLead as createAdminLeadSvc,
  createNewUser as createNewUserSvc,
  createPredefinedTemplate as createPredefinedTemplateSvc,
  deleteAdminCampaign as deleteAdminCampaignSvc,
  deleteAdminLead as deleteAdminLeadSvc,
  deletePredefinedTemplate as deletePredefinedTemplateSvc,
  deleteUserById as deleteUserByIdSvc,
  getOutreachByChannel as getOutreachByChannelSvc,
  getOutreachConversationMessages as getOutreachConversationMessagesSvc,
  getUserAds as getUserAdsSvc,
  getUserBrandToolkits as getUserBrandToolkitsSvc,
  getUserCampaigns as getUserCampaignsSvc,
  getUserChatMessages as getUserChatMessagesSvc,
  getAdminChatMessages as getAdminChatMessagesSvc,
  getUserChats as getUserChatsSvc,
  getUserContent as getUserContentSvc,
  getUserDetail as getUserDetailSvc,
  getUserICPs as getUserICPsSvc,
  getUserKnowledgeBase as getUserKnowledgeBaseSvc,
  getUserLeads as getUserLeadsSvc,
  getUserOutreachConversations as getUserOutreachConversationsSvc,
  getUserStats as getUserStatsSvc,
  getUserTemplates as getUserTemplatesSvc,
  getContentStats as getContentStatsSvc,
  listAdminBrandToolkits as listAdminBrandToolkitsSvc,
  listAdminCampaigns as listAdminCampaignsSvc,
  listAdminContentCalendar as listAdminContentCalendarSvc,
  listAdminContentTemplates as listAdminContentTemplatesSvc,
  listAdminLeads as listAdminLeadsSvc,
  listAllAds as listAllAdsSvc,
  listAllBrandToolkits as listAllBrandToolkitsSvc,
  listAllContentAssets as listAllContentAssetsSvc,
  listAllContentTemplates as listAllContentTemplatesSvc,
  listAllOutreachConversations as listAllOutreachConversationsSvc,
  listAllUsers as listAllUsersSvc,
  listPredefinedTemplates as listPredefinedTemplatesSvc,
  rejectUser as rejectUserSvc,
  parseIntParam,
  runService,
  sanitizeUserRecord,
  setUserPassword as setUserPasswordSvc,
  setUserVerified as setUserVerifiedSvc,
  updateExistingUser as updateExistingUserSvc,
  updatePredefinedTemplate as updatePredefinedTemplateSvc,
} from '../services/adminUserService.js';

// ─── Admin management ─────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeAdmin<T extends Record<string, any>>(admin: T) {
  const {
    id, name, email, role, isVerified, avatar, phone, createdAt, updatedAt,
  } = admin;
  return { id, name, email, role, isVerified, avatar, phone, createdAt, updatedAt };
}

export async function getAdmins(req: Request, res: Response) {
  const { status, body } = await runService(async () => ({ admins: (await getAllAdmins()).map(sanitizeAdmin) }));
  return res.status(status).json(body);
}

export async function getUsers(req: Request, res: Response) {
  const { status, body } = await runService(async () => ({ users: await listAllUsersSvc() }));
  return res.status(status).json(body);
}

export async function getAdminByIdHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const id = parseIntParam(req.params.id, 'ID');
    const admin = await getAdminByIdFn(id);
    if (!admin) {
      const err = new Error('Admin not found') as Error & { status: number };
      err.status = 404;
      throw err;
    }
    return { admin: sanitizeAdmin(admin) };
  });
  return res.status(status).json(body);
}

export async function createAdminHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      const err = new Error('Email, name, password required') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    const hashed = await bcrypt.hash(password, 10);
    const admin = await createAdmin({ email, password: hashed, name, role: 'admin', isVerified: true });
    return { admin: sanitizeAdmin(admin) };
  });
  return res.status(status).json(body);
}

export async function updateAdminHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const id = parseIntParam(req.params.id, 'ID');
    const { name, email, role } = req.body;
    const existingAdmin = await getAdminByIdFn(id);
    if (!existingAdmin) {
      const err = new Error('Admin not found') as Error & { status: number };
      err.status = 404;
      throw err;
    }
    const admin = await updateAdmin(id, { name, email, role }, req.user?.id);
    if (!admin) {
      const err = new Error('Admin not found') as Error & { status: number };
      err.status = 404;
      throw err;
    }
    return { admin: sanitizeAdmin(admin) };
  });
  return res.status(status).json(body);
}

export async function deleteAdminHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const id = parseIntParam(req.params.id, 'ID');
    // Prevent self-deletion
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentAdmin = (req as any).user;
    if (currentAdmin && currentAdmin.id === id) {
      const err = new Error('Cannot delete your own admin account') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    const wasDeleted = await deleteAdmin(id, currentAdmin?.id);
    if (!wasDeleted) {
      const err = new Error('Admin not found') as Error & { status: number };
      err.status = 404;
      throw err;
    }
    return { message: 'Admin deleted' };
  });
  return res.status(status).json(body);
}

// ─── User CRUD ────────────────────────────────────────────────────────

export async function getUserHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const id = parseIntParam(req.params.id, 'ID');
    logger.info({ id }, '[admin:getUserHandler] Fetching user');
    const detail = await getUserDetailSvc(id);
    logger.info(
      {
        id,
        chatThreads: detail.chatHistory.length,
        campaigns: detail.campaigns.length,
        leads: detail.leads.length,
        icps: detail.icps.length,
        contentAssets: detail.contentAssets.length,
        brandToolkits: detail.brandToolkits.length,
        emailConversations: detail.emailConversations.length,
        contentTemplates: detail.contentTemplates.length,
        ads: detail.ads.length,
      },
      '[admin:getUserHandler] Responded',
    );
    return detail;
  });
  return res.status(status).json(body);
}

export async function createUserHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const user = await createNewUserSvc(req.body);
    return { user };
  }, { successStatus: 201 });
  return res.status(status).json(body);
}

export async function updateUserHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const id = parseIntParam(req.params.id, 'ID');
    const user = await updateExistingUserSvc(id, req.body);
    return { user };
  });
  return res.status(status).json(body);
}

export async function deleteUserHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const id = parseIntParam(req.params.id, 'ID');
    await deleteUserByIdSvc(id);
    return { message: 'User deleted' };
  });
  return res.status(status).json(body);
}

// ─── Chat ─────────────────────────────────────────────────────────────

export async function getChatMessagesHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const threadId = Number(req.params.threadId);
    logger.info({ threadId }, 'Fetching messages for thread');
    const messages = await getAdminChatMessagesSvc(threadId);
    logger.info({ count: messages.length }, 'Found messages');
    return { messages };
  });
  return res.status(status).json(body);
}

// ─── Global overviews ─────────────────────────────────────────────────

export async function getAllUserContentHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const { userId, type, limit = '50', offset = '0' } = req.query;
    return listAllContentAssetsSvc({
      userId: userId ? parseInt(userId as string) : undefined,
      type: type as string | undefined,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
  });
  return res.status(status).json(body);
}

export async function getAllBrandToolkitsHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const { userId, limit = '50', offset = '0' } = req.query;
    return listAllBrandToolkitsSvc({
      userId: userId ? parseInt(userId as string) : undefined,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
  });
  return res.status(status).json(body);
}

export async function getAllOutreachConversationsHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const { userId, channel, status: filterStatus, limit = '50', offset = '0' } = req.query;
    return listAllOutreachConversationsSvc({
      userId: userId ? parseInt(userId as string) : undefined,
      channel: channel as string | undefined,
      status: filterStatus as string | undefined,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
  });
  return res.status(status).json(body);
}

export async function getAllContentTemplatesHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const { userId, type, limit = '50', offset = '0' } = req.query;
    return listAllContentTemplatesSvc({
      userId: userId ? parseInt(userId as string) : undefined,
      type: type as string | undefined,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
  });
  return res.status(status).json(body);
}

export async function getAllAdsHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const { userId, status: filterStatus, platform, limit = '50', offset = '0' } = req.query;
    return listAllAdsSvc({
      userId: userId ? parseInt(userId as string) : undefined,
      status: filterStatus as string | undefined,
      platform: platform as string | undefined,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
  });
  return res.status(status).json(body);
}

export async function getContentStatsHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => getContentStatsSvc());
  return res.status(status).json(body);
}

// ─── User approval / verification ─────────────────────────────────────

export async function verifyUserHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const id = parseIntParam(req.params.id, 'ID');
    const user = await setUserVerifiedSvc(id);
    return { message: 'User verified successfully', user: sanitizeUserRecord(user) };
  });
  return res.status(status).json(body);
}

export async function approveUserHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const id = parseIntParam(req.params.id, 'ID');
    const user = await approveUserSvc(id);
    // Send approval email; failure is non-fatal
    try {
      const { sendApprovalConfirmationEmail } = await import('../utils/email');
      await sendApprovalConfirmationEmail(user.email, user.name);
    } catch (emailError) {
      logger.error({ err: emailError }, 'Failed to send approval email');
    }
    return { message: 'User approved successfully', user: sanitizeUserRecord(user) };
  });
  return res.status(status).json(body);
}

export async function rejectUserHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const id = parseIntParam(req.params.id, 'ID');
    const user = await rejectUserSvc(id);
    return { message: 'User approval revoked', user: sanitizeUserRecord(user) };
  });
  return res.status(status).json(body);
}

// ─── Per-user sub-resource handlers ───────────────────────────────────

export async function getAdminLeadsHandler(req: Request, res: Response) {
  let filters;
  try { filters = parseAdminLeadFilters(req.query); } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid lead filters' }); }
  const { status, body } = await runService(async () => {
    return listAdminLeadsSvc(filters);
  });
  return res.status(status).json(body);
}

export async function exportAdminLeadsHandler(req: Request, res: Response) {
  try {
    const filters = parseAdminLeadFilters(req.query);
    res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    await exportAdminLeads(filters, async chunk => {
      if (res.destroyed) throw new Error('Export connection closed');
      await new Promise<void>((resolve, reject) => {
        const closed = () => reject(new Error('Export connection closed'));
        res.once('close', closed);
        res.write(chunk, error => { res.off('close', closed); if (error) reject(error); else resolve(); });
      });
    });
    res.end();
  } catch (error) {
    if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return; }
    res.type('application/json').status((error as { status?: number }).status || 500).json({ error: error instanceof Error ? error.message : 'Lead export failed' });
  }
}

export async function getUserCampaignsHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = Number(req.params.id);
    const result = await getUserCampaignsSvc(userId);
    return {
      campaigns: result.marketingCampaigns,
      outreachCampaigns: result.outreachCampaigns,
      total: result.total,
    };
  });
  return res.status(status).json(body);
}

export async function getUserStatsHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = parseIntParam(req.params.id, 'ID');
    return { stats: await getUserStatsSvc(userId) };
  });
  return res.status(status).json(body);
}

export async function getAdminCampaignsHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => ({ campaigns: await listAdminCampaignsSvc() }));
  return res.status(status).json(body);
}

export async function getUserChatsHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = parseIntParam(req.params.id, 'ID');
    return { threads: await getUserChatsSvc(userId) };
  });
  return res.status(status).json(body);
}

export async function getUserChatMessagesHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = Number(req.params.id);
    const threadId = Number(req.params.threadId);
    return { messages: await getUserChatMessagesSvc(userId, threadId) };
  });
  return res.status(status).json(body);
}

export async function getUserLeadsHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = parseIntParam(req.params.id, 'ID');
    return { leads: await getUserLeadsSvc(userId) };
  });
  return res.status(status).json(body);
}

export async function getUserICPsHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = parseIntParam(req.params.id, 'ID');
    return { icps: await getUserICPsSvc(userId) };
  });
  return res.status(status).json(body);
}

export async function getUserContentHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = parseIntParam(req.params.id, 'ID');
    return { content: await getUserContentSvc(userId) };
  });
  return res.status(status).json(body);
}

export async function getUserKnowledgeBaseHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = parseIntParam(req.params.id, 'ID');
    return { success: true, entries: await getUserKnowledgeBaseSvc(userId) };
  });
  return res.status(status).json(body);
}

export async function getUserBrandToolkitsHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = parseIntParam(req.params.id, 'ID');
    return { toolkits: await getUserBrandToolkitsSvc(userId) };
  });
  return res.status(status).json(body);
}

export async function getUserTemplatesHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = parseIntParam(req.params.id, 'ID');
    return { templates: await getUserTemplatesSvc(userId) };
  });
  return res.status(status).json(body);
}

export async function getUserAdsHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = parseIntParam(req.params.id, 'ID');
    return { ads: await getUserAdsSvc(userId) };
  });
  return res.status(status).json(body);
}

export async function getUserOutreachHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const userId = Number(req.params.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      const err = new Error('Invalid user ID') as Error & { status: number };
      err.status = 400;
      throw err;
    }

    const channel = req.params.channel?.trim().toLowerCase();
    if (channel && !['email', 'gmail', 'instagram', 'linkedin', 'sms', 'whatsapp'].includes(channel)) {
      const err = new Error('Unsupported outreach channel') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    return { conversations: await getUserOutreachConversationsSvc(userId, channel) };
  });
  return res.status(status).json(body);
}

// ─── Password management ──────────────────────────────────────────────

export async function updateUserPasswordHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    if (req.user?.role !== 'super_admin') {
      throw Object.assign(new Error('Super admin access required'), { status: 403 });
    }
    const id = parseIntParam(req.params.id, 'ID');
    const { newPassword } = req.body;
    await setUserPasswordSvc(id, newPassword);
    return { message: 'Password updated successfully' };
  });
  return res.status(status).json(body);
}

export async function changeAdminPasswordHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = (req as any).user as { id: number };
    const { currentPassword, newPassword } = req.body;
    await changeAdminPasswordSvc(admin.id, currentPassword, newPassword);
    return { message: 'Password changed successfully' };
  });
  return res.status(status).json(body);
}

// ─── Admin CRUD on campaigns / leads ──────────────────────────────────

export async function deleteAdminCampaignHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const id = Number(req.params.id);
    await deleteAdminCampaignSvc(id);
    return { message: 'Campaign archived successfully' };
  });
  return res.status(status).json(body);
}

export async function createAdminCampaignHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const campaign = await createAdminCampaignSvc(req.body);
    return { campaign };
  }, { successStatus: 201 });
  return res.status(status).json(body);
}

export async function deleteAdminLeadHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const id = parseIntParam(req.params.id, 'ID');
    await deleteAdminLeadSvc(id);
    return { message: 'Lead deleted successfully' };
  });
  return res.status(status).json(body);
}

export async function createAdminLeadHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const lead = await createAdminLeadSvc(req.body);
    return { lead };
  }, { successStatus: 201 });
  return res.status(status).json(body);
}

// ─── Admin-level overviews ────────────────────────────────────────────

export async function getAdminContentTemplatesHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => ({ templates: await listAdminContentTemplatesSvc() }));
  return res.status(status).json(body);
}

export async function getAdminBrandToolkitsHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => ({ toolkits: await listAdminBrandToolkitsSvc() }));
  return res.status(status).json(body);
}

export async function getAdminContentCalendarHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => ({ events: await listAdminContentCalendarSvc() }));
  return res.status(status).json(body);
}

export async function getAdminOutreachByChannelHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const channel = req.params.channel;
    return { conversations: await getOutreachByChannelSvc(channel) };
  });
  return res.status(status).json(body);
}

export async function getAdminOutreachConversationMessagesHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const conversationId = parseInt(req.params.conversationId);
    if (Number.isNaN(conversationId)) {
      const err = new Error('Invalid conversation ID') as Error & { status: number };
      err.status = 400;
      throw err;
    }
    const data = await getOutreachConversationMessagesSvc(conversationId);
    if (!data) {
      const err = new Error('Conversation not found') as Error & { status: number };
      err.status = 404;
      throw err;
    }
    return data;
  });
  return res.status(status).json(body);
}

// ─── Predefined templates ─────────────────────────────────────────────

export async function createPredefinedTemplateHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const { name, type, content, subject, htmlContent, description, variables, category, tags } = req.body;
    const template = await createPredefinedTemplateSvc({
      name, type, content, subject, htmlContent, description, variables, category, tags,
    });
    return { template };
  }, { successStatus: 201 });
  return res.status(status).json(body);
}

export async function updatePredefinedTemplateHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const templateId = parseInt(req.params.id, 10);
    const { name, type, content, subject, htmlContent, description, variables, category, tags } = req.body;
    return updatePredefinedTemplateSvc(templateId, {
      name, type, content, subject, htmlContent, description, variables, category, tags,
    });
  });
  return res.status(status).json(body);
}

export async function deletePredefinedTemplateHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const templateId = parseInt(req.params.id, 10);
    await deletePredefinedTemplateSvc(templateId);
    return { success: true, message: 'Template deleted successfully' };
  });
  return res.status(status).json(body);
}

export async function getPredefinedTemplatesHandler(req: Request, res: Response) {
  const { status, body } = await runService(async () => {
    const { type } = req.query;
    return listPredefinedTemplatesSvc(type as string | undefined);
  });
  return res.status(status).json(body);
}
