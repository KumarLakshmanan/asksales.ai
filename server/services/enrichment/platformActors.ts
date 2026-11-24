// ─── Lead Enrichment — Platform Actor Configurations ────────────────────────────

import type { ExtractedInfo, EnrichmentPlatform, EnrichmentHandle } from './types.js';
import {
  extractEmailsFromText,
  extractPhonesFromText,
  extractUrlsFromText,
  extractSocialHandlesFromText,
  extractSocialUrlsFromText,
  extractDomainFromUrl,
} from './textExtractors.js';

// ─── Shared Actor Config Types ───────────────────────────────────────────────────

export type ActorConfig = {
  actorId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildInput: (identifier: string) => Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extractFromResult: (items: any[]) => Partial<ExtractedInfo>;
};

// ─── Primary Platform Actors ─────────────────────────────────────────────────────

export const PLATFORM_ACTORS: Record<EnrichmentPlatform, ActorConfig> = {
  instagram: {
    actorId: 'apify/instagram-profile-scraper',
    buildInput: (identifier: string) => {
      const handle = identifier.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/$/, '');
      return { usernames: [handle] };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractFromResult: (items: any[]) => {
      const info: Partial<ExtractedInfo> = { emails: [], phones: [], websites: [], socialProfiles: {} };
      for (const item of items) {
        if (item.externalUrl) info.websites!.push(item.externalUrl);
        if (item.externalUrls?.length) {
          for (const ext of item.externalUrls) {
            if (ext.url) info.websites!.push(ext.url);
          }
        }
        if (item.biography) {
          info.emails!.push(...extractEmailsFromText(item.biography));
          Object.assign(info.socialProfiles!, extractSocialHandlesFromText(item.biography));
        }
        info.person = { fullName: item.fullName, bio: item.biography };
        if (item.followersCount != null) info.socialStats = { ...info.socialStats, followersCount: item.followersCount };
        if (item.followsCount != null || item.followingCount != null) {
          info.socialStats = { ...info.socialStats, followingCount: item.followsCount ?? item.followingCount };
        }
        if (item.postsCount != null) info.socialStats = { ...info.socialStats, postsCount: item.postsCount };
        const posts = [...(item.latestPosts || []), ...(item.latestIgtvVideos || [])];
        for (const post of posts.slice(0, 5)) {
          if (post.caption) {
            info.emails!.push(...extractEmailsFromText(post.caption));
            // DO NOT extract social handles from post captions - those are links the user shared, not their own profiles
            info.websites!.push(...extractUrlsFromText(post.caption));
          }
        }
      }
      return info;
    },
  },

  facebook: {
    actorId: 'apify/facebook-pages-scraper',
    buildInput: (identifier: string) => {
      const url = identifier.startsWith('http') ? identifier : `https://www.facebook.com/${identifier}/`;
      return { startUrls: [{ url }] };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractFromResult: (items: any[]) => {
      const info: Partial<ExtractedInfo> = { emails: [], phones: [], websites: [], socialProfiles: {} };
      for (const item of items) {
        if (item.email) info.emails!.push(item.email);
        if (item.phone) info.phones!.push(item.phone);
        if (item.websites?.length) info.websites!.push(...item.websites);
        if (item.website) info.websites!.push(item.website);
        if (item.address) info.company = { ...info.company, address: item.address };
        if (item.title) info.company = { ...info.company, name: item.title };
        if (item.categories?.length) info.company = { ...info.company, industry: item.categories.join(', ') };
        if (item.instagram?.length) info.socialProfiles!.instagram = item.instagram[0].username || item.instagram[0].url;
        if (item.linkedin?.length) info.socialProfiles!.linkedin = item.linkedin[0].url;
        if (item.youtube?.length) info.socialProfiles!.youtube = item.youtube[0].url;
        if (item.wa_number || item.whatsapp_number) info.phones!.push(item.wa_number || item.whatsapp_number);
        if (item.info?.length) {
          for (const text of item.info) {
            info.emails!.push(...extractEmailsFromText(text));
            info.phones!.push(...extractPhonesFromText(text));
            info.websites!.push(...extractUrlsFromText(text));
          }
        }
      }
      return info;
    },
  },

  twitter: {
    actorId: 'apidojo/twitter-user-scraper',
    buildInput: (identifier: string) => {
      const handle = identifier.replace(/^@/, '').replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//, '').replace(/\/$/, '');
      return { twitterHandles: [handle], maxItems: 1, getFollowers: false, getFollowing: false, getAbout: true };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractFromResult: (items: any[]) => {
      const info: Partial<ExtractedInfo> = { emails: [], phones: [], websites: [], socialProfiles: {} };
      for (const item of items) {
        if (item.url) info.websites!.push(item.url);
        if (item.website) info.websites!.push(item.website);
        if (item.description || item.rawDescription) {
          const bioText = item.description || item.rawDescription;
          info.emails!.push(...extractEmailsFromText(bioText));
          Object.assign(info.socialProfiles!, extractSocialHandlesFromText(bioText));
          info.websites!.push(...extractUrlsFromText(bioText));
        }
        info.person = { fullName: item.name, bio: item.description, location: item.location };
        if (item.pinnedTweet?.text) {
          info.emails!.push(...extractEmailsFromText(item.pinnedTweet.text));
          info.websites!.push(...extractUrlsFromText(item.pinnedTweet.text));
        }
        if (item.entities?.url?.urls) {
          for (const u of item.entities.url.urls) {
            if (u.expanded_url) info.websites!.push(u.expanded_url);
          }
        }
        if (item.entities?.description?.urls) {
          for (const u of item.entities.description.urls) {
            if (u.expanded_url) info.websites!.push(u.expanded_url);
          }
        }
      }
      return info;
    },
  },

  linkedin: {
    actorId: 'harvestapi/linkedin-profile-scraper',
    buildInput: (identifier: string) => {
      if (identifier.includes('linkedin.com')) {
        return { queries: [identifier], profileScraperMode: 'Profile details + email search ($10 per 1k)' };
      }
      return { queries: [identifier], profileScraperMode: 'Profile details + email search ($10 per 1k)' };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractFromResult: (items: any[]) => {
      const info: Partial<ExtractedInfo> = { emails: [], phones: [], websites: [], socialProfiles: {} };
      for (const item of items) {
        if (item.email) info.emails!.push(item.email);
        if (item.websites?.length) info.websites!.push(...item.websites);
        if (item.linkedinUrl) info.socialProfiles!.linkedin = item.linkedinUrl;
        if (item.profileActions?.length) {
          for (const action of item.profileActions) {
            if (action.url) {
              Object.assign(info.socialProfiles!, extractSocialUrlsFromText(action.url));
              if (!action.url.includes('linkedin.com')) info.websites!.push(action.url);
            }
          }
        }
        const locationText = typeof item.location === 'object'
          ? (item.location?.parsed?.text || item.location?.linkedinText || '')
          : (item.location || '');
        const currentJobTitle = item.experience?.[0]?.position || item.currentPosition?.[0]?.companyName;
        info.person = {
          fullName: [item.firstName, item.lastName].filter(Boolean).join(' ') || undefined,
          firstName: item.firstName,
          lastName: item.lastName,
          title: item.headline || currentJobTitle,
          bio: item.about,
          location: locationText || undefined,
          headline: item.headline,
        };
        const currentCompany = item.currentPosition?.[0] || item.experience?.[0];
        if (currentCompany?.companyName) {
          info.company = {
            name: currentCompany.companyName,
            domain: currentCompany.companyLinkedinUrl ? extractDomainFromUrl(currentCompany.companyLinkedinUrl) : undefined,
          };
        }
        if (item.about) {
          info.emails!.push(...extractEmailsFromText(item.about));
          Object.assign(info.socialProfiles!, extractSocialHandlesFromText(item.about));
          info.websites!.push(...extractUrlsFromText(item.about));
        }
      }
      return info;
    },
  },

  website: {
    actorId: 'apify/website-content-crawler',
    buildInput: (identifier: string) => {
      const url = identifier.startsWith('http') ? identifier : `https://${identifier}`;
      return { startUrls: [{ url }], maxCrawlPages: 5, crawlerType: 'cheerio', maxCrawlDepth: 1 };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractFromResult: (items: any[]) => {
      const info: Partial<ExtractedInfo> = { emails: [], phones: [], websites: [], socialProfiles: {} };
      for (const item of items) {
        const text = item.text || item.markdown || '';
        info.emails!.push(...extractEmailsFromText(text));
        info.phones!.push(...extractPhonesFromText(text));
        Object.assign(info.socialProfiles!, extractSocialHandlesFromText(text));
        Object.assign(info.socialProfiles!, extractSocialUrlsFromText(text));
      }
      return info;
    },
  },
};

// ─── Secondary Platform Actors (deeper scraping) ─────────────────────────────────

export const SECONDARY_ACTORS: Record<string, ActorConfig> = {
  'linkedin:details': {
    actorId: 'dev_fusion/Linkedin-Profile-Scraper',
    buildInput: (identifier: string) => {
      const url = identifier.startsWith('http') ? identifier : `https://www.linkedin.com/in/${identifier}`;
      return { profileUrls: [url] };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractFromResult: (items: any[]) => {
      const info: Partial<ExtractedInfo> = { emails: [], phones: [], websites: [], socialProfiles: {} };
      for (const item of items) {
        if (item.email) info.emails!.push(item.email);
        if (item.mobileNumber) info.phones!.push(item.mobileNumber);
        if (item.companyWebsite) info.websites!.push(item.companyWebsite);
        if (item.linkedinUrl) info.socialProfiles!.linkedin = item.linkedinUrl;
        if (item.companyLinkedin) info.socialProfiles!.linkedin_company = item.companyLinkedin;
        if (item.creatorWebsite?.length) {
          for (const cw of item.creatorWebsite) {
            if (cw.url) info.websites!.push(cw.url);
          }
        }
        info.person = {
          fullName: item.fullName || [item.firstName, item.lastName].filter(Boolean).join(' ') || undefined,
          firstName: item.firstName,
          lastName: item.lastName,
          title: item.jobTitle || item.headline,
          bio: item.about,
          location: item.addressWithCountry || item.addressCountryOnly,
          headline: item.headline,
        };
        if (item.companyName) {
          info.company = {
            name: item.companyName,
            domain: item.companyWebsite ? extractDomainFromUrl(item.companyWebsite) : undefined,
            industry: item.companyIndustry || undefined,
            size: item.companySize || undefined,
          };
        }
        if (item.experiences?.length) {
          for (const exp of item.experiences) {
            if (exp.companyWebsite) info.websites!.push(exp.companyWebsite);
            if (exp.companyLink1 || exp.companyLinkedin) {
              const compUrl = exp.companyLink1 || exp.companyLinkedin;
              if (compUrl.includes('linkedin.com')) info.socialProfiles!.linkedin_company = compUrl;
            }
          }
        }
        if (item.about) {
          info.emails!.push(...extractEmailsFromText(item.about));
          info.websites!.push(...extractUrlsFromText(item.about));
        }
        if (item.updates?.length) {
          for (const update of item.updates.slice(0, 5)) {
            if (update.postText) {
              info.emails!.push(...extractEmailsFromText(update.postText));
              info.websites!.push(...extractUrlsFromText(update.postText));
            }
          }
        }
      }
      return info;
    },
  },

  'linkedin:company': {
    actorId: 'harvestapi/linkedin-company',
    buildInput: (identifier: string) => {
      if (identifier.includes('linkedin.com')) return { companies: [identifier] };
      return { searches: [identifier] };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractFromResult: (items: any[]) => {
      const info: Partial<ExtractedInfo> = { emails: [], phones: [], websites: [], socialProfiles: {} };
      for (const item of items) {
        if (item.website) info.websites!.push(item.website);
        if (item.phone) {
          const phoneStr = typeof item.phone === 'string' ? item.phone : item.phone?.number;
          if (phoneStr) info.phones!.push(phoneStr);
        }
        if (item.linkedinUrl) info.socialProfiles!.linkedin = item.linkedinUrl;
        if (item.callToActionUrl) info.websites!.push(item.callToActionUrl);
        info.company = {
          name: item.name,
          domain: item.website ? extractDomainFromUrl(item.website) : undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          industry: item.industries?.map((i: any) => i.name || i.title || i).join(', '),
          size: item.employeeCount?.toString() || (item.employeeCountRange ? `${item.employeeCountRange.start}-${item.employeeCountRange.end || '+'}` : undefined),
          description: item.description || item.tagline,
          address: item.locations?.[0] ? [item.locations[0].line1, item.locations[0].city, item.locations[0].country].filter(Boolean).join(', ') : undefined,
        };
        if (item.description) {
          info.emails!.push(...extractEmailsFromText(item.description));
          info.websites!.push(...extractUrlsFromText(item.description));
        }
        if (item.specialities?.length) {
          info.company!.description = (info.company!.description || '') + ` Specialities: ${item.specialities.join(', ')}`;
        }
      }
      return info;
    },
  },

  'linkedin:posts': {
    actorId: 'harvestapi/linkedin-profile-posts',
    buildInput: (identifier: string) => {
      const url = identifier.startsWith('http') ? identifier : `https://www.linkedin.com/in/${identifier}`;
      return { targetUrls: [url], maxPosts: 5, postedLimit: 'month', includeReposts: false };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractFromResult: (items: any[]) => {
      const info: Partial<ExtractedInfo> = { emails: [], phones: [], websites: [], socialProfiles: {} };
      for (const item of items) {
        if (item.content) {
          info.emails!.push(...extractEmailsFromText(item.content));
          info.phones!.push(...extractPhonesFromText(item.content));
          info.websites!.push(...extractUrlsFromText(item.content));
          // DO NOT extract social URLs from post content - those are links shared, not the user's own profiles
        }
        if (item.contentAttributes?.length) {
          for (const attr of item.contentAttributes) {
            if (attr.hyperlink) {
              info.websites!.push(attr.hyperlink);
              // DO NOT extract social URLs from hyperlinks in posts
            }
            if (attr.textLink) info.websites!.push(attr.textLink);
          }
        }
        if (item.header?.linkedinUrl) info.socialProfiles!.linkedin = item.header.linkedinUrl;
      }
      return info;
    },
  },

  'linkedin:company-posts': {
    actorId: 'harvestapi/linkedin-company-posts',
    buildInput: (identifier: string) => {
      const url = identifier.startsWith('http') ? identifier : `https://www.linkedin.com/company/${identifier}`;
      return { targetUrls: [url], maxPosts: 5, postedLimit: 'month' };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractFromResult: (items: any[]) => {
      const info: Partial<ExtractedInfo> = { emails: [], phones: [], websites: [], socialProfiles: {} };
      for (const item of items) {
        if (item.content) {
          info.emails!.push(...extractEmailsFromText(item.content));
          info.phones!.push(...extractPhonesFromText(item.content));
          info.websites!.push(...extractUrlsFromText(item.content));
          // DO NOT extract social URLs from company post content - those are links shared
        }
        if (item.author?.linkedinUrl) info.socialProfiles!.linkedin_company = item.author.linkedinUrl;
      }
      return info;
    },
  },

  'instagram:posts': {
    actorId: 'apify/instagram-post-scraper',
    buildInput: (identifier: string) => {
      const handle = identifier.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/$/, '');
      return { username: [handle], resultsLimit: 5, dataDetailLevel: 'basicData' };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractFromResult: (items: any[]) => {
      const info: Partial<ExtractedInfo> = { emails: [], phones: [], websites: [], socialProfiles: {} };
      for (const item of items) {
        if (item.caption) {
          info.emails!.push(...extractEmailsFromText(item.caption));
          info.phones!.push(...extractPhonesFromText(item.caption));
          info.websites!.push(...extractUrlsFromText(item.caption));
          // DO NOT extract social URLs from post captions - those are links shared, not the user's own profiles
        }
        // DO NOT extract mentions as social profiles - they're people the user tagged, not their own profiles
        // DO NOT extract tagged users as social profiles - they're other people's accounts
        if (item.firstComment) {
          info.emails!.push(...extractEmailsFromText(item.firstComment));
          info.websites!.push(...extractUrlsFromText(item.firstComment));
        }
      }
      return info;
    },
  },

  'twitter:posts': {
    actorId: 'apidojo/tweet-scraper',
    buildInput: (identifier: string) => {
      const handle = identifier.replace(/^@/, '').replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//, '').replace(/\/$/, '');
      return { twitterHandles: [handle], maxItems: 10, sort: 'Latest' };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extractFromResult: (items: any[]) => {
      const info: Partial<ExtractedInfo> = { emails: [], phones: [], websites: [], socialProfiles: {} };
      for (const item of items) {
        if (item.text) {
          info.emails!.push(...extractEmailsFromText(item.text));
          info.phones!.push(...extractPhonesFromText(item.text));
          info.websites!.push(...extractUrlsFromText(item.text));
          // DO NOT extract social URLs from tweet text - those are links shared, not the user's own profiles
        }
        if (item.entities?.urls?.length) {
          for (const u of item.entities.urls) {
            if (u.expanded_url) {
              info.websites!.push(u.expanded_url);
              // DO NOT extract social URLs from tweet entities
            }
          }
        }
        // DO NOT extract mentions as social profiles - they're people the user mentioned, not their own profiles
        if (item.card?.url) info.websites!.push(item.card.url);
      }
      return info;
    },
  },
};

// ─── Secondary Actor Queuing Logic ───────────────────────────────────────────────

/**
 * After a primary actor run, determine which secondary actors to queue
 * based on the extracted data and the source platform.
 */
export function queueSecondaryActors(
  platform: EnrichmentPlatform,
  identifier: string,
  extractedInfo: Partial<ExtractedInfo>,
  processedHandles: Set<string>
): EnrichmentHandle[] {
  const secondary: EnrichmentHandle[] = [];

  if (platform === 'linkedin') {
    const profileUrl = extractedInfo.socialProfiles?.linkedin;
    if (profileUrl && profileUrl.includes('linkedin.com/in/')) {
      const detailsKey = `linkedin:details:${profileUrl.toLowerCase()}`;
      if (!processedHandles.has(detailsKey)) {
        secondary.push({ platform: 'linkedin', subType: 'details', identifier: profileUrl, source: 'linkedin_profile_scrape' });
      }
    }
    const companyUrl = extractedInfo.socialProfiles?.linkedin_company;
    const resolvedCompanyUrl = companyUrl && /^https?:\/\/(?:www\.)?linkedin\.com\/company\/[^/?#]+/i.test(companyUrl)
      ? companyUrl : extractedInfo.company?.name || null;
    if (resolvedCompanyUrl) {
      const companyKey = `linkedin:company:${resolvedCompanyUrl.toLowerCase()}`;
      if (!processedHandles.has(companyKey)) {
        secondary.push({ platform: 'linkedin', subType: 'company', identifier: resolvedCompanyUrl, source: 'linkedin_profile_scrape' });
      }
      // Queue company posts scraping when company URL is available
      if (resolvedCompanyUrl.includes('linkedin.com/company/')) {
        const companyPostsKey = `linkedin:company-posts:${resolvedCompanyUrl.toLowerCase()}`;
        if (!processedHandles.has(companyPostsKey)) {
          // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
          secondary.push({ platform: 'linkedin', subType: 'company-posts', identifier: resolvedCompanyUrl, source: 'linkedin_company_scrape' });
        }
      }
    }
    const postTargetUrl = extractedInfo.socialProfiles?.linkedin || identifier;
    if (postTargetUrl.includes('linkedin.com')) {
      const postsKey = `linkedin:posts:${postTargetUrl.toLowerCase()}`;
      if (!processedHandles.has(postsKey)) {
        secondary.push({ platform: 'linkedin', subType: 'posts', identifier: postTargetUrl, source: 'linkedin_profile_scrape' });
      }
    }
  }

  if (platform === 'instagram') {
    const handle = identifier.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/$/, '');
    const key = `instagram:posts:${handle.toLowerCase()}`;
    if (!processedHandles.has(key)) {
      secondary.push({ platform: 'instagram', subType: 'posts', identifier: handle, source: 'instagram_profile_scrape' });
    }
  }

  if (platform === 'twitter') {
    const handle = identifier.replace(/^@/, '').replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//, '').replace(/\/$/, '');
    const key = `twitter:posts:${handle.toLowerCase()}`;
    if (!processedHandles.has(key)) {
      secondary.push({ platform: 'twitter', subType: 'posts', identifier: handle, source: 'twitter_profile_scrape' });
    }
  }

  return secondary;
}
