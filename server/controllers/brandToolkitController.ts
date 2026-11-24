import { optimizeBrandImage } from '../utils/brandImageOptimization.js';
import { setupRequestKey,setupRequestHash } from '../utils/setupIdempotency.js';
import { businessOwnerUserId, requireBusinessScope } from '../tenancy/businessContext.js';
import { brandImageFields } from '../utils/workspaceOnboarding.js';
import { Request, Response } from "express";
import { logger } from '../utils/logger.js';
import { 
  BrandToolkitModel, 
  userHasBrandToolkits 
} from "../models/brandToolkits/functions";
import { InsertBrandToolkit } from "../models/brandToolkits/schema";
import multer from "multer";
import { StorageService } from '../services/StorageService.js';
import { parseDigitsId as parseToolkitId } from '../utils/paramParsers.js';

// Configure multer with memory storage (files go to S3/MinIO via StorageService)
const logoFileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only PNG, JPG, and WebP are allowed.'));
  }
};

export const uploadLogoMiddleware = multer({
  storage: multer.memoryStorage(),
  fileFilter: logoFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
}).single('logo');

export const uploadBrandImageMiddleware = multer({
  storage: multer.memoryStorage(), fileFilter: logoFileFilter, limits: { fileSize: 5 * 1024 * 1024 },
}).single('image');

function hasValidLogoSignature(file: Express.Multer.File): boolean {
  const bytes = file.buffer;
  if (bytes.length < 12) return false;
  if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (file.mimetype === 'image/png') {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (file.mimetype === 'image/webp') {
    return bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}



/**
 * GET /api/brand-toolkits
 * Get all brand toolkits for the authenticated user
 */
export const getBrandToolkits = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const toolkits = await BrandToolkitModel.findAllByUser(userId);
    res.json(toolkits);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[BrandToolkitController] Error fetching toolkits');
    res.status(500).json({ error: "Unable to retrieve brand toolkits. Please try again." });
  }
};

/**
 * GET /api/brand-toolkits/:id
 * Get a specific brand toolkit by ID
 */
export const getBrandToolkit = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const id = parseToolkitId(req.params.id);
    
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!id) return res.status(400).json({ error: "Invalid brand toolkit ID" });

    const toolkit = await BrandToolkitModel.findByIdAndUser(id, userId);
    if (!toolkit) {
      return res.status(404).json({ error: "Brand toolkit not found" });
    }

    res.json(toolkit);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[BrandToolkitController] Error fetching toolkit');
    res.status(500).json({ error: "Unable to retrieve the brand toolkit. Please try again." });
  }
};

/**
 * GET /api/brand-toolkits/default
 * Get the default brand toolkit for the user
 */
export const getDefaultBrandToolkit = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const toolkit = await BrandToolkitModel.findDefault(userId);
    if (!toolkit) {
      return res.json({ hasDefault: false, toolkit: null });
    }

    res.json({ hasDefault: true, toolkit });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[BrandToolkitController] Error fetching default toolkit');
    res.status(500).json({ error: "Unable to retrieve the default brand toolkit. Please try again." });
  }
};

/**
 * GET /api/brand-toolkits/check
 * Check if user has any brand toolkits
 */
export const checkBrandToolkits = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const hasToolkits = await userHasBrandToolkits(userId);
    res.json({ hasToolkits });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[BrandToolkitController] Error checking toolkits');
    res.status(500).json({ error: "Unable to check brand toolkits. Please try again." });
  }
};

/**
 * POST /api/brand-toolkits
 * Create a new brand toolkit
 */
export const createBrandToolkit = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    let imageFields;
    try { imageFields = brandImageFields(req.body); }
    catch (error) { return res.status(400).json({ error: (error as Error).message }); }

    let requestKey;
    try {requestKey=setupRequestKey(req.body.idempotencyKey);} catch(error){return res.status(400).json({error:(error as Error).message});}
    const toolkitData: InsertBrandToolkit = {
      ...(requestKey ? {creationRequestKey:requestKey,creationRequestHash:setupRequestHash(req.body)} : {}),
      ...imageFields,
      userId,
      name: req.body.name || req.body.brandName || "My Brand",
      description: req.body.description,
      tagline: req.body.tagline,
      missionStatement: req.body.missionStatement,
      brandValues: req.body.brandValues || [],
      brandKeywords: req.body.brandKeywords || [],
      
      // Visual Identity
      logoUrl: req.body.logoUrl,
      logoUrls: req.body.logoUrls || [],
      logoFileName: req.body.logoFileName,
      logoVisibility: req.body.logoVisibility ?? true,
      primaryBrandColor: req.body.primaryBrandColor || req.body.primaryColors?.[0],
      secondaryBrandColor: req.body.secondaryBrandColor || req.body.secondaryColors?.[0],
      accentColor: req.body.accentColor,
      primaryColors: req.body.primaryColors || [],
      secondaryColors: req.body.secondaryColors || [],
      additionalColors: req.body.additionalColors || [],
      fontFamily: req.body.fontFamily || req.body.fonts?.body,
      fonts: req.body.fonts,
      fontFamilies: req.body.fontFamilies,
      gradients: req.body.gradients,
      imageStyleReference: req.body.imageStyleReference,
      visualInstructions: req.body.visualInstructions,
      logoUsageGuidelines: req.body.logoUsageGuidelines,
      
      // Voice & Tone
      voiceType: req.body.voiceType,
      customToneGuidelines: req.body.customToneGuidelines,
      voicePersonalityTraits: req.body.voicePersonalityTraits || [],
      voiceDos: req.body.voiceDos || [],
      voiceDonts: req.body.voiceDonts || [],
      voiceKeywords: req.body.voiceKeywords || [],
      
      // Content Settings
      defaultCtas: req.body.defaultCtas || req.body.ctas || [],
      defaultHashtags: req.body.defaultHashtags || req.body.hashtags || [],
      sampleContent: req.body.sampleContent,
      contentPillars: req.body.contentPillars || [],
      contentFormats: req.body.contentFormats || [],
      contentInstructions: req.body.contentInstructions,
      
      // Audience Settings
      audiencePainPoints: req.body.audiencePainPoints || [],
      audienceGoals: req.body.audienceGoals || [],
      audienceLanguageStyle: req.body.audienceLanguageStyle || [],
      audienceTriggers: req.body.audienceTriggers || [],
      
      // Integrations
      integrationTools: req.body.integrationTools,
      
      // Business DNA
      website: req.body.website,
      industry: req.body.industry,
      email: req.body.email,
      phone: req.body.phone,
      linkedinUrl: req.body.linkedinUrl,
      twitterUrl: req.body.twitterUrl,
      facebookUrl: req.body.facebookUrl,
      instagramUrl: req.body.instagramUrl,
      youtubeUrl: req.body.youtubeUrl,

      // Status
      isDefault: req.body.isDefault ?? false,
      isActive: req.body.isActive ?? true,
    };

    const toolkit = await BrandToolkitModel.create(toolkitData);
    res.status(201).json(toolkit);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error.code === 'SETUP_REQUEST_CONFLICT') return res.status(409).json({error:error.message});
    if (error.code === 'STORAGE_REFERENCE_CONFLICT') return res.status(409).json({ code: error.code, error: error.message });
    logger.error({ err: error }, '[BrandToolkitController] Error creating toolkit');
    res.status(500).json({ error: "Unable to create the brand toolkit. Please try again." });
  }
};

/**
 * PUT /api/brand-toolkits/:id
 * Update an existing brand toolkit
 */
export const updateBrandToolkit = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const id = parseToolkitId(req.params.id);
    
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!id) {
      return res.status(400).json({ error: "Invalid brand toolkit ID" });
    }

    logger.info({ id, userId }, '[BrandToolkitController] PUT /api/brand-toolkits');

    // Verify ownership
    const existing = await BrandToolkitModel.findByIdAndUser(id, userId);
    if (!existing) {
      // Debug: check if toolkit exists at all
      logger.info({ id, userId }, '[BrandToolkitController] Toolkit not found for user');
      return res.status(404).json({ error: "Brand toolkit not found" });
    }
    if (existing.isDefault && req.body.isDefault === false) {
      return res.status(409).json({ error: 'Choose another default toolkit before unsetting this one' });
    }

    let imageFields;
    try { imageFields = brandImageFields(req.body); }
    catch (error) { return res.status(400).json({ error: (error as Error).message }); }

    const updateData: Partial<InsertBrandToolkit> = {
      ...imageFields,
      userId, // Include for default setting logic
      name: req.body.name || req.body.brandName,
      description: req.body.description,
      tagline: req.body.tagline,
      missionStatement: req.body.missionStatement,
      brandValues: req.body.brandValues,
      brandKeywords: req.body.brandKeywords,
      
      // Visual Identity
      logoUrl: req.body.logoUrl,
      logoUrls: req.body.logoUrls,
      logoFileName: req.body.logoFileName,
      logoVisibility: req.body.logoVisibility,
      primaryBrandColor: req.body.primaryBrandColor || req.body.primaryColors?.[0],
      secondaryBrandColor: req.body.secondaryBrandColor || req.body.secondaryColors?.[0],
      accentColor: req.body.accentColor,
      primaryColors: req.body.primaryColors,
      secondaryColors: req.body.secondaryColors,
      additionalColors: req.body.additionalColors,
      fontFamily: req.body.fontFamily || req.body.fonts?.body,
      fonts: req.body.fonts,
      fontFamilies: req.body.fontFamilies,
      gradients: req.body.gradients,
      imageStyleReference: req.body.imageStyleReference,
      visualInstructions: req.body.visualInstructions,
      logoUsageGuidelines: req.body.logoUsageGuidelines,
      
      // Voice & Tone
      voiceType: req.body.voiceType,
      customToneGuidelines: req.body.customToneGuidelines,
      voicePersonalityTraits: req.body.voicePersonalityTraits,
      voiceDos: req.body.voiceDos,
      voiceDonts: req.body.voiceDonts,
      voiceKeywords: req.body.voiceKeywords,
      
      // Content Settings
      defaultCtas: req.body.defaultCtas || req.body.ctas,
      defaultHashtags: req.body.defaultHashtags || req.body.hashtags,
      sampleContent: req.body.sampleContent,
      contentPillars: req.body.contentPillars,
      contentFormats: req.body.contentFormats,
      contentInstructions: req.body.contentInstructions,
      
      // Audience Settings
      audiencePainPoints: req.body.audiencePainPoints,
      audienceGoals: req.body.audienceGoals,
      audienceLanguageStyle: req.body.audienceLanguageStyle,
      audienceTriggers: req.body.audienceTriggers,
      
      // Integrations
      integrationTools: req.body.integrationTools,
      
      // Business DNA
      website: req.body.website,
      industry: req.body.industry,
      email: req.body.email,
      phone: req.body.phone,
      linkedinUrl: req.body.linkedinUrl,
      twitterUrl: req.body.twitterUrl,
      facebookUrl: req.body.facebookUrl,
      instagramUrl: req.body.instagramUrl,
      youtubeUrl: req.body.youtubeUrl,

      // Status
      isDefault: req.body.isDefault,
      isActive: req.body.isActive,
    };

    // Remove undefined values
    Object.keys(updateData).forEach(key => {
      if (updateData[key as keyof typeof updateData] === undefined) {
        delete updateData[key as keyof typeof updateData];
      }
    });

    const toolkit = await BrandToolkitModel.updateForUser(id, userId, updateData, req.body.expectedVersion ?? req.body.version);
    if (!toolkit) return res.status(404).json({ error: 'Brand toolkit not found' });

    // Durable media references and released-object cleanup intents commit with the model mutation.
    res.json(toolkit);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error.code === 'STORAGE_REFERENCE_CONFLICT') return res.status(409).json({ code: error.code, error: error.message });
    if (error.code === 'TOOLKIT_VERSION_CONFLICT') return res.status(409).json({ code: error.code, error: error.message });
    logger.error({ err: error }, '[BrandToolkitController] Error updating toolkit');
    res.status(500).json({ error: "Unable to update the brand toolkit. Please try again." });
  }
};

/**
 * DELETE /api/brand-toolkits/:id
 * Delete a brand toolkit
 */
export const deleteBrandToolkit = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const id = parseToolkitId(req.params.id);
    
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!id) return res.status(400).json({ error: "Invalid brand toolkit ID" });

    // Verify ownership
    const existing = await BrandToolkitModel.findByIdAndUser(id, userId);
    if (!existing) {
      return res.status(404).json({ error: "Brand toolkit not found" });
    }

    const deleted = await BrandToolkitModel.deleteForUser(id, userId);
    if (!deleted) return res.status(404).json({ error: 'Brand toolkit not found' });

    // The model releases this Brand owner in the same transaction as deletion.
    res.status(204).send();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error.code === 'STORAGE_REFERENCE_CONFLICT') return res.status(409).json({ code: error.code, error: error.message });
    logger.error({ err: error }, '[BrandToolkitController] Error deleting toolkit');
    res.status(500).json({ error: "Unable to delete the brand toolkit. Please try again." });
  }
};

/**
 * POST /api/brand-toolkits/:id/set-default
 * Set a brand toolkit as the default
 */
export const setDefaultBrandToolkitHandler = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const id = parseToolkitId(req.params.id);
    
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!id) return res.status(400).json({ error: "Invalid brand toolkit ID" });

    const toolkit = await BrandToolkitModel.setDefault(id, userId);
    if (!toolkit) {
      return res.status(404).json({ error: "Brand toolkit not found" });
    }

    res.json(toolkit);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[BrandToolkitController] Error setting default');
    res.status(500).json({ error: "Unable to set the default brand toolkit. Please try again." });
  }
};

/**
 * POST /api/content/brand-toolkits/upload-image
 * Upload a logo file and return the URL
 */
export const uploadBrandImage = async (req: Request, res: Response) => {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  if (!hasValidLogoSignature(req.file)) return res.status(400).json({ error: 'The uploaded file content does not match its image type' });
  let image;
  try {image=await optimizeBrandImage(req.file.buffer);} catch {return res.status(400).json({error:'This image could not be decoded. Upload a valid PNG, JPG or WebP image.'});}
  try {
    const storage=StorageService.getInstance();
    const originalName=req.file.originalname;
    const optimizedName=`${originalName.replace(/\.[^.]+$/, '')}.webp`;
    const result = await storage.upload(image.buffer, {
      userId, category: 'brand_asset', originalName: optimizedName,
      mimeType: image.mimeType, referenceType: 'brand_toolkit_image',
      metadata:{originalName,width:image.width,height:image.height},
    });
    let thumbnailUrl;
    try {
      const thumbnail=await storage.upload(image.thumbnail,{userId,category:'brand_asset',originalName:`preview-${optimizedName}`,mimeType:image.mimeType,referenceType:'brand_toolkit_image_preview',metadata:{parentImageUrl:result.url}});
      thumbnailUrl=thumbnail.url;
    } catch(error) {logger.warn({err:error},'Brand image preview unavailable; retaining the uploaded image');}
    return res.json({ success: true, url: result.url, originalName, thumbnailUrl, width:image.width,height:image.height,sizeBytes:image.buffer.length });
  } catch (error) {
    logger.error({ err: error }, '[BrandToolkitController] Error uploading brand image');
    return res.status(500).json({ error: 'Unable to upload the image. Please try again.' });
  }
};

export const uploadLogo = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    if (!hasValidLogoSignature(req.file)) {
      return res.status(400).json({ error: 'The uploaded file content does not match its image type' });
    }

    const toolkitId = req.params.id ? parseToolkitId(req.params.id) : undefined;
    let toolkit = undefined;
    if (req.params.id) {
      if (!toolkitId) return res.status(400).json({ error: 'Invalid brand toolkit ID' });
      toolkit = await BrandToolkitModel.findByIdAndUser(toolkitId, userId);
      if (!toolkit) return res.status(404).json({ error: 'Brand toolkit not found' });
      const requestedVersion = req.body?.expectedVersion;
      if (requestedVersion !== undefined) {
        const parsedVersion = typeof requestedVersion === 'string' && /^[1-9]\d*$/.test(requestedVersion)
          ? Number(requestedVersion) : requestedVersion;
        if (!Number.isSafeInteger(parsedVersion) || parsedVersion <= 0) return res.status(400).json({ error: 'expectedVersion must be a positive integer' });
        if (parsedVersion !== toolkit.version) return res.status(409).json({ code: 'TOOLKIT_VERSION_CONFLICT', error: 'This brand toolkit changed. Reload it before uploading.' });
      }
    }

    // Upload file through StorageService (handles quota, tracking, backend)
    const storageService = StorageService.getInstance();
    const uploadResult = await storageService.upload(req.file.buffer, {
      userId,
      category: 'brand_asset',
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      referenceType: 'brand_toolkit_logo',
      referenceId: toolkitId ? String(toolkitId) : undefined,
    });

    let updatedToolkit = toolkit;
    if (toolkitId && toolkit) {
      // The newly uploaded asset is the primary logo. Keep it first as well as
      // in logoUrl so older consumers cannot accidentally use a stale logo.
      const logoUrls = [
        uploadResult.url,
        ...(toolkit.logoUrls || []).filter((url) => url !== uploadResult.url),
      ];
      try {
        updatedToolkit = await BrandToolkitModel.updateForUser(toolkitId, userId, {
          logoUrl: uploadResult.url,
          logoUrls,
          logoFileName: uploadResult.fileName,
        }, toolkit.version);
        if (!updatedToolkit) throw new Error('Brand toolkit changed before the logo could be attached');
      } catch (attachError) {
        try {
          const business = requireBusinessScope();
          await storageService.compensateFailedUpload({ userId, businessProfileId: business.businessProfileId }, uploadResult.fileId);
        } catch (cleanupError) {
          logger.warn({ err: cleanupError, logoUrl: uploadResult.url }, '[BrandToolkitController] Failed to clean up unattached logo');
        }
        throw attachError;
      }
    }
    
    logger.info({ logoUrl: uploadResult.url }, '[BrandToolkitController] Logo uploaded');
    
    res.json({
      success: true,
      url: uploadResult.url,
      filename: uploadResult.fileName,
      originalName: req.file.originalname,
      toolkit: updatedToolkit,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error.code === 'STORAGE_REFERENCE_CONFLICT') return res.status(409).json({ code: error.code, error: error.message });
    if (error.code === 'TOOLKIT_VERSION_CONFLICT') return res.status(409).json({ code: error.code, error: error.message });
    logger.error({ err: error }, '[BrandToolkitController] Error uploading logo');
    res.status(500).json({ error: "Unable to upload the logo. Please try again." });
  }
};
