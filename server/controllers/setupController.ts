import { capturePublicScreenshot } from '../utils/publicScreenshot.js';
import { fetchPublicHttpUrl, readResponseBuffer } from '../utils/safeRemoteFetch.js';
import { updateSetupAnalysisProgress, withSetupAnalysisCommit, SetupAnalysisCancelled } from '../services/setupAnalysisProgress.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from 'express';
import { currentBusinessScope, isBusinessOwner } from '../tenancy/businessContext.js';
import { saveWorkspaceWebsiteAnalysis } from '../services/workspaceWebsiteAnalysis.js';
import { logger } from '../utils/logger.js';
import { WebsiteCrawlerService } from '../services/WebsiteCrawlerService.js';
import { LLMProviderFactory } from '../services/agents/LLMProviderFactory.js';
import { knowledgeGateway } from '../services/knowledge/KnowledgeGateway.js';
import { knowledgeIngestionService } from '../services/knowledge/KnowledgeIngestionService.js';
import { extractBrandStyles } from '../services/BrandStyleExtractor.js';
import { StorageService } from '../services/StorageService.js';
import { webSocketEmitter } from '../services/agents/WebSocketEmitter.js';
import * as cheerio from 'cheerio';
import { extractWebsiteContactDetails } from '../utils/websiteContactDetails.js';

/** Helper to emit step-by-step analysis progress via WebSocket */
async function emitAnalysisProgress(
  userId: number,
  step: string,
  detail: string,
  extra?: Record<string, unknown>,
) {
  await updateSetupAnalysisProgress(step, detail, extra);
  webSocketEmitter.emit(userId, 'website_analysis_progress', {
    businessProfileId: currentBusinessScope()?.businessProfileId,
    step,
    detail,
    ...extra,
  });
}

/**
 * Extract valid image URLs from crawled HTML pages.
 * Skips SVGs, icons, favicons, tiny images, and data URIs.
 */
function extractImageUrls(htmlPages: { html: string; url: string }[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  const SKIP_PATTERNS = /favicon|icon[-_.]|sprite|pixel|spacer|tracking|badge|button[-_.]|arrow[-_.]|bullet/i;
  const SKIP_EXTENSIONS = /\.(svg|ico|gif)$/i;

  for (const page of htmlPages) {
    const $ = cheerio.load(page.html);
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
      if (!src) return;

      // Skip data URIs
      if (src.startsWith('data:')) return;

      // Resolve to absolute URL
      let absoluteUrl: string;
      try {
        absoluteUrl = new URL(src, page.url).href;
      } catch {
        return;
      }

      // Skip SVGs, ICOs, GIFs
      if (SKIP_EXTENSIONS.test(absoluteUrl)) return;

      // Skip icon/favicon/sprite patterns in URL
      if (SKIP_PATTERNS.test(absoluteUrl)) return;

      // Skip if explicit small width/height attributes
      const width = parseInt($(el).attr('width') || '', 10);
      const height = parseInt($(el).attr('height') || '', 10);
      if ((width > 0 && width < 50) || (height > 0 && height < 50)) return;

      // Deduplicate
      if (seen.has(absoluteUrl)) return;
      seen.add(absoluteUrl);

      results.push(absoluteUrl);
    });

    // Also check <source> inside <picture> elements
    $('picture source').each((_, el) => {
      const srcset = $(el).attr('srcset');
      if (!srcset) return;
      // Take the first URL from srcset
      const firstSrc = srcset.split(',')[0]?.trim().split(/\s+/)[0];
      if (!firstSrc || firstSrc.startsWith('data:')) return;
      try {
        const absoluteUrl = new URL(firstSrc, page.url).href;
        if (SKIP_EXTENSIONS.test(absoluteUrl) || SKIP_PATTERNS.test(absoluteUrl)) return;
        if (!seen.has(absoluteUrl)) {
          seen.add(absoluteUrl);
          results.push(absoluteUrl);
        }
      } catch { /* skip invalid URLs */ }
    });
  }

  return results;
}

/**
 * Download images, filter by size, and save to storage.
 * Returns array of { url, originalUrl } for saved images. Caps at maxImages.
 */
async function downloadAndSaveImages(
  imageUrls: string[],
  userId: number,
  maxImages = 20
): Promise<{ url: string; originalUrl: string }[]> {
  const storageService = StorageService.getInstance();
  const saved: { url: string; originalUrl: string }[] = [];
  const MIN_SIZE = 5 * 1024;       // 5KB minimum
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB maximum

  // Process in batches of 5
  for (let i = 0; i < imageUrls.length && saved.length < maxImages; i += 5) {
    const batch = imageUrls.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(async (imgUrl) => {
        const { response: resp } = await fetchPublicHttpUrl(imgUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SalesMarketingBot/1.0)' },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) return null;

        const contentType = resp.headers.get('content-type') || '';
        // Skip non-image responses
        if (!contentType.startsWith('image/')) return null;
        // Skip SVGs that slipped through
        if (contentType.includes('svg')) return null;

        const buffer = await readResponseBuffer(resp, MAX_SIZE);
        if (buffer.length < MIN_SIZE || buffer.length > MAX_SIZE) return null;

        const ext = contentType.includes('png') ? 'png'
          : contentType.includes('webp') ? 'webp'
          : contentType.includes('gif') ? 'gif'
          : 'jpg';
        const filename = `website-image-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;

        const uploadResult = await storageService.upload(buffer, {
          userId,
          category: 'brand_asset',
          originalName: filename,
          mimeType: contentType,
          referenceType: 'website_image',
        });

        return { url: uploadResult.url, originalUrl: imgUrl };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value && saved.length < maxImages) {
        saved.push(r.value);
      }
    }
  }

  return saved;
}

/**
 * Capture a full-page desktop screenshot of a URL using Puppeteer.
 * Returns the stored screenshot URL, or null if capture fails.
 */
async function captureDesktopScreenshot(url: string, userId: number): Promise<string | null> {
  try {
    const { launchSystemChromium } = await import('../utils/browserAutomation.js');
    const browser = await launchSystemChromium({ untrustedContent: true });
    try {
      const buffer = await capturePublicScreenshot(browser, url);

      const storageService = StorageService.getInstance();
      const uploadResult = await storageService.upload(buffer, {
        userId,
        category: 'brand_asset',
        originalName: 'website-screenshot.png',
        mimeType: 'image/png',
        referenceType: 'website_screenshot',
      });

      logger.info({ userId, url: uploadResult.url }, '[analyzeWebsite] Desktop screenshot captured');
      return uploadResult.url;
    } finally {
      await browser.close();
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logger.warn({ err: err.message, url }, '[analyzeWebsite] Screenshot capture failed');
    return null;
  }
}

/**
 * Extract social media profile URLs directly from HTML anchor hrefs.
 * Works even when the LLM misses them (links are often in footer/header).
 */
function extractSocialLinksFromHtml(htmlPages: { html: string }[]): Record<string, string> {
  const patterns: Record<string, RegExp> = {
    linkedinUrl: /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^\s"'<>]+/gi,
    twitterUrl: /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[^\s"'<>]+/gi,
    facebookUrl: /https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+/gi,
    instagramUrl: /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/gi,
    youtubeUrl: /https?:\/\/(?:www\.)?youtube\.com\/(?:channel|c|user|@)[^\s"'<>]+/gi,
  };

  const result: Record<string, string> = {};
  for (const page of htmlPages) {
    for (const [key, regex] of Object.entries(patterns)) {
      if (result[key]) continue;
      const match = page.html.match(regex);
      if (match?.[0]) {
        // Clean trailing punctuation or quotes
        result[key] = match[0].replace(/['")\]}>]+$/, '');
      }
    }
  }
  return result;
}

const PAGE_SELECTION_PROMPT = `You are a web crawler assistant. Select the most valuable pages to crawl from a company website to extract: company description, contact details, team info, brand identity, products/services.

Each line below is: URL [category] "anchor text"

Return ONLY a JSON array of the selected URLs (no explanation, no markdown). Select up to 15 URLs.

MUST include if available (these are highest priority — do not skip them):
- contact / contact-us / get-in-touch pages
- about / about-us / company / our-story pages
- products / services / solutions / what-we-do pages

Also include if available:
- team / leadership / people pages
- pricing / plans pages
- case studies / customers / testimonials pages
- mission / values pages

Skip: individual blog posts, news articles, press releases, login/signup, legal/privacy pages, asset files.

Example output: ["https://example.com/about", "https://example.com/contact", "https://example.com/services"]`;

const SUBPAGE_SELECTION_PROMPT = `You are a web crawler assistant. From newly discovered sub-pages on a company website, select pages likely to contain company info not yet captured (contact details, team bios, product details, case studies).

Each line is: URL [category] "anchor text"

Return ONLY a JSON array of up to 10 URLs (no explanation, no markdown). Skip pages already crawled.
Skip: blog posts, news articles, login pages, legal pages.`;

const EXTRACTION_PROMPT = `You are an expert business analyst. Given website content below, extract structured information about the company and return ONLY a valid JSON object (no markdown, no explanation) with these fields:

{
  "companyName": string | null,
  "industry": one_of("Technology","Healthcare","Finance","Retail","E-commerce","Education","Real Estate","Marketing","Consulting","Manufacturing","Other") | null,
  "companySize": one_of("1-10","11-50","51-200","201-500","501-1000","1000+") | null,
  "description": string | null,
  "website": string | null,
  "businessType": one_of("Marketplace","SaaS","Agency","Consulting","Manufacturing","Retail","Service") | null,
  "targetMarket": one_of("B2B","B2C","B2B2C","D2C","Enterprise","SMB","Startup") | null,
  "customerType": string | null,
  "keyBuyerRoles": string[] | [],
  "businessGoals": array_of("qualified_leads","outbound_responses","conversion_rates","brand_awareness","marketing_operations","revenue_growth","thought_leadership","market_expansion","partnerships","customer_retention") | [],
  "email": string | null,
  "phone": string | null,
  "address": string | null,
  "city": string | null,
  "state": string | null,
  "country": string | null,
  "postalCode": string | null,
  "foundedYear": string | null,
  "annualRevenue": string | null,
  "businessHours": string | null,
  "targetRegions": string[] | [],
  "preferredChannels": string[] | [],
  "linkedinUrl": string | null,
  "twitterUrl": string | null,
  "instagramUrl": string | null,
  "facebookUrl": string | null,
  "youtubeUrl": string | null,
  "brandName": string | null,
  "tagline": string | null,
  "missionStatement": string | null,
  "valueProposition": string | null,
  "brandKeywords": string[] | [],
  "voicePersonalityTraits": array_of("Professional","Casual","Bold","Inspiring","Friendly","Authoritative","Playful","Empathetic") | [],
  "brandValues": array_of("Innovation","Trust","Quality","Community","Creativity","Integrity","Excellence","Sustainability","Transparency","Customer-first") | [],
  "voiceKeywords": string[] | [],
  "contentPillars": string[] | [],
  "contentFormats": string[] | [],
  "defaultHashtags": string[] | [],
  "defaultCtas": string[] | []
}

Rules:
- companyName: official company name from site
- industry: the sector served (e.g. Finance for investing/trading tools, Healthcare for medical software). Do not use the delivery model SaaS as the industry.
- companySize: only use explicit employee/headcount evidence. Return null if headcount is not stated; never infer it from words like startup or enterprise.
- description: 2-3 sentence company description
- email: any contact/info/support email address found on the site
- phone: any phone number found on the site (with country code if present)
- address: full physical address or city/country if mentioned
- city: city name if found
- state: state/province/region if found
- country: country name if found
- postalCode: postal/zip code if found
- foundedYear: year company was founded (4-digit string), only if explicitly stated
- annualRevenue, businessHours, targetRegions, preferredChannels: only use explicit information on the website, otherwise null/[]
- linkedinUrl / twitterUrl / instagramUrl / facebookUrl / youtubeUrl: official social media profile URLs if present
- customerType: the specific customer segment (e.g. Retail traders, Individual investors, Small business owners). Do not repeat B2B/B2C or the targetMarket field here.
- businessType: the business model type (e.g. SaaS, Agency, Marketplace). Distinct from targetMarket
- targetMarket: the primary audience segment the company sells to (e.g. Enterprise, SMB, Startup)
- keyBuyerRoles: 2-5 typical job titles or roles of the company's buyers/decision-makers (e.g. CTO, VP of Sales, Marketing Manager)
- businessGoals: infer 1-3 most relevant from company positioning
- brandName: the brand or product name (may differ from legal company name)
- tagline: any slogan or tagline found on the website
- missionStatement: company mission statement if explicitly stated
- valueProposition: a concise value proposition or unique selling point
- brandKeywords: 3-6 key terms that define the brand
- voicePersonalityTraits: infer 2-4 from writing style, tone, and positioning
- brandValues: infer 1-4 from mission, about pages
- voiceKeywords: 3-6 action words that embody brand communication style (e.g., Empower, Innovate, Simplify)
- contentPillars: 2-5 key content themes inferred from blog categories, product areas, or marketing focus (e.g., Thought Leadership, Product Updates, Customer Success)
- contentFormats: suggest 2-4 content formats suited to the brand (e.g., Blog Posts, Case Studies, Social Posts, Videos, Newsletters)
- defaultHashtags: 3-6 relevant branded or industry hashtags (include # prefix)
- defaultCtas: 2-4 call-to-action phrases used on the site (e.g., Get Started, Book a Demo, Learn More)

Do NOT extract colors or fonts — those are handled separately via CSS analysis.
Only include non-null values for fields you are confident about. Return null/[] if uncertain.`;

export async function analyzeWebsite(req: Request, res: Response) {
  const scope = currentBusinessScope();
  if (!scope) return res.status(409).json({ error: 'Create and select a business profile before analyzing its website.' });
  if (!isBusinessOwner(req)) return res.status(403).json({ error: 'Only the workspace owner can analyze its website during setup.' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = businessOwnerUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Normalize URL
  let normalizedUrl = url.trim();
  // Reject an explicit unsupported scheme before adding the default protocol.
  // Otherwise ftp://example.com becomes a valid HTTPS URL whose host is "ftp".
  if (normalizedUrl.includes('://') && !/^https?:\/\//i.test(normalizedUrl)) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = 'https://' + normalizedUrl;
  }

  // Validate URL
  try {
    const parsedUrl = new URL(normalizedUrl);
    if (!['https:', 'http:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) throw new Error('Invalid URL');
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  try {
    // ── KB Cache Check: Return cached result if this URL was already analyzed ──
    try {
      const { KnowledgeBaseModel } = await import('../models/knowledgeBase/functions.js');
      const existing = await KnowledgeBaseModel.findBySourceUrl(userId, normalizedUrl, scope.businessProfileId);
      if (existing && existing.content && existing.processingStatus === 'completed') {
        const parsed = JSON.parse(existing.content);
        if (parsed.extractedData && parsed.setupExtractionVersion === 3 && req.body.forceRefresh !== true) {
          logger.info({ userId, kbEntryId: existing.id, sourceUrl: normalizedUrl }, '[analyzeWebsite] Returning cached KB result');
          const analysisSummary = { pages: parsed.pagesScraped?.length || 0, knowledgeSaved: true, warnings: existing.indexingStatus !== 'failed' ? [] : ["Website content is saved, but knowledge search indexing is not ready."] };
          await withSetupAnalysisCommit(executor=>saveWorkspaceWebsiteAnalysis(userId, scope.businessProfileId, normalizedUrl, parsed.extractedData, existing.id, analysisSummary, executor));
          return res.json({ success: true, data: parsed.extractedData, kbEntryId: existing.id, cached: true, analysisSummary });
        }
      }
    } catch (cacheErr) {
      logger.warn({ err: cacheErr }, '[analyzeWebsite] KB cache lookup failed, proceeding with fresh crawl');
    }

    const crawler = new WebsiteCrawlerService({ maxPages: 1, maxContentLength: 16000, timeoutMs: 30000 });

    // ── Phase 1: Fetch homepage ──────────────────────────────────────────────
    await emitAnalysisProgress(userId, 'fetching', 'Fetching homepage...');
    const homepagePage = await crawler.fetchPage(normalizedUrl);
    if (!homepagePage.success || !homepagePage._html) {
      return res.status(422).json({ error: 'Could not reach this website. Please check the URL and try again.' });
    }
    homepagePage.category = 'homepage';

    // Start screenshot capture immediately in background (don't block other phases)
    let screenshotPromise: Promise<string | null> = captureDesktopScreenshot(normalizedUrl, userId);
    // When screenshot is ready, emit it to client immediately regardless of current phase
    screenshotPromise = screenshotPromise.then(async url => {
      if (url) {
        await emitAnalysisProgress(userId, 'screenshot_ready', 'Homepage screenshot captured!', {
          screenshotUrl: url,
        });
      }
      return url;
    }).catch(() => null);

    // ── Phase 2: Extract + categorize all internal links from homepage HTML ──
    await emitAnalysisProgress(userId, 'discovering', 'Discovering pages on your website...');
    const homepageLinks = crawler.extractLinks(homepagePage._html, normalizedUrl);
    logger.info({ total: homepageLinks.length }, '[analyzeWebsite] Homepage links discovered');

    // Emit discovered pages to client
    await emitAnalysisProgress(userId, 'discovering', `Found ${homepageLinks.length} pages on your website`, {
      discoveredPages: homepageLinks.slice(0, 50).map(l => ({ url: l.url, category: l.category, anchorText: l.anchorText })),
    });

    const llmProvider = await LLMProviderFactory.createProviderForUser(userId);
    const callProvider = async (args: Parameters<typeof llmProvider.createChatCompletion>[0]) => {
      try { return await llmProvider.createChatCompletion(args); }
      catch (error) {
        logger.warn({ err: error }, '[analyzeWebsite] AI request failed');
        return { success: false, content: '', error: 'AI service temporarily unavailable' };
      }
    };
    const visitedSet = new Set<string>([normalizedUrl]);
    const allPages = [homepagePage];

    // ── Phase 3: LLM selects round-1 pages from homepage links ──────────────
    let round1Links: string[] = [];
    if (homepageLinks.length > 0) {
      await emitAnalysisProgress(userId, 'selecting', `AI is selecting the most relevant pages from ${homepageLinks.length} discovered links...`);
      // Pass URL + category + anchor text so LLM has full context
      const linkList = homepageLinks.slice(0, 100)
        .map(l => `${l.url} [${l.category}] "${l.anchorText}"`)
        .join('\n');

      const selectionResp = await callProvider({
        model: llmProvider.defaultModel,
        messages: [
          { role: 'system', content: PAGE_SELECTION_PROMPT },
          { role: 'user', content: `Homepage: ${normalizedUrl}\n\nDiscovered URLs (URL [category] "anchor text"):\n${linkList}` },
        ],
      });

      if (selectionResp.success && selectionResp.content) {
        try {
          const cleaned = selectionResp.content.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
          const selected = JSON.parse(cleaned);
          if (Array.isArray(selected)) {
            round1Links = selected
              .filter((u: unknown) => typeof u === 'string' && u.startsWith('http'))
              .slice(0, 15);
          }
        } catch {
          logger.warn('[analyzeWebsite] Failed to parse LLM round-1 selection');
        }
      }

      // Rule-based fallback: always ensure contact + about + services/products are included
      const MUST_HAVE_CATEGORIES = ['contact', 'about', 'services', 'products', 'platform'];
      for (const cat of MUST_HAVE_CATEGORIES) {
        const alreadyHave = round1Links.some(
          u => homepageLinks.find(l => l.url === u)?.category === cat
        );
        if (!alreadyHave) {
          const fallback = homepageLinks.find(l => l.category === cat && !visitedSet.has(l.url));
          if (fallback && !round1Links.includes(fallback.url)) {
            round1Links.push(fallback.url);
          }
        }
      }
      round1Links = round1Links.slice(0, 18); // Cap at 18 for round 1

      logger.info({ selected: round1Links.length, urls: round1Links }, '[analyzeWebsite] Round-1 pages selected');

      // Emit selected pages to client
      await emitAnalysisProgress(userId, 'selecting', `Selected ${round1Links.length} important pages to crawl`, {
        selectedPages: round1Links,
      });
    }

    // ── Phase 4: Deep-crawl round-1 pages in parallel batches ───────────────
    await emitAnalysisProgress(userId, 'crawling', `Crawling ${round1Links.length} pages...`, { totalPages: round1Links.length });
    for (const u of round1Links) visitedSet.add(u);
    for (let i = 0; i < round1Links.length; i += 5) {
      const batch = round1Links.slice(i, i + 5);
      const results = await Promise.allSettled(batch.map(u => crawler.fetchPage(u)));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.success) allPages.push(r.value);
      }
      await emitAnalysisProgress(userId, 'crawling', `Crawled ${Math.min(i + 5, round1Links.length)} of ${round1Links.length} pages...`, { crawled: Math.min(i + 5, round1Links.length), totalPages: round1Links.length });
    }

    // ── Phase 5: Sub-page discovery from crawled pages ───────────────────────
    // Extract new links from every page crawled so far (skip homepage, already processed)
    const newLinksMap = new Map<string, { url: string; category: string; anchorText: string; priority: number }>();
    for (const p of allPages.slice(1)) {
      if (!p._html || !p.url) continue;
      const subLinks = crawler.extractLinks(p._html, p.url);
      for (const sl of subLinks) {
        if (!visitedSet.has(sl.url) && !newLinksMap.has(sl.url) && sl.priority <= 3) {
          newLinksMap.set(sl.url, sl);
        }
      }
    }

    if (newLinksMap.size > 0) {
      const newLinkList = [...newLinksMap.values()]
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 60)
        .map(l => `${l.url} [${l.category}] "${l.anchorText}"`)
        .join('\n');

      const round2Resp = await callProvider({
        model: llmProvider.defaultModel,
        messages: [
          { role: 'system', content: SUBPAGE_SELECTION_PROMPT },
          { role: 'user', content: `Already crawled:\n${[...visitedSet].join('\n')}\n\nNew discovered URLs:\n${newLinkList}` },
        ],
      });

      let round2Links: string[] = [];
      if (round2Resp.success && round2Resp.content) {
        try {
          const cleaned = round2Resp.content.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
          const selected = JSON.parse(cleaned);
          if (Array.isArray(selected)) {
            round2Links = selected
              .filter((u: unknown) => typeof u === 'string' && u.startsWith('http') && !visitedSet.has(u as string))
              .slice(0, 10);
          }
        } catch {
          logger.warn('[analyzeWebsite] Failed to parse LLM round-2 selection');
        }
      }

      if (round2Links.length > 0) {
        logger.info({ selected: round2Links.length, urls: round2Links }, '[analyzeWebsite] Round-2 sub-pages selected');
        for (const u of round2Links) visitedSet.add(u);
        const r2Results = await Promise.allSettled(round2Links.map(u => crawler.fetchPage(u)));
        for (const r of r2Results) {
          if (r.status === 'fulfilled' && r.value.success) allPages.push(r.value);
        }
      }
    }

    // ── Phase 6: Build combined structured content ───────────────────────────
    await emitAnalysisProgress(userId, 'extracting_colors', 'Extracting colors and brand palette...');
    const combinedContent = crawler.buildContent(allPages);
    logger.info({ pages: allPages.filter(p => p.success).length, contentLength: combinedContent.length }, '[analyzeWebsite] Crawl complete');

    if (!combinedContent || combinedContent.length < 100) {
      return res.status(422).json({ error: 'Could not extract content from this website. Please fill in manually.' });
    }

    // ── Phase 6.5: Extract brand styles directly from HTML/CSS (no LLM) ────
    const htmlPages = allPages
      .filter(p => p.success && p._html)
      .map(p => ({ html: p._html!, url: p.url, isHomepage: p.url === normalizedUrl }));

    const brandStyles = extractBrandStyles(htmlPages);
    logger.info({
      primaryColor: brandStyles.primaryColor,
      fonts: brandStyles.fonts,
      gradients: brandStyles.gradients.length,
      colorPaletteSize: brandStyles.colorPalette.length,
    }, '[analyzeWebsite] CSS brand style extraction complete');

    // Emit extracted colors to client
    await emitAnalysisProgress(userId, 'extracting_colors', 'Colors extracted!', {
      extractedColors: {
        primaryColor: brandStyles.primaryColor,
        secondaryColor: brandStyles.secondaryColor,
        accentColor: brandStyles.accentColor,
        colorPalette: brandStyles.colorPalette.slice(0, 12),
        gradients: brandStyles.gradients.slice(0, 4),
      },
    });

    // Emit extracted fonts to client
    await emitAnalysisProgress(userId, 'extracting_fonts', 'Fonts extracted!', {
      extractedFonts: {
        fonts: brandStyles.fonts,
        fontFamilies: brandStyles.fontFamilies,
      },
    });

    // ── Phase 6.6: Extract images + await background screenshot (parallel) ──
    await emitAnalysisProgress(userId, 'extracting_images', 'Extracting images from pages...');
    const imageUrls = extractImageUrls(htmlPages);
    logger.info({ candidates: imageUrls.length }, '[analyzeWebsite] Image URLs extracted from HTML');

    // Run image download in parallel with awaiting the background screenshot
    const [savedImages, screenshotUrl] = await Promise.all([
      downloadAndSaveImages(imageUrls, userId, 20).catch(err => {
        logger.warn({ err }, '[analyzeWebsite] Image download failed');
        return [] as { url: string; originalUrl: string }[];
      }),
      screenshotPromise,
    ]);
    logger.info({ savedImages: savedImages.length, hasScreenshot: !!screenshotUrl }, '[analyzeWebsite] Image + screenshot extraction complete');

    // Emit images + final screenshot (screenshot may have been emitted earlier too)
    if (screenshotUrl || savedImages.length > 0) {
      await emitAnalysisProgress(userId, 'extraction_complete', 'Extraction complete!', {
        screenshotUrl: screenshotUrl || null,
        extractedImages: savedImages.length > 0 ? savedImages : null,
      });
    }

    // ── Phase 7: LLM extracts structured business data (enriched with existing KB) ──
    await emitAnalysisProgress(userId, 'analyzing', 'AI is analyzing your business...');
    let kbContext = '';
    try {
      const existingKb = await knowledgeGateway.retrieveText({ tenantId: userId, purpose: 'internal_assist', channel: 'internal', audience: 'internal', redactedText: 'company products services policies positioning and customer profile', redactedHistory: [], entities: {}, risk: 'low' });
      if (existingKb) {
        kbContext = `\n\nExisting Knowledge Base Context:\n${existingKb}`;
      }
    } catch (kbErr) {
      logger.warn({ err: kbErr }, '[analyzeWebsite] Failed to load existing KB context, continuing');
    }

    const llmMessages = [
      { role: 'system' as const, content: EXTRACTION_PROMPT },
      { role: 'user' as const, content: `Website URL: ${normalizedUrl}\n\nWebsite Content:\n${combinedContent.slice(0, 12000)}${kbContext}` },
    ];

    let response = await callProvider({
      model: llmProvider.defaultModel,
      messages: llmMessages,
    });

    // If LLM call failed, try fallback provider (e.g. Gemini quota exhausted → OpenAI)
    if (!response.success || !response.content) {
      const errMsg = response.error || 'Unknown LLM error';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger.warn({ error: errMsg, provider: (llmProvider as any)._platform }, '[analyzeWebsite] LLM extraction failed, attempting fallback');

      try {
        const { LLMProviderFactory } = await import('../services/agents/LLMProviderFactory.js');
        const { provider: fallbackProvider } = await LLMProviderFactory.handleRateLimitError(
          llmProvider,
          { message: errMsg, status: 429 },
        );
        response = await fallbackProvider.createChatCompletion({
          model: fallbackProvider.defaultModel,
          messages: llmMessages,
        });
      } catch {
        // fallback also unavailable
      }

      if (!response.success || !response.content) {
        logger.error({ error: errMsg }, '[analyzeWebsite] LLM extraction failed (no fallback available)');
        return res.status(503).json({ success: false, error: 'The AI service is temporarily unavailable. Please retry analysis shortly, or enter your details manually.' });
      }
    }

    let extracted: Record<string, unknown> = {};
    try {
      const cleaned = response.content.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
      extracted = JSON.parse(cleaned);
    } catch {
      logger.warn({ content: response.content }, '[analyzeWebsite] Failed to parse LLM JSON');
      return res.status(422).json({ error: 'Could not parse website analysis. Please fill in manually.' });
    }

    // ── Merge CSS-extracted brand styles into the response ──
    // Logo: from CSS extraction
    if (brandStyles.logoUrl) {
      extracted.logoUrl = brandStyles.logoUrl;
    }

    // Colors: always from CSS extraction (not LLM)
    extracted.primaryColor = brandStyles.primaryColor;
    extracted.secondaryColor = brandStyles.secondaryColor;
    extracted.accentColor = brandStyles.accentColor;
    extracted.colorPalette = brandStyles.colorPalette;
    extracted.backgroundColors = brandStyles.backgroundColors;

    // Fonts: from CSS extraction
    extracted.fonts = brandStyles.fonts;
    extracted.fontFamilies = brandStyles.fontFamilies;
    extracted.fontSizes = brandStyles.fontSizes;
    extracted.fontWeights = brandStyles.fontWeights;

    // Gradients: from CSS extraction
    extracted.gradients = brandStyles.gradients;

    // Public mailto/tel and protected-email markup are more reliable than model inference.
    const contactDetails = extractWebsiteContactDetails(htmlPages);
    if (contactDetails.email) extracted.email = contactDetails.email;
    if (contactDetails.phone) extracted.phone = contactDetails.phone;

    // ── Merge HTML-extracted social media links (supplements LLM extraction) ──
    const socialLinks = extractSocialLinksFromHtml(htmlPages);
    for (const [key, url] of Object.entries(socialLinks)) {
      if (!extracted[key]) {
        extracted[key] = url;
      }
    }

    // ── Download logo locally if it's a remote URL ──
    if (extracted.logoUrl && typeof extracted.logoUrl === 'string' && extracted.logoUrl.startsWith('http')) {
      try {
        const { response: logoResponse } = await fetchPublicHttpUrl(extracted.logoUrl as string, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SalesMarketingBot/1.0)' },
          signal: AbortSignal.timeout(10000),
        });
        if (logoResponse.ok) {
          const contentType = logoResponse.headers.get('content-type') || 'image/png';
          const buffer = await readResponseBuffer(logoResponse, 10 * 1024 * 1024);
          if (buffer.length > 0 && buffer.length < 10 * 1024 * 1024) { // Max 10MB
            const ext = contentType.includes('svg') ? 'svg' : contentType.includes('png') ? 'png' : contentType.includes('gif') ? 'gif' : contentType.includes('webp') ? 'webp' : 'png';
            const storageService = StorageService.getInstance();
            const uploadResult = await storageService.upload(buffer, {
              userId,
              category: 'brand_asset',
              originalName: `logo.${ext}`,
              mimeType: contentType,
              referenceType: 'brand_toolkit_logo',
            });
            extracted.logoUrl = uploadResult.url;
            logger.info({ localUrl: uploadResult.url }, '[analyzeWebsite] Logo downloaded and stored locally');
          }
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (logoErr: any) {
        logger.warn({ err: logoErr.message, logoUrl: extracted.logoUrl }, '[analyzeWebsite] Failed to download logo, keeping remote URL');
      }
    }

    // ── Add screenshot + extracted images to response ──
    if (screenshotUrl) {
      extracted.screenshotUrl = screenshotUrl;
    }
    if (savedImages.length > 0) {
      extracted.extractedImages = savedImages;
    }

    // ── Save crawled content to Knowledge Base as single URL entry with chunks + embeddings ──
    await emitAnalysisProgress(userId, 'saving', 'Saving to knowledge base...');
    let kbEntryId: number | null = null;
    const analysisWarnings: string[] = [];
    try {
      const { KnowledgeBaseModel } = await import('../models/knowledgeBase/functions.js');

      // Build per-page chunks (one chunk per scraped page)
      const successPages = allPages.filter(p => p.success && (p.text || p.markdown));
      const chunks: { index: number; text: string; charStart: number; charEnd: number; tokenEstimate: number; pageUrl: string }[] = [];
      let charOffset = 0;
      for (let i = 0; i < successPages.length; i++) {
        const page = successPages[i];
        const pageText = page.text || page.markdown || '';
        const pageTitle = page.title || page.url || `Page ${i + 1}`;
        const chunkText = `## ${pageTitle}\nURL: ${page.url}\n\n${pageText}`;
        chunks.push({
          index: i,
          text: chunkText,
          charStart: charOffset,
          charEnd: charOffset + chunkText.length,
          tokenEstimate: Math.ceil(chunkText.length / 4),
          pageUrl: page.url || '',
        });
        charOffset += chunkText.length + 1;
      }

      // Searchable vectors come only from the governed knowledge index created
      // after the entry is saved (as for uploads). Raw vectors used to be
      // stored inside this JSON, where nothing read them.
      const embeddingsGenerated = false;
      const embeddingModel: string | null = null;

      // Store as JSON with extractedText + chunks (same format as KB URL entries)
      const hostname = new URL(normalizedUrl).hostname;
      const contentJson = JSON.stringify({
        setupExtractionVersion: 3,
        extractedText: combinedContent,
        extractedData: extracted,
        chunks,
        embeddingsGenerated,
        embeddingModel,
        extractionSource: 'web-crawler',
        extractionWarnings: [],
        pagesScraped: successPages.map(p => ({ url: p.url, title: p.title })),
      });

      const entry = await withSetupAnalysisCommit(executor=>KnowledgeBaseModel.create({
        userId,
        businessProfileId: scope.businessProfileId,
        title: `${(extracted.companyName as string) || hostname} — Website`,
        description: `Crawled from ${normalizedUrl} during onboarding`,
        content: contentJson,
        type: 'url',
        sourceUrl: normalizedUrl,
        processingStatus: 'completed',
      }, executor));
      kbEntryId = entry.id;
      logger.info({ userId, entryId: entry.id, chunks: chunks.length }, '[analyzeWebsite] Saved website content to KB');
      // Create the governed version (ready for owner review) so the website
      // content can be published to assistants without a manual re-index.
      try {
        const governed = await knowledgeIngestionService.indexLegacyEntry(entry, { autoPublish: false });
        if (!governed.vectorIndexed) analysisWarnings.push('Website content is saved; semantic search indexing will be retried.');
      } catch (indexErr) {
        logger.warn({ err: indexErr, userId, entryId: entry.id }, '[analyzeWebsite] Knowledge indexing failed');
        await KnowledgeBaseModel.update(entry.id, userId, { indexingStatus: 'failed' }).catch(() => undefined);
        analysisWarnings.push('Website content is saved, but knowledge search indexing is not ready.');
      }
    } catch (err) {
      logger.warn({ err, userId }, '[analyzeWebsite] Failed to save to KB, continuing');
      analysisWarnings.push('Business details were extracted, but website content could not be saved to the knowledge base.');
    }

    const analysisSummary = { sourcePages: allPages.filter(p => p.success).map(p => ({ url: p.url, title: p.title || '' })), pages: allPages.filter(p => p.success).length, knowledgeSaved: !!kbEntryId, warnings: analysisWarnings };
    await withSetupAnalysisCommit(executor=>saveWorkspaceWebsiteAnalysis(userId, scope.businessProfileId, normalizedUrl, extracted, kbEntryId, analysisSummary, executor));
    await emitAnalysisProgress(userId, 'complete', 'Analysis complete!');
    return res.json({ success: true, data: extracted, kbEntryId, analysisSummary });
  } catch (error: unknown) {
    if (error instanceof SetupAnalysisCancelled) throw error;
    logger.error({ err: error, url: normalizedUrl, userId }, '[analyzeWebsite] Error');
    return res.status(503).json({ success: false, error: 'Website analysis was interrupted. Please retry shortly, or continue by entering your business details manually.' });
  }
}
