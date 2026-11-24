import { z } from "zod";

// Location Schema (for nested location data)
const locationSchema = z.object({
  country: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  address: z.string().optional(),
}).optional();

// Education Schema
const educationSchema = z.object({
  university: z.string().optional(),
  degree: z.string().optional(),
  graduationYear: z.number().optional(),
}).optional();

// Company Headquarters Schema
const companyHeadquartersSchema = z.object({
  hqCountry: z.string().optional(),
  hqState: z.string().optional(),
  hqCity: z.string().optional(),
}).optional();

// Attachment Schema
const attachmentSchema = z.object({
  filename: z.string(),
  url: z.string(),
  type: z.string(),
});

// Base Lead Schema with all 100+ fields from server
export const leadSchema = z.object({
  // 1. Identification
  id: z.union([z.number(), z.string()]).transform(val => typeof val === 'string' ? parseInt(val) : val),
  uuid: z.string().optional(),
  leadCode: z.string().optional(),
  promptId: z.number().nullable().optional(),
  userId: z.number().nullable().optional(),
  
  // Core metadata
  source: z.string(),
  actorId: z.string().optional(),
  leadType: z.string().optional(),
  platformType: z.string().optional(),

  // Business category
  businessCategoryId: z.number().nullable().optional(),
  businessCategoryName: z.string().nullable().optional(),
  businessSubcategoryId: z.number().nullable().optional(),
  businessSubcategoryName: z.string().nullable().optional(),
  
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  deletedAt: z.string().nullable().optional(),
  scrapedAt: z.string().nullable().optional(),
  registeredAt: z.string().nullable().optional(),

  // 2. Personal Information
  name: z.string().nullable().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  fullName: z.string().nullable().optional(),
  middleName: z.string().nullable().optional(),
  gender: z.string().nullable().optional(),
  preferredName: z.string().nullable().optional(),
  profilePicture: z.string().nullable().optional(),
  headline: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  location: locationSchema,
  ageGroup: z.string().nullable().optional(),

  // 3. Contact Details
  email: z.string(),
  emailType: z.string().nullable().optional(),
  emailStatus: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  phoneType: z.string().nullable().optional(),
  phoneCountryCode: z.string().nullable().optional(),
  secondaryPhone: z.string().nullable().optional(),
  whatsapp: z.string().nullable().optional(),
  telegram: z.string().nullable().optional(),
  skype: z.string().nullable().optional(),
  discord: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  calendarLink: z.string().nullable().optional(),

  // 4. Social Profiles
  profileId: z.string().nullable().optional(),
  publicId: z.string().nullable().optional(),
  profileUrl: z.string().nullable().optional(),
  postUrl: z.string().nullable().optional(),
  
  linkedin: z.string().nullable().optional(),
  linkedinUrl: z.string().nullable().optional(),
  linkedinUsername: z.string().nullable().optional(),
  linkedinFollowerCount: z.number().nullable().optional(),
  
  twitter: z.string().nullable().optional(),
  twitterUrl: z.string().nullable().optional(),
  twitterHandle: z.string().nullable().optional(),
  twitterUsername: z.string().nullable().optional(),
  twitterFollowers: z.number().nullable().optional(),
  
  facebook: z.string().nullable().optional(),
  facebookUrl: z.string().nullable().optional(),
  
  instagram: z.string().nullable().optional(),
  instagramUrl: z.string().nullable().optional(),
  instagramHandle: z.string().nullable().optional(),
  
  github: z.string().nullable().optional(),
  youtube: z.string().nullable().optional(),
  youtubeUrl: z.string().nullable().optional(),
  medium: z.string().nullable().optional(),
  tiktok: z.string().nullable().optional(),
  behance: z.string().nullable().optional(),
  dribbble: z.string().nullable().optional(),
  
  // Social metrics
  followersCount: z.number().nullable().optional(),
  followingCount: z.number().nullable().optional(),
  connectionsCount: z.number().nullable().optional(),
  postsCount: z.number().nullable().optional(),
  engagementRate: z.number().nullable().optional(),
  verified: z.boolean().optional(),
  
  // Content metrics
  viewCount: z.number().nullable().optional(),
  likeCount: z.number().nullable().optional(),
  retweetCount: z.number().nullable().optional(),
  replyCount: z.number().nullable().optional(),
  quoteCount: z.number().nullable().optional(),
  videoDuration: z.string().nullable().optional(),

  // 5. Job / Professional Information
  role: z.string().nullable().optional(),
  seniority: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  function: z.string().nullable().optional(),
  yearsOfExperience: z.number().nullable().optional(),
  currentJobStartedAt: z.string().nullable().optional(),
  previousRoles: z.array(z.string()).nullable().optional(),
  skills: z.array(z.string()).nullable().optional(),
  certifications: z.string().nullable().optional(),
  education: educationSchema,

  // 6. Company Information
  company: z.string().nullable().optional(),
  companyName: z.string().nullable().optional(),
  companyLegalName: z.string().nullable().optional(),
  companyDomain: z.string().nullable().optional(),
  companyLinkedin: z.string().nullable().optional(),
  companySize: z.string().nullable().optional(),
  companyRevenue: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  subIndustry: z.string().nullable().optional(),
  companyFoundedYear: z.number().nullable().optional(),
  companyPhone: z.string().nullable().optional(),
  companyEmails: z.array(z.string()).nullable().optional(),
  companyHeadquarters: companyHeadquartersSchema,
  companyLocations: z.array(z.object({ country: z.string(), city: z.string() })).nullable().optional(),
  companyDescription: z.string().nullable().optional(),
  companyTechStack: z.array(z.string()).nullable().optional(),

  // 7. Funding & Financials
  fundingStage: z.string().nullable().optional(),
  totalFunding: z.string().nullable().optional(),
  lastFundingDate: z.string().nullable().optional(),
  investors: z.array(z.string()).nullable().optional(),
  valuation: z.string().nullable().optional(),
  publicCompany: z.boolean().nullable().optional(),
  stockSymbol: z.string().nullable().optional(),

  // 8. Buyer Signals / Intent
  intentScore: z.number().nullable().optional(),
  intentTopics: z.array(z.string()).nullable().optional(),
  websiteVisits: z.number().nullable().optional(),
  adClicks: z.number().nullable().optional(),
  searchKeywords: z.array(z.string()).nullable().optional(),
  recentActivity: z.array(z.object({ activity_type: z.string(), date: z.string() })).nullable().optional(),

  // 9. ICP (Ideal Customer Profile) Fit
  fitScore: z.number().nullable().optional(),
  tier: z.string().nullable().optional(),
  decisionMaker: z.boolean().nullable().optional(),
  budgetRange: z.string().nullable().optional(),
  painPoints: z.array(z.string()).nullable().optional(),
  useCases: z.array(z.string()).nullable().optional(),
  
  // Google Maps specific fields
  address: z.string().nullable().optional(),
  placeId: z.string().nullable().optional(),
  rating: z.number().nullable().optional(),
  reviewCount: z.number().nullable().optional(),
  priceLevel: z.string().nullable().optional(),
  openingHours: z.any().nullable().optional(),
  permanentlyClosed: z.boolean().optional(),
  temporarilyClosed: z.boolean().optional(),
  categories: z.array(z.string()).nullable().optional(),
  googleUrl: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  plusCode: z.string().nullable().optional(),
  
  // Extended Google Maps fields
  googleMapsExtended: z.any().nullable().optional(),
  
  // Profile information
  about: z.string().nullable().optional(),
  photo: z.string().nullable().optional(),
  backgroundImage: z.string().nullable().optional(),
  
  // Status flags
  premium: z.boolean().optional(),
  influencer: z.boolean().optional(),
  openToWork: z.boolean().optional(),
  hiring: z.boolean().optional(),
  
  // Content and engagement data
  postText: z.string().nullable().optional(),
  hashtags: z.array(z.string()).nullable().optional(),
  mediaUrls: z.array(z.string()).nullable().optional(),
  
  // Platform-specific extended data
  platformExtended: z.any().nullable().optional(),
  
  // Lead scoring and quality
  relevanceScore: z.number().nullable().optional(),
  qualityScore: z.number().nullable().optional(),
  leadStatus: z.string().nullable().optional(),
  
  // Search and campaign context
  searchString: z.string().nullable().optional(),
  searchRank: z.number().nullable().optional(),
  campaignData: z.any().nullable().optional(),

  // 11. Engagement Tracking
  status: z.string(),
  lastContactedAt: z.string().nullable().optional(),
  firstContactedAt: z.string().nullable().optional(),
  nextFollowUpAt: z.string().nullable().optional(),
  openedEmails: z.number().optional(),
  clickedLinks: z.number().optional(),
  repliedEmails: z.number().optional(),
  emailSequenceStep: z.number().nullable().optional(),
  smsSent: z.number().optional(),
  linkedinMessagesSent: z.number().optional(),
  notes: z.string().nullable().optional(),

  // 12. Multi-Channel Outreach Fields
  emailSequenceId: z.number().nullable().optional(),
  emailUnsubscribed: z.boolean().optional(),
  connectionRequestSent: z.boolean().optional(),
  connectionAccepted: z.boolean().optional(),
  messagesSent: z.number().optional(),
  messagesReceived: z.number().optional(),
  callAttempts: z.number().optional(),
  callStatus: z.string().nullable().optional(),
  lastCallAt: z.string().nullable().optional(),
  smsReplied: z.boolean().optional(),

  // 13. Tags & Classification
  tags: z.array(z.string()).nullable().optional(),
  priority: z.string().nullable().optional(),
  score: z.number().optional(),

  // 14. Internal Team Metadata
  assignedTo: z.number().nullable().optional(),
  assignedTeam: z.string().nullable().optional(),
  createdBy: z.number().nullable().optional(),
  updatedBy: z.number().nullable().optional(),

  // 15. Attachments / Files
  attachments: z.array(attachmentSchema).nullable().optional(),
  profileSnapshot: z.any().nullable().optional(),

  // 16. Compliance
  gdprConsent: z.boolean().optional(),
  doNotContact: z.boolean().optional(),
  blacklisted: z.boolean().optional(),
  emailVerified: z.boolean().optional(),
  phoneVerified: z.boolean().optional(),

  // 17. System Fields (Automation)
  aiConfidenceScore: z.number().nullable().optional(),
  aiSource: z.string().nullable().optional(),
  aiExtractedFields: z.any().nullable().optional(),
  rawScrapeData: z.any().nullable().optional(),
  enrichedData: z.any().nullable().optional(),
  retryCount: z.number().optional(),
  executionId: z.string().nullable().optional(),
  importBatchId: z.string().nullable().optional(),
  
  // 18. Raw Actor Response Data
  rawData: z.any().nullable().optional(),
});

export type Lead = z.infer<typeof leadSchema>;

