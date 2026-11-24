import { setupRequestKey,setupRequestHash } from '../utils/setupIdempotency.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { cleanupDeletedProfileAssets } from '../services/businessProfileAssetCleanup.js';
import { stageBusinessProfileDeletion } from '../services/businessProfileDeletion.js';
import { BillingOrganizationError } from '../services/billing/organizations.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { Request, Response } from 'express';
import { db } from '../models/db';
import { companySettings } from '../models/companySettings/schema';
import { businessProfileCategoriesTable, businessProfileSubcategoriesTable } from '../models/businessProfileCategories/schema';
import { eq, and, asc, sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { accessibleBusinessProfiles, BusinessProfileAccessError, setBusinessPreference } from '../services/businessProfileStaff.js';
import { workspaceOnboardingFields } from '../utils/workspaceOnboarding.js';

// Get all active business categories (for setup page category selection)
export const getActiveBusinessCategories = async (_req: Request, res: Response) => {
  try {
    const categories = await db
      .select()
      .from(businessProfileCategoriesTable)
      .where(eq(businessProfileCategoriesTable.isActive, true))
      .orderBy(asc(businessProfileCategoriesTable.sortOrder), asc(businessProfileCategoriesTable.name));

    const categoriesWithSubs = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      categories.map(async (cat: any) => {
        const subcategories = await db
          .select()
          .from(businessProfileSubcategoriesTable)
          .where(and(
            eq(businessProfileSubcategoriesTable.categoryId, cat.id),
            eq(businessProfileSubcategoriesTable.isActive, true),
          ))
          .orderBy(asc(businessProfileSubcategoriesTable.sortOrder), asc(businessProfileSubcategoriesTable.name));
        return { ...cat, subcategories };
      })
    );

    return res.json({ success: true, data: categoriesWithSubs });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[getActiveBusinessCategories] Failed');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
};

// Get all business profiles for a user
export const getBusinessProfiles = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const profiles = await accessibleBusinessProfiles(Number(userId), undefined, req.query.includeArchived === '1');
    return res.json(profiles);
  } catch (error) {
    logger.error({ err: error }, 'Failed to get business profiles');
    return res.status(500).json({ error: 'Unable to retrieve your business profiles. Please try again.' });
  }
};

// Get a single business profile
export const getBusinessProfile = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id;
    const profileId = parseInt(req.params.id);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const [profile] = await accessibleBusinessProfiles(Number(userId),profileId,true);

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    return res.json(profile);
  } catch (error) {
    logger.error({ err: error }, 'Failed to get business profile');
    return res.status(500).json({ error: 'Unable to retrieve the business profile. Please try again.' });
  }
};

// Helper function to provide default values for empty strings
const sanitizeInput = (value: string | null | undefined, defaultValue: string): string => {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  return String(value);
};

// Create a new business profile
export const createBusinessProfile = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Ensure userId is a number
    userId = typeof userId === 'string' ? parseInt(userId, 10) : userId;
    if (isNaN(userId)) {
      return res.status(401).json({ error: 'Invalid user ID' });
    }

    const {
      name,
      profileType,
      companyName,
      industry,
      subIndustry,
      companySize,
      annualRevenue,
      ownerName,
      businessName,
      businessCategory,
      establishedYear,
      website,
      phone,
      email,
      description,
      businessHours,
      targetMarket,
      valueProposition,
      address,
      city,
      state,
      country,
      postalCode,
      linkedinUrl,
      twitterUrl,
      facebookUrl,
      instagramUrl,
      youtubeUrl,
      isDefault: rawIsDefault,
      // Additional fields
      platforms,
      contentFormats,
      visualStyle,
      referenceAccounts,
      businessGoals,
      targetRegions,
      customerType,
      keyBuyerRoles,
      preferredChannels,
      brandTone,
      approvalMode,
      restrictions,
      categoryId,
      subcategoryId,
    } = req.body;

    let onboardingFields;
    try { onboardingFields = workspaceOnboardingFields(req.body); }
    catch (error) { return res.status(400).json({ error: (error as Error).message }); }

    // Apply default values for empty/missing fields
    const profileName = sanitizeInput(name || companyName || businessName, 'Untitled Profile');
    const profileIndustry = sanitizeInput(industry, '');
    const profileSubIndustry = sanitizeInput(subIndustry, '');
    const profileCompanySize = sanitizeInput(companySize, '');
    const profileAnnualRevenue = sanitizeInput(annualRevenue, '');
    const profileOwnerName = sanitizeInput(ownerName, sanitizeInput(businessName, ''));
    const profileBusinessName = sanitizeInput(businessName, sanitizeInput(companyName, ''));
    const profileBusinessCategory = sanitizeInput(businessCategory, '');
    const profileEstablishedYear = sanitizeInput(establishedYear, '');
    const profileWebsite = sanitizeInput(website, '');
    const profilePhone = sanitizeInput(phone, '');
    const profileEmail = sanitizeInput(email, '');
    const profileDescription = sanitizeInput(description, '');
    const profileBusinessHours = sanitizeInput(businessHours, '');
    const profileTargetMarket = sanitizeInput(targetMarket, '');
    const profileValueProposition = sanitizeInput(valueProposition, '');
    const profileAddress = sanitizeInput(address, '');
    const profileCity = sanitizeInput(city, '');
    const profileState = sanitizeInput(state, '');
    const profileCountry = sanitizeInput(country, '');
    const profilePostalCode = sanitizeInput(postalCode, '');
    
    // Create profile object with all fields  
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profileData: any = {
      ...onboardingFields,
      userId: Number(userId),
      name: profileName,
      profileType: profileType || null,
      companyName: companyName || null,
      industry: profileIndustry,
      subIndustry: profileSubIndustry,
      companySize: profileCompanySize,
      annualRevenue: profileAnnualRevenue,
      ownerName: profileOwnerName,
      businessName: profileBusinessName,
      businessCategory: profileBusinessCategory,
      establishedYear: profileEstablishedYear,
      website: profileWebsite,
      phone: profilePhone,
      email: profileEmail,
      description: profileDescription,
      businessHours: profileBusinessHours,
      targetMarket: profileTargetMarket,
      valueProposition: profileValueProposition,
      address: profileAddress,
      city: profileCity,
      state: profileState,
      country: profileCountry,
      postalCode: profilePostalCode,
      linkedinUrl: linkedinUrl || null,
      twitterUrl: twitterUrl || null,
      facebookUrl: facebookUrl || null,
      instagramUrl: instagramUrl || null,
      youtubeUrl: youtubeUrl || null,
      // Additional fields
      platforms: platforms ? JSON.stringify(platforms) : null,
      contentFormats: contentFormats ? JSON.stringify(contentFormats) : null,
      visualStyle: visualStyle || null,
      referenceAccounts: referenceAccounts || null,
      businessGoals: businessGoals ? JSON.stringify(businessGoals) : null,
      targetRegions: targetRegions ? JSON.stringify(targetRegions) : null,
      customerType: customerType || null,
      keyBuyerRoles: keyBuyerRoles ? JSON.stringify(keyBuyerRoles) : null,
      preferredChannels: preferredChannels ? JSON.stringify(preferredChannels) : null,
      brandTone: brandTone || null,
      approvalMode: approvalMode || null,
      restrictions: restrictions || null,
      isApproved: true,
      approvedBy: Number(userId),
      approvedAt: new Date(),
      version: 1,
      categoryId: categoryId ? Number(categoryId) : null,
      subcategoryId: subcategoryId ? Number(subcategoryId) : null,
    };
    let requestKey;
    try {requestKey=setupRequestKey(req.body.idempotencyKey);} catch(error){return res.status(400).json({error:(error as Error).message});}
    if(requestKey) {profileData.creationRequestKey=requestKey;profileData.creationRequestHash=setupRequestHash(req.body);}
    const requestedDefault = rawIsDefault === true || rawIsDefault === 'true' || rawIsDefault === 1 || rawIsDefault === '1';
    const profile = await db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${Number(userId)})`);
      if(requestKey) {
        const [previous]=await tx.select().from(companySettings).where(and(eq(companySettings.userId,Number(userId)),eq(companySettings.creationRequestKey,requestKey))).limit(1);
        if(previous) {
          if(previous.creationRequestHash!==profileData.creationRequestHash) throw Object.assign(new Error('This request key was already used for different workspace details.'),{code:'SETUP_REQUEST_CONFLICT'});
          return previous;
        }
      }
      const existingProfiles = await tx
        .select({ id: companySettings.id })
        .from(companySettings)
        .where(eq(companySettings.userId, Number(userId)));
      const shouldBeDefault = existingProfiles.length === 0 || requestedDefault;
      if (shouldBeDefault && existingProfiles.length > 0) {
        await tx.update(companySettings).set({ isDefault: false }).where(eq(companySettings.userId, Number(userId)));
      }
      const [created] = await tx
        .insert(companySettings)
        .values({ ...profileData, isDefault: shouldBeDefault })
        .returning();

      if (shouldBeDefault) await tx.execute(sql`INSERT INTO business_profile_preferences(user_id,default_business_profile_id)
        VALUES(${Number(userId)},${created.id}) ON CONFLICT(user_id) DO UPDATE SET default_business_profile_id=EXCLUDED.default_business_profile_id`);

      return created;
    });

    return res.status(201).json(profile);
  } catch (error) {
    if ((error as {code?:string}).code === 'SETUP_REQUEST_CONFLICT') return res.status(409).json({error:(error as Error).message});
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, '[createBusinessProfile] Error');
    return res.status(500).json({ error: 'Unable to create the business profile. Please try again.' });
  }
};

// Update a business profile
export const updateBusinessProfile = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id;
    const profileId = parseInt(req.params.id);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return await db.transaction(async (tx:typeof db)=> {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${Number(userId)})`);
    const {
      name,
      profileType,
      companyName,
      industry,
      subIndustry,
      companySize,
      annualRevenue,
      ownerName,
      businessName,
      businessCategory,
      establishedYear,
      website,
      phone,
      email,
      description,
      businessHours,
      targetMarket,
      valueProposition,
      address,
      city,
      state,
      country,
      postalCode,
      linkedinUrl,
      twitterUrl,
      facebookUrl,
      instagramUrl,
      youtubeUrl,
      isDefault: rawIsDefault,
      // Additional fields
      platforms,
      contentFormats,
      visualStyle,
      referenceAccounts,
      businessGoals,
      targetRegions,
      customerType,
      keyBuyerRoles,
      preferredChannels,
      brandTone,
      approvalMode,
      restrictions,
      categoryId,
      subcategoryId,
    } = req.body;

    // Verify ownership
    const [existing] = await tx.select().from(companySettings).where(
      and(eq(companySettings.id, profileId), eq(companySettings.userId, userId))
    );

    if (!existing) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const expectedVersion = req.body.expectedVersion ?? req.body.version;
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) return res.status(400).json({ error: 'Invalid profile version.' });
    if (expectedVersion !== undefined && expectedVersion !== existing.version) return res.status(409).json({ code: 'PROFILE_VERSION_CONFLICT', error: 'This profile changed in another tab. Reload it before saving.', profile: existing });

    let onboardingFields;
    try { onboardingFields = workspaceOnboardingFields(req.body); }
    catch (error) { return res.status(400).json({ error: (error as Error).message }); }

    // Convert isDefault to boolean safely
    const isDefaultBoolean = rawIsDefault === true || rawIsDefault === 'true' || rawIsDefault === 1 || rawIsDefault === '1';

    // If this is marked as default, unset all other defaults for this user
    if (isDefaultBoolean) {
      await tx.execute(sql`INSERT INTO business_profile_preferences(user_id,default_business_profile_id) VALUES(${Number(userId)},${profileId}) ON CONFLICT(user_id) DO UPDATE SET default_business_profile_id=EXCLUDED.default_business_profile_id`);
      await tx.update(companySettings).set({ isDefault: false }).where(eq(companySettings.userId, userId));
    }

    // Apply default values for empty/missing fields
    const profileName = sanitizeInput(name || companyName || businessName, existing.name || 'Untitled Profile');
    const profileIndustry = sanitizeInput(industry, existing.industry || '');
    const profileSubIndustry = sanitizeInput(subIndustry, existing.subIndustry || '');
    const profileCompanySize = sanitizeInput(companySize, existing.companySize || '');
    const profileAnnualRevenue = sanitizeInput(annualRevenue, existing.annualRevenue || '');
    const profileOwnerName = sanitizeInput(ownerName, existing.ownerName || businessName || '');
    const profileBusinessName = sanitizeInput(businessName, existing.businessName || companyName || '');
    const profileBusinessCategory = sanitizeInput(businessCategory, existing.businessCategory || '');
    const profileEstablishedYear = sanitizeInput(establishedYear, existing.establishedYear || '');
    const profileWebsite = sanitizeInput(website, existing.website || '');
    const profilePhone = sanitizeInput(phone, existing.phone || '');
    const profileEmail = sanitizeInput(email, existing.email || '');
    const profileDescription = sanitizeInput(description, existing.description || '');
    const profileBusinessHours = sanitizeInput(businessHours, existing.businessHours || '');
    const profileTargetMarket = sanitizeInput(targetMarket, existing.targetMarket || '');
    const profileValueProposition = sanitizeInput(valueProposition, existing.valueProposition || '');
    const profileAddress = sanitizeInput(address, existing.address || '');
    const profileCity = sanitizeInput(city, existing.city || '');
    const profileState = sanitizeInput(state, existing.state || '');
    const profileCountry = sanitizeInput(country, existing.country || '');
    const profilePostalCode = sanitizeInput(postalCode, existing.postalCode || '');

    const [profile] = await tx.update(companySettings).set({
      ...onboardingFields,
      name: profileName,
      profileType: profileType !== undefined ? profileType : existing.profileType,
      companyName: sanitizeInput(companyName, existing.companyName || profileBusinessName),
      industry: profileIndustry,
      subIndustry: profileSubIndustry,
      companySize: profileCompanySize,
      annualRevenue: profileAnnualRevenue,
      ownerName: profileOwnerName,
      businessName: profileBusinessName,
      businessCategory: profileBusinessCategory,
      establishedYear: profileEstablishedYear,
      website: profileWebsite,
      phone: profilePhone,
      email: profileEmail,
      description: profileDescription,
      businessHours: profileBusinessHours,
      targetMarket: profileTargetMarket,
      valueProposition: profileValueProposition,
      address: profileAddress,
      city: profileCity,
      state: profileState,
      country: profileCountry,
      postalCode: profilePostalCode,
      linkedinUrl: linkedinUrl !== undefined ? linkedinUrl || null : existing.linkedinUrl,
      twitterUrl: twitterUrl !== undefined ? twitterUrl || null : existing.twitterUrl,
      facebookUrl: facebookUrl !== undefined ? facebookUrl || null : existing.facebookUrl,
      instagramUrl: instagramUrl !== undefined ? instagramUrl || null : existing.instagramUrl,
      youtubeUrl: youtubeUrl !== undefined ? youtubeUrl || null : existing.youtubeUrl,
      // Additional fields
      platforms: platforms !== undefined ? JSON.stringify(platforms || []) : existing.platforms,
      contentFormats: contentFormats !== undefined ? JSON.stringify(contentFormats || []) : existing.contentFormats,
      visualStyle: visualStyle !== undefined ? visualStyle || null : existing.visualStyle,
      referenceAccounts: referenceAccounts !== undefined ? referenceAccounts || null : existing.referenceAccounts,
      businessGoals: businessGoals !== undefined ? JSON.stringify(businessGoals || []) : existing.businessGoals,
      targetRegions: targetRegions !== undefined ? JSON.stringify(targetRegions || []) : existing.targetRegions,
      customerType: customerType !== undefined ? customerType || null : existing.customerType,
      keyBuyerRoles: keyBuyerRoles !== undefined ? JSON.stringify(keyBuyerRoles || []) : existing.keyBuyerRoles,
      preferredChannels: preferredChannels !== undefined ? JSON.stringify(preferredChannels || []) : existing.preferredChannels,
      brandTone: brandTone !== undefined ? brandTone || null : existing.brandTone,
      approvalMode: approvalMode !== undefined ? approvalMode || null : existing.approvalMode,
      restrictions: restrictions !== undefined ? restrictions || null : existing.restrictions,
      categoryId: categoryId !== undefined ? (categoryId ? Number(categoryId) : null) : existing.categoryId,
      subcategoryId: subcategoryId !== undefined ? (subcategoryId ? Number(subcategoryId) : null) : existing.subcategoryId,
      isDefault: isDefaultBoolean || existing.isDefault,
      isApproved: true,
      approvedBy: Number(userId),
      approvedAt: new Date(),
      version: existing.version + 1,
      updatedAt: new Date(),
    }).where(
      and(eq(companySettings.id, profileId), eq(companySettings.userId, userId), eq(companySettings.version, existing.version))
    ).returning();

    if (!profile) return res.status(409).json({ code: 'PROFILE_VERSION_CONFLICT', error: 'This profile changed while you were saving. Reload it and retry.' });
    return res.json(profile);
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update business profile');
    return res.status(500).json({ error: 'Unable to update the business profile. Please try again.' });
  }
};

// Delete a business profile and its disposable setup configuration.
export const deleteBusinessProfile = async (req: Request, res: Response) => {
  try {
    const userId = Number(req.user?.id);
    const profileId = Number(req.params.id);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!Number.isSafeInteger(profileId) || profileId < 1)
      return res.status(400).json({ error: 'Invalid business profile' });

    const [existing] = await db.select().from(companySettings).where(
      and(eq(companySettings.id, profileId), eq(companySettings.userId, userId))
    );
    if (!existing) return res.status(404).json({ error: 'Profile not found' });

    const cleanupReceiptIds = await stageBusinessProfileDeletion(userId, profileId, existing.billingOrganizationId);

    // Provider cleanup cannot undo a committed delete. The standalone storage
    // cron retries durable receipts even after the final business is removed.
    try { await cleanupDeletedProfileAssets(userId, cleanupReceiptIds); }
    catch (error) { logger.warn({ err: error, profileId }, 'Deleted profile assets remain queued for cleanup'); }
    return res.json({ success: true });
  } catch (error) {
    if (error instanceof BusinessProfileAccessError || error instanceof BillingOrganizationError) return res.status(error.status).json({error:error.message,code:error.code});
    let cause = error as { code?: string; message?: string; cause?: unknown } | undefined;
    for (let depth = 0; cause && depth < 5; depth++, cause = cause.cause as typeof cause) {
      // PostgreSQL can report ON DELETE RESTRICT as restrict_violation rather
      // than foreign_key_violation. Both mean the workspace's records remain.
      if (cause.code === '23503' || cause.code === '23001' || (cause.code === '23514' && cause.message === 'Managed storage revision still has durable references')) return res.status(409).json({ code: 'BUSINESS_PROFILE_HAS_RECORDS', error: 'This business still contains campaigns, content, files, or customer records. Archive it to keep that data.' });
    }
    logger.error({ err: error }, 'Failed to delete business profile');
    return res.status(500).json({ error: 'Unable to delete the business profile. Please try again.' });
  }
};

// Set a business profile as default
export const setDefaultBusinessProfile = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id;
    const profileId = parseInt(req.params.id);

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const profile = await setBusinessPreference(Number(userId),profileId);

    return res.json(profile);
  } catch (error) {
    if(error instanceof BusinessProfileAccessError) return res.status(error.status).json({error:error.message,code:error.code});
    logger.error({ err: error }, 'Failed to set default business profile');
    return res.status(500).json({ error: 'Unable to set the default business profile. Please try again.' });
  }
};

/** Archiving preserves business records and removes the workspace from active selectors. */
export const archiveBusinessProfile = async(req:Request,res:Response) => {
  const userId=Number(req.user?.id),profileId=Number(req.params.id),expectedVersion=req.body?.expectedVersion;
  if(!userId)return res.status(401).json({error:'Unauthorized'});
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)return res.status(400).json({error:'Supply the current profile version.'});
  try {
    const result=await withBusinessScope({userId,businessProfileId:profileId},()=>db.transaction(async(tx:typeof db)=>{
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${userId})`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(740322,${profileId})`);
      const existing=await tx.execute(sql`SELECT * FROM company_settings WHERE id=${profileId} AND user_id=${userId} FOR UPDATE`);
      if(!existing.rows[0])return {status:404,error:'Profile not found'};
      if(existing.rows[0].version!==expectedVersion)return {status:409,error:'This profile changed. Reload it and retry.'};
      const restore=req.path.endsWith('/restore');
      if(!restore && !existing.rows[0].archived_at) {
        const remainingActive=await tx.execute(sql`SELECT id FROM company_settings WHERE user_id=${userId} AND archived_at IS NULL AND id<>${profileId} LIMIT 1`);
        if(!remainingActive.rows[0])return {status:409,error:'Keep at least one active workspace. Create another workspace before archiving this one.'};
      }
      await tx.execute(sql`UPDATE company_settings SET archived_at=${restore?sql`NULL`:sql`now()`},is_default=false,version=version+1,updated_at=now() WHERE id=${profileId} AND user_id=${userId}`);
      if(!restore) await tx.execute(sql`UPDATE workspace_website_analysis_jobs SET status='cancelled',stage='cancelled',detail='Workspace archived',updated_at=now()
        WHERE business_profile_id=${profileId} AND user_id=${userId} AND status IN('queued','running')`);
      const remaining=await tx.execute(sql`SELECT id FROM company_settings WHERE user_id=${userId} AND archived_at IS NULL ORDER BY is_default DESC,id LIMIT 1`);
      const defaultId=remaining.rows[0]?.id ?? null;
      if(defaultId) await tx.execute(sql`UPDATE company_settings SET is_default=(id=${defaultId}) WHERE user_id=${userId}`);
      await tx.execute(sql`UPDATE business_profile_preferences SET default_business_profile_id=${defaultId} WHERE user_id=${userId}
        AND (default_business_profile_id=${profileId} OR default_business_profile_id IS NULL)`);
      return {status:200};
    }));
    if(result.status!==200)return res.status(result.status).json({error:result.error});
    const [profile]=await accessibleBusinessProfiles(userId,profileId,true);
    logger.info({userId,businessProfileId:profileId,event:req.path.endsWith('/restore')?'workspace_restored':'workspace_archived'},'Workspace archive status updated');
    return res.json(profile);
  } catch(error) {logger.error({err:error},'Unable to update workspace archive status');return res.status(500).json({error:'Unable to update workspace archive status. Please retry.'});}
};
