/**
 * Routes Index — Central route module registration
 * 
 * Replaces the monolithic routes.ts with domain-specific route modules.
 * Each module is responsible for its own rate limiting and validation.
 */

export { default as authRoutes } from './auth.routes.js';
export { default as leadsRoutes } from './leads.routes.js';
export { default as enrichmentsRoutes } from './enrichments.routes.js';
export { default as contentRoutes } from './content.routes.js';
export { default as chatRoutes } from './chat.routes.js';
export { default as outreachRoutes } from './outreach.routes.js';
export { default as campaignsRoutes } from './campaigns.routes.js';
export { default as settingsRoutes } from './settings.routes.js';
export { default as adminRoutes } from './admin.routes.js';
export { default as walletRoutes } from './wallet.routes.js';
export { default as embeddingsRoutes } from './embeddings.routes.js';
export { default as crmRoutes } from './crm.routes.js';
export { default as supportRoutes } from './support.routes.js';
export { default as supportMemberRoutes } from './supportMember.routes.js';
export { default as supportWidgetRoutes } from './supportWidget.routes.js';
export { default as supportMediaDeliveryRoutes } from './supportMediaDelivery.routes.js';
export { default as proposalsRoutes } from './proposals.routes.js';
export { default as legalRoutes } from './legal.routes.js';
export { default as platformRoutes } from './platform.routes.js';
export { default as aiVisibilityRoutes } from './aiVisibility.routes.js';
export { default as providerVerificationRoutes } from './providerVerification.routes.js';
