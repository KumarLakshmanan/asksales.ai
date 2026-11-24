import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, text, integer, timestamp, serial, varchar, index, uniqueIndex, jsonb, boolean, real, uuid, decimal } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { campaignsTable } from "../campaigns/schema";
import { icpProfilesTable } from "../icpData/schema";
import { agentExecutionsTable } from "../agentExecutions/schema";
import { postsTable } from "../posts/schema";
import { randomUUID } from "crypto";

// Based on Python Lead model and LEAD.md specification - Complete Lead Data Model

export const leadsTable = pgTable("leads", {
  businessProfileId: businessProfileColumn(),
  // TODO: Consider normalizing JSONB fields (location, education, etc.) into separate tables for better query performance and data integrity.
  // Currently using JSONB for flexibility but this may impact performance at scale.
  // 1. Identification
  id: serial("id").primaryKey(),
  uuid: uuid("uuid").$defaultFn(() => randomUUID()).notNull().unique(),
  leadCode: varchar("lead_code", { length: 50 }),
  promptId: integer("prompt_id").references(() => icpProfilesTable.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  
  // Core metadata (from Python model)
  source: varchar("source", { length: 255 }).notNull(),
  actorId: varchar("actor_id", { length: 255 }),
  leadType: varchar("lead_type", { length: 100 }), // profile, company, post, place, business_page, etc.
  platformType: varchar("platform_type", { length: 100 }), // linkedin, twitter, facebook, instagram, google_maps
  
  // Business category classification (from the generating business profile)
  businessCategoryId: integer("business_category_id"),
  businessCategoryName: varchar("business_category_name", { length: 255 }),
  businessSubcategoryId: integer("business_subcategory_id"),
  businessSubcategoryName: varchar("business_subcategory_name", { length: 255 }),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
  scrapedAt: timestamp("scraped_at"),
  registeredAt: timestamp("registered_at"),

  // 2. Personal Information (kept 'name' for backward compatibility)
  name: text("name"), // Legacy field, will be replaced by firstName + lastName
  firstName: varchar("first_name", { length: 255 }),
  lastName: varchar("last_name", { length: 255 }),
  fullName: text("full_name"),
  middleName: varchar("middle_name", { length: 255 }),
  gender: varchar("gender", { length: 50 }),
  preferredName: varchar("preferred_name", { length: 255 }),
  profilePicture: text("profile_picture"),
  headline: text("headline"), // LinkedIn headline
  bio: text("bio"), // Twitter/X bio
  language: varchar("language", { length: 100 }),
  timezone: varchar("timezone", { length: 255 }),
  location: jsonb("location").$type<{ country?: string; state?: string; city?: string; address?: string }>(),
  ageGroup: varchar("age_group", { length: 50 }),

  // 3. Contact Details
  email: text("email"), // Made optional for leads without email (e.g., Instagram profiles)
  emailType: varchar("email_type", { length: 20 }), // work/personal
  emailStatus: varchar("email_status", { length: 20 }), // valid/invalid/unverified
  phone: text("phone"),
  phoneType: varchar("phone_type", { length: 20 }), // mobile/office
  phoneCountryCode: varchar("phone_country_code", { length: 10 }),
  secondaryPhone: text("secondary_phone"),
  whatsapp: text("whatsapp"),
  telegram: text("telegram"),
  skype: text("skype"),
  discord: text("discord"),
  website: text("website"),
  calendarLink: text("calendar_link"), // Calendly, etc.

  // 4. Social Profiles (Enhanced from Python model)
  profileId: varchar("profile_id", { length: 255 }), // Platform-specific ID
  publicId: varchar("public_id", { length: 255 }), // LinkedIn public identifier
  profileUrl: text("profile_url"), // General profile URL
  postUrl: text("post_url"), // URL of the post that led to this lead
  sourcePostId: integer("source_post_id").references(() => postsTable.id, { onDelete: "set null" }), // FK to the post that generated this lead
  engagementType: varchar("engagement_type", { length: 100 }), // How lead was discovered: like, comment, retweet, follow, share, author, search, etc.
  
  linkedin: text("linkedin"),
  linkedinUrl: text("linkedin_url"),
  linkedinUsername: varchar("linkedin_username", { length: 255 }),
  linkedinFollowerCount: integer("linkedin_follower_count"),
  
  twitter: text("twitter"),
  twitterUrl: text("twitter_url"),
  twitterHandle: varchar("twitter_handle", { length: 255 }),
  twitterUsername: varchar("twitter_username", { length: 255 }),
  twitterFollowers: integer("twitter_followers"),
  
  facebook: text("facebook"),
  facebookUrl: text("facebook_url"),
  
  instagram: text("instagram"),
  instagramUrl: text("instagram_url"),
  instagramHandle: varchar("instagram_handle", { length: 255 }),

  
  github: text("github"),
  youtube: text("youtube"),
  youtubeUrl: text("youtube_url"),
  medium: text("medium"),
  tiktok: text("tiktok"),
  behance: text("behance"),
  dribbble: text("dribbble"),
  
  // Social metrics (consolidated from Python model)
  followersCount: integer("followers_count"),
  followingCount: integer("following_count"),
  connectionsCount: integer("connections_count"), // LinkedIn connections
  postsCount: integer("posts_count"),
  engagementRate: decimal("engagement_rate", { precision: 5, scale: 2 }), // Percentage
  verified: boolean("verified").default(false),
  
  // Content metrics (from Python model)
  viewCount: integer("view_count"),
  likeCount: integer("like_count"),
  retweetCount: integer("retweet_count"),
  replyCount: integer("reply_count"),
  quoteCount: integer("quote_count"),
  videoDuration: varchar("video_duration", { length: 20 }),

  // 5. Job / Professional Information
  role: text("role"), // job title (kept for backward compatibility)
  seniority: varchar("seniority", { length: 100 }), // C-level, VP, Director, Manager, IC
  department: varchar("department", { length: 255 }),
  function: varchar("function", { length: 255 }), // Marketing, Sales, Engineering
  yearsOfExperience: integer("years_of_experience"),
  currentJobStartedAt: timestamp("current_job_started_at"),
  previousRoles: jsonb("previous_roles").$type<string[]>(),
  skills: jsonb("skills").$type<string[]>(),
  certifications: text("certifications"),
  education: jsonb("education").$type<{ university?: string; degree?: string; graduationYear?: number }>(),

  // 6. Company Information (kept 'company' for backward compatibility)
  company: text("company"), // Legacy field
  companyName: text("company_name"),
  companyLegalName: text("company_legal_name"),
  companyDomain: text("company_domain"),
  companyLinkedin: text("company_linkedin"),
  companySize: varchar("company_size", { length: 100 }), // employees
  companyRevenue: varchar("company_revenue", { length: 255 }),
  industry: varchar("industry", { length: 255 }),
  subIndustry: varchar("sub_industry", { length: 255 }),
  companyFoundedYear: integer("company_founded_year"),
  companyPhone: text("company_phone"),
  companyEmails: jsonb("company_emails").$type<string[]>(),
  companyHeadquarters: jsonb("company_headquarters").$type<{ hqCountry?: string; hqState?: string; hqCity?: string }>(),
  companyLocations: jsonb("company_locations").$type<Array<{ country: string; city: string }>>(),
  companyDescription: text("company_description"),
  companyTechStack: jsonb("company_tech_stack").$type<string[]>(),

  // 7. Funding & Financials
  fundingStage: varchar("funding_stage", { length: 100 }), // Seed, Series A, B, etc.
  totalFunding: varchar("total_funding", { length: 255 }),
  lastFundingDate: timestamp("last_funding_date"),
  investors: jsonb("investors").$type<string[]>(),
  valuation: varchar("valuation", { length: 255 }),
  publicCompany: boolean("public_company"),
  stockSymbol: varchar("stock_symbol", { length: 20 }),

  // 8. Buyer Signals / Intent
  intentScore: integer("intent_score"),
  intentTopics: jsonb("intent_topics").$type<string[]>(),
  websiteVisits: integer("website_visits"),
  adClicks: integer("ad_clicks"),
  searchKeywords: jsonb("search_keywords").$type<string[]>(),
  recentActivity: jsonb("recent_activity").$type<Array<{ activity_type: string; date: string }>>(),

  // 9. ICP (Ideal Customer Profile) Fit
  fitScore: integer("fit_score"),
  tier: varchar("tier", { length: 50 }), // Tier 1/2/3
  decisionMaker: boolean("decision_maker"),
  budgetRange: varchar("budget_range", { length: 255 }),
  painPoints: jsonb("pain_points").$type<string[]>(),
  useCases: jsonb("use_cases").$type<string[]>(),
  
  // Google Maps specific fields (from Python model)
  address: text("address"),
  placeId: varchar("place_id", { length: 255 }),
  rating: decimal("rating", { precision: 3, scale: 2 }), // 0.00 to 5.00
  reviewCount: integer("review_count"),
  priceLevel: varchar("price_level", { length: 10 }),
  openingHours: jsonb("opening_hours"),
  permanentlyClosed: boolean("permanently_closed").default(false),
  temporarilyClosed: boolean("temporarily_closed").default(false),
  categories: jsonb("categories").$type<string[]>(),
  googleUrl: text("google_url"),
  imageUrl: text("image_url"),
  plusCode: varchar("plus_code", { length: 50 }),
  
  // Extended Google Maps fields (stored as JSON for flexibility)
  googleMapsExtended: jsonb("google_maps_extended"),
  
  // Profile information (from Python model)
  about: text("about"), // About/bio text
  photo: text("photo"), // Profile photo URL
  backgroundImage: text("background_image"), // Background image URL
  
  // Status flags (from Python model)
  premium: boolean("premium").default(false),
  influencer: boolean("influencer").default(false),
  openToWork: boolean("open_to_work").default(false),
  hiring: boolean("hiring").default(false),
  
  // Content and engagement data (from Python model)
  postText: text("post_text"),
  hashtags: jsonb("hashtags").$type<string[]>(),
  mediaUrls: jsonb("media_urls").$type<string[]>(),
  
  // Platform-specific extended data (stored as JSON)
  platformExtended: jsonb("platform_extended"),
  
  // Lead scoring and quality (from Python model)
  relevanceScore: integer("relevance_score"), // 0-100
  qualityScore: integer("quality_score"), // 0-100
  leadStatus: varchar("lead_status", { length: 50 }).default('new'), // new, contacted, qualified, converted, rejected
  
  // Search and campaign context (from Python model)
  searchString: varchar("search_string", { length: 255 }), // Search query used
  searchRank: integer("search_rank"), // Search result rank
  campaignData: jsonb("campaign_data"), // Campaign-specific data

  // 11. Engagement Tracking
  status: varchar("status", { length: 50 }).notNull(),
  lastActivityAt: timestamp("last_activity_at"),
  lastContactedAt: timestamp("last_contacted_at"),
  firstContactedAt: timestamp("first_contacted_at"),
  nextFollowUpAt: timestamp("next_follow_up_at"),
  openedEmails: integer("opened_emails").default(0),
  clickedLinks: integer("clicked_links").default(0),
  repliedEmails: integer("replied_emails").default(0),
  emailSequenceStep: integer("email_sequence_step"),
  smsSent: integer("sms_sent").default(0),
  linkedinMessagesSent: integer("linkedin_messages_sent").default(0),
  notes: text("notes"),

  // 12. Multi-Channel Outreach Fields
  emailSequenceId: integer("email_sequence_id"),
  emailUnsubscribed: boolean("email_unsubscribed").default(false),
  connectionRequestSent: boolean("connection_request_sent").default(false),
  connectionAccepted: boolean("connection_accepted").default(false),
  messagesSent: integer("messages_sent").default(0),
  messagesReceived: integer("messages_received").default(0),
  callAttempts: integer("call_attempts").default(0),
  callStatus: varchar("call_status", { length: 50 }),
  lastCallAt: timestamp("last_call_at"),
  smsReplied: boolean("sms_replied").default(false),

  // 13. Tags & Classification
  tags: jsonb("tags").$type<string[]>(),
  priority: varchar("priority", { length: 20 }), // low/medium/high
  score: integer("score").notNull().default(0),
  leadScore: integer("lead_score").default(0),
  icpScore: integer("icp_score").default(0),

  // 14. Internal Team Metadata
  assignedTo: integer("assigned_to").references(() => usersTable.id, { onDelete: "set null" }), // user ID
  assignedTeam: varchar("assigned_team", { length: 255 }),
  createdBy: integer("created_by"),
  updatedBy: integer("updated_by"),

  // 15. Attachments / Files (stored as JSONB references)
  attachments: jsonb("attachments").$type<Array<{ filename: string; url: string; type: string }>>(),
  profileSnapshot: jsonb("profile_snapshot"), // raw scraped HTML/JSON

  // 16. Compliance
  gdprConsent: boolean("gdpr_consent").default(false),
  doNotContact: boolean("do_not_contact").default(false),
  blacklisted: boolean("blacklisted").default(false),
  emailVerified: boolean("email_verified").default(false),
  phoneVerified: boolean("phone_verified").default(false),

  // 17. System Fields (Automation)
  aiConfidenceScore: real("ai_confidence_score"),
  aiSource: varchar("ai_source", { length: 255 }),
  aiExtractedFields: jsonb("ai_extracted_fields"),
  rawScrapeData: jsonb("raw_scrape_data"),
  enrichedData: jsonb("enriched_data"),
  retryCount: integer("retry_count").default(0),
  // Execution linking
  executionId: uuid("execution_id").references(() => agentExecutionsTable.id, { onDelete: "set null" }),
  importBatchId: varchar("import_batch_id", { length: 255 }),
  
  // 18. Raw Actor Response Data
  rawData: jsonb("raw_data"), // Complete raw response from Apify actors for future re-mapping
}, (table) => ({
  // Primary indexes
  // emailIdx: uniqueIndex("leads_email_idx").on(table.email), // REMOVED: Allow duplicate emails
  uuidIdx: uniqueIndex("leads_uuid_idx").on(table.uuid),
  
  // Status and engagement indexes
  statusIdx: index("leads_status_idx").on(table.status),
  leadTypeIdx: index("leads_lead_type_idx").on(table.leadType),
  priorityIdx: index("leads_priority_idx").on(table.priority),
  
  // Company and industry indexes
  companyIndustryIdx: index("leads_company_industry_idx").on(table.companyName, table.industry),
  industryIdx: index("leads_industry_idx").on(table.industry),
  companySizeIdx: index("leads_company_size_idx").on(table.companySize),
  
  // Source and campaign indexes
  sourceIdx: index("leads_source_idx").on(table.source),
  campaignIdx: index("leads_campaign_idx").on(table.campaignData),
  platformIdx: index("leads_platform_idx").on(table.platformType),
  sourcePostIdIdx: index("leads_source_post_id_idx").on(table.sourcePostId),
  engagementTypeIdx: index("leads_engagement_type_idx").on(table.engagementType),
  
  // Engagement indexes
  emailStatusIdx: index("leads_email_status_idx").on(table.emailStatus),
  nextFollowUpIdx: index("leads_next_followup_idx").on(table.nextFollowUpAt),
  lastContactedIdx: index("leads_last_contacted_idx").on(table.lastContactedAt),
  
  // ICP fit indexes
  fitScoreIdx: index("leads_fit_score_idx").on(table.fitScore),
  tierIdx: index("leads_tier_idx").on(table.tier),
  
  // Team assignment indexes
  assignedToIdx: index("leads_assigned_to_idx").on(table.assignedTo),
  userIdIdx: index("leads_user_id_idx").on(table.userId),
  promptIdIdx: index("leads_prompt_id_idx").on(table.promptId),
  
  // Time-based indexes
  createdAtIdx: index("leads_created_at_idx").on(table.createdAt),
  scrapedAtIdx: index("leads_scraped_at_idx").on(table.scrapedAt),
  
  // Compliance indexes
  doNotContactIdx: index("leads_do_not_contact_idx").on(table.doNotContact),
  blacklistedIdx: index("leads_blacklisted_idx").on(table.blacklisted),
  
  // Composite indexes for common queries
  companyRoleIdx: index("leads_company_role_idx").on(table.companyName, table.role),
  executionIdIdx: index("leads_execution_id_idx").on(table.executionId),
  sourceStatusIdx: index("leads_source_status_idx").on(table.source, table.status),
  
  // Google Maps specific indexes
  placeIdIdx: index("leads_place_id_idx").on(table.placeId),
  ratingIdx: index("leads_rating_idx").on(table.rating),
  
  // Social media handles indexes
  twitterHandleIdx: index("leads_twitter_handle_idx").on(table.twitterHandle),
  instagramHandleIdx: index("leads_instagram_handle_idx").on(table.instagramHandle),
  
  // Lead type and platform indexes
  leadTypePlatformIdx: index("leads_lead_type_platform_idx").on(table.leadType, table.platformType),
  
  // Quality score indexes
  relevanceScoreIdx: index("leads_relevance_score_idx").on(table.relevanceScore),
  qualityScoreIdx: index("leads_quality_score_idx").on(table.qualityScore),

  // Phase 3.4: GIN indexes on JSONB columns to accelerate `?` / `?|` / `@>` lookups
  locationGin: index("leads_location_gin").using("gin", table.location),
  previousRolesGin: index("leads_previous_roles_gin").using("gin", table.previousRoles),
  skillsGin: index("leads_skills_gin").using("gin", table.skills),
  tagsGin: index("leads_tags_gin").using("gin", table.tags),
  campaignDataGin: index("leads_campaign_data_gin").using("gin", table.campaignData),
  platformExtendedGin: index("leads_platform_extended_gin").using("gin", table.platformExtended),
  rawDataGin: index("leads_raw_data_gin").using("gin", table.rawData),
  enrichedDataGin: index("leads_enriched_data_gin").using("gin", table.enrichedData),
  intentTopicsGin: index("leads_intent_topics_gin").using("gin", table.intentTopics),
  searchKeywordsGin: index("leads_search_keywords_gin").using("gin", table.searchKeywords),
}));

export type LeadRecord = typeof leadsTable.$inferSelect;
export type InsertLead = typeof leadsTable.$inferInsert;
