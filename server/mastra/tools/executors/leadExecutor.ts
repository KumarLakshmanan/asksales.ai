/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Lead Generation Tool Executors
 * Handles lead input generation and workflow execution
 * 
 * Uses a SCHEMA-DRIVEN approach: actor JSON files in data/actors/ are the single
 * source of truth for input/output schemas. The LLM generates inputs based on
 * these schemas dynamically — no hardcoded field definitions needed.
 */

import pathModule from 'path';
import { readLeadSaveReceipt } from '../../utils/leadSaveReceipt.js';
import fs from 'fs/promises';
import type { ToolContext } from '../toolRegistry.js';
import type { ToolResult } from '../../state';
import { logger } from '../../../utils/logger.js';
import { isProviderResponseError, LLMProviderResponseError } from '../../../services/agents/LLMProviderErrors.js';
import {
  resolveActorsDir,
  resolveWorkflowPath,
  resolveWorkflowsDir,
} from '../../../utils/dataPathResolver.js';
import { TAB_TYPES, TAB_LABELS } from '../../tabConfig';
import {
  applyProviderMinimumFetchLimits,
  applyLeadIntentToFallbackInputs,
  preserveGeneratedLeadInputs,
  applyRequestedLeadLimit,
  applyRequestedLeadLimitToBatch,
  extractExplicitTargetLocation,
  resolveLeadLimitRequirements,
  resolveOriginalLeadInputRequest,
  applyFacebookCompetitorPageUrls,
  FacebookCompetitorPageUrlsRequiredError,
} from './leadRequestConstraints.js';
import { toNumber } from './executorValues.js';
import { userFacingReason } from '../../../../shared/userFacingError.js';
import { findLeadActorsWithoutKey, LeadProviderUnavailableError } from '../../../services/apifyCredentialResolver.js';

export const stoppedThreads = new Set<number>();

// ─── Dynamic Platform Alias Map ─────────────────────────────────────────────────
// Auto-built from discovered workflow files. "google" → "google_maps", "linkedin posts" → "linkedin_post_search", etc.
let _platformAliasMap: Record<string, string> | null = null;

function buildPlatformAliasMap(platformIds: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  // Static aliases that can't be derived from filenames
  const staticAliases: Record<string, string> = {
    'google': 'google_maps',
    'google maps': 'google_maps',
    'googlemaps': 'google_maps',
    // Historical actor/node name for the canonical LinkedIn Profile Search workflow.
    'linkedin_profile_search': 'linkedin',
  };
  Object.assign(map, staticAliases);

  for (const id of platformIds) {
    // Identity: "linkedin" → "linkedin"
    map[id] = id;
    // Space variant: "linkedin_post_search" → "linkedin post search" → "linkedin_post_search"
    const spaced = id.replace(/_/g, ' ');
    if (spaced !== id) map[spaced] = id;

    // Short aliases: e.g. "linkedin_post_search" → "linkedin posts"
    // Derived from base platform + last segment pluralised
    const parts = id.split('_');
    if (parts.length >= 2) {
      const base = parts[0]; // e.g. "linkedin"
      const rest = parts.slice(1).join('_'); // e.g. "post_search"
      // "linkedin posts" for "linkedin_post_search"
      if (rest.endsWith('_search')) {
        const noun = rest.replace(/_search$/, '');
        map[`${base} ${noun}s`] = id;
        map[`${base}_${noun}s`] = id;
      }
      // "linkedin employees" for "linkedin_company_employees"
      if (rest.includes('_')) {
        const lastPart = parts[parts.length - 1];
        map[`${base} ${lastPart}`] = id;
      }
      // "linkedin competitors" for "linkedin_competitor_*"
      if (rest.startsWith('competitor')) {
        map[`${base} competitors`] = id;
      }
    }
  }
  return map;
}

// Map ICP channel names to workflow platform names (dynamically built)
function normalizePlatformName(platform: string): string {
  const normalized = platform.toLowerCase().trim();
  if (_platformAliasMap) {
    if (_platformAliasMap[normalized]) return _platformAliasMap[normalized];
    // Fallback: strip common LLM-hallucinated suffixes (_b2b, _b2c, _search, _scraper)
    // and try matching the base name
    const stripped = normalized.replace(/_(b2b|b2c|search|scraper|scraping)$/g, '');
    if (stripped !== normalized) {
      if (_platformAliasMap[stripped]) return _platformAliasMap[stripped];
      if (_validPlatformsCache?.has(stripped)) return stripped;
    }
  }
  // Fallback before alias map is built
  return normalized;
}

export function inferExplicitWorkflowIds(
  userRequirements: string | undefined,
  availableWorkflowIds: Iterable<string>,
): string[] {
  if (!userRequirements?.trim()) return [];

  const normalizedRequest = userRequirements
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalizedRequest) return [];

  return Array.from(availableWorkflowIds)
    .filter((workflowId) => workflowId.includes('_'))
    .sort((left, right) => right.length - left.length)
    .filter((workflowId) => {
      const normalizedId = workflowId.toLowerCase().replace(/_/g, ' ');
      const matchIndex = normalizedRequest.indexOf(normalizedId);
      if (matchIndex < 0) return false;
      const prefix = normalizedRequest.slice(Math.max(0, matchIndex - 40), matchIndex);
      return !/\b(?:do not|dont|never|avoid|without|instead of)\s+(?:use|using)?\s*$/.test(prefix);
    });
}

export function inferExplicitCatalogWorkflowId(
  userRequirements: string | undefined,
  workflows: Array<{ fileName: string; workflowId: string; title: string }>,
): string | undefined {
  if (!userRequirements?.trim()) return undefined;
  const request = userRequirements.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!request) return undefined;

  const isAffirmed = (phrase: string): boolean => {
    let from = 0;
    while (from < request.length) {
      const matchIndex = request.indexOf(phrase, from);
      if (matchIndex < 0) return false;
      const prefix = request.slice(Math.max(0, matchIndex - 48), matchIndex);
      if (!/\b(?:do not|dont|never|avoid|without|instead of)\s+(?:use|using)?\s*$/.test(prefix)) return true;
      from = matchIndex + phrase.length;
    }
    return false;
  };

  const matches = workflows.flatMap((workflow) => {
    const aliases = [workflow.title, workflow.fileName, workflow.workflowId]
      .map(value => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
      .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
    const bestAlias = aliases.filter(isAffirmed).sort((left, right) => right.length - left.length)[0];
    return bestAlias ? [{ workflow, matchedLength: bestAlias.length }] : [];
  }).sort((left, right) => right.matchedLength - left.matchedLength);

  return matches[0]?.workflow.fileName;
}

// ─── Dynamic Platform Discovery ─────────────────────────────────────────────────
// Scans data/workflows/*.json to discover all available platforms.
// No hardcoded platform lists — new workflow files are auto-discovered.
let _validPlatformsCache: Set<string> | null = null;

async function getValidPlatforms(): Promise<Set<string>> {
  if (_validPlatformsCache) return _validPlatformsCache;
  const fsSync = await import('fs');
  const workflowsDir = resolveWorkflowsDir();
  const platforms = new Set<string>();
  
  try {
    // Scan main workflow files: data/workflows/*.json
    if (fsSync.existsSync(workflowsDir)) {
      const files = fsSync.readdirSync(workflowsDir).filter((f: string) => f.endsWith('.json') && !f.startsWith('.'));
      for (const file of files) {
        const name = file.replace('.json', '');
        platforms.add(name);
        // Channels remain selectable after their overlapping all-in-one bundle is retired.
        platforms.add(name.startsWith('google_maps') ? 'google_maps' : name.split('_')[0]);
      }
    }
  } catch (e) {
    logger.warn({ err: e }, '[Lead Executor] Could not scan workflows dir');
  }
  
  // Build the dynamic alias map from discovered platforms
  _platformAliasMap = buildPlatformAliasMap(Array.from(platforms));
  
  _validPlatformsCache = platforms;
  logger.info({ count: platforms.size, platforms: Array.from(platforms) }, '[Lead Executor] Discovered platforms dynamically');
  return platforms;
}

// ─── Dynamic Actor Schema Loader ────────────────────────────────────────────────
// Loads actor input/output schemas from JSON files in data/actors/ by actorId.
// Handles both schema formats: { input: {...} } and { inputSchema: { properties: {...} } }

interface NormalizedActorSchema {
  actorId: string;
  description: string;
   
  inputProperties: Record<string, any>;
  requiredFields: string[];
   
  outputProperties: Record<string, any>;
}

const _actorSchemaCache = new Map<string, NormalizedActorSchema>();
let _actorSchemasLoaded = false;

async function loadAllActorSchemas(): Promise<void> {
  if (_actorSchemasLoaded) return;
  
  const fsSync = await import('fs');
  const actorsDir = resolveActorsDir();
  
  if (!fsSync.existsSync(actorsDir)) {
    _actorSchemasLoaded = true;
    return;
  }
  
  const files = fsSync.readdirSync(actorsDir).filter((f: string) => f.endsWith('.json'));
  
  for (const file of files) {
    try {
      const content = fsSync.readFileSync(pathModule.join(actorsDir, file), 'utf-8');
      const actor = JSON.parse(content);
      const actorId = actor.actorId || actor.id;
      if (!actorId) continue;
      
       
      let inputProperties: Record<string, any> = {};
      let requiredFields: string[] = [];
       
      let outputProperties: Record<string, any> = {};
      
      // Handle format: { input: { field1: {...}, field2: {...} } }
      if (actor.input && typeof actor.input === 'object' && !actor.input.properties) {
        inputProperties = actor.input;
        requiredFields = Object.entries(actor.input)
           
          .filter(([_, v]: [string, any]) => v.required === true)
           
          .map(([k]: [string, any]) => k);
      }
      // Handle format: { inputSchema: { properties: {...}, required: [...] } }
      else if (actor.inputSchema?.properties) {
        inputProperties = actor.inputSchema.properties;
        requiredFields = actor.inputSchema.required || [];
      }
      
      // Handle output formats similarly
      if (actor.output && typeof actor.output === 'object' && !actor.output.properties) {
        outputProperties = actor.output;
      } else if (actor.outputSchema?.properties) {
        outputProperties = actor.outputSchema.properties;
      }
      
      _actorSchemaCache.set(actorId, {
        actorId,
        description: actor.description || actor.title || '',
        inputProperties,
        requiredFields,
        outputProperties,
      });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      // skip invalid files
    }
  }
  
  _actorSchemasLoaded = true;
  logger.info({ count: _actorSchemaCache.size }, '[Lead Executor] Loaded actor schemas from data/actors/');
}

function getActorSchema(actorId: string): NormalizedActorSchema | undefined {
  return _actorSchemaCache.get(actorId);
}

function collectWorkflowTemplateFields(value: unknown, fields: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
      fields.add(match[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectWorkflowTemplateFields(entry, fields));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>)
      .forEach((entry) => collectWorkflowTemplateFields(entry, fields));
  }
}

/**
 * Build the reviewed-input contract for an entire workflow, not just its first
 * actor. Composite workflows expose user-controlled placeholders on downstream
 * actors (for example jobTitles on company employee extraction); those values
 * must be generated, persisted, and reviewed before execution as well.
 */
export async function buildReviewedWorkflowActorSchema(
  workflow: Record<string, any>,
): Promise<NormalizedActorSchema | undefined> {
  await loadAllActorSchemas();
  const actorNodes = (workflow.nodes || []).filter((node: any) => node.type === 'actor');
  const firstActorId = actorNodes[0]?.data?.actorId;
  const firstSchema = firstActorId ? getActorSchema(firstActorId) : undefined;
  if (!firstSchema) return undefined;

  const inputProperties = { ...firstSchema.inputProperties };
  const requiredFields = new Set(firstSchema.requiredFields);
  const descriptions = new Set([firstSchema.description].filter(Boolean));

  for (const node of actorNodes.slice(1)) {
    const actorSchema = getActorSchema(node.data?.actorId);
    if (!actorSchema) continue;
    if (actorSchema.description) descriptions.add(actorSchema.description);

    for (const [actorField, mapping] of Object.entries(node.data?.inputMapping || {})) {
      const placeholders = new Set<string>();
      collectWorkflowTemplateFields(mapping, placeholders);
      for (const placeholder of placeholders) {
        const property = actorSchema.inputProperties[actorField]
          || actorSchema.inputProperties[placeholder];
        if (!property) continue;
        if (!Object.hasOwn(inputProperties, placeholder)) inputProperties[placeholder] = property;
        if (actorSchema.requiredFields.includes(actorField)) requiredFields.add(placeholder);
      }
    }
  }

  return {
    ...firstSchema,
    description: Array.from(descriptions).join('\n'),
    inputProperties,
    requiredFields: Array.from(requiredFields),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function coerceScalarToSchemaType(value: unknown, type: unknown): any {
  if (type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) return String(value);
  if ((type === 'integer' || type === 'number') && typeof value === 'string') {
    // parseInt keeps the long-standing "25 leads" -> 25 behaviour; text with no number stays as-is.
    const parsed = type === 'integer' ? parseInt(value, 10) : parseFloat(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}

/**
 * Bring model-generated values to the types the actor schema declares. Models
 * often return LinkedIn ID filters as numbers (120) where the actor expects
 * strings ("120"); left alone they fail enum validation and the actor input.
 */
export function coerceActorInputTypes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entry: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  const coerced = { ...entry };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const [key, propSchema] of Object.entries(inputSchema) as [string, any][]) {
    if (!(key in coerced)) continue;
    let val = coerced[key];
    if (propSchema.type === 'array' && typeof val === 'string') {
      val = val.split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    if (propSchema.type === 'array' && Array.isArray(val) && propSchema.items?.type) {
      val = val.map((item: unknown) => coerceScalarToSchemaType(item, propSchema.items.type));
    }
    if (propSchema.type === 'string' && Array.isArray(val)) val = val.join(', ');
    if (propSchema.type === 'integer' || propSchema.type === 'number' || propSchema.type === 'string') {
      val = coerceScalarToSchemaType(val, propSchema.type);
    }
    if (propSchema.type === 'boolean' && typeof val !== 'boolean') {
      val = val === 'true' || val === true || val === 1 || val === '1';
    }
    coerced[key] = val;
  }
  return coerced;
}

/**
 * Validate a set of generated inputs against the actor's schema and platform constraints.
 */
export function validateActorInputsAgainstSchema(
  actorId: string,
   
  inputs: Record<string, any>,
   
  inputSchema: Record<string, any>,
  requiredFields: string[]
): string[] {
  const errors: string[] = [];

  // 1. Check required fields from schema
  for (const field of requiredFields) {
    const val = inputs[field];
    if (val === undefined || val === null) {
      errors.push(`Missing required field: "${field}"`);
    } else if (Array.isArray(val) && val.length === 0) {
      errors.push(`Required array field "${field}" is empty`);
    } else if (typeof val === 'string' && val.trim() === '') {
      errors.push(`Required string field "${field}" is empty`);
    }
  }

  // 2. Check types and constraints for each field present in inputs
   
  for (const [key, propSchema] of Object.entries(inputSchema) as [string, any][]) {
    if (!(key in inputs)) continue;
    const val = inputs[key];
    if (val === undefined || val === null) continue;

    // Type check
    if (propSchema.type === 'array' && !Array.isArray(val)) {
      errors.push(`Field "${key}" should be an array, got ${typeof val}`);
    }
    if (propSchema.type === 'string' && typeof val !== 'string') {
      errors.push(`Field "${key}" should be a string, got ${typeof val}`);
    }
    if ((propSchema.type === 'integer' || propSchema.type === 'number') && typeof val !== 'number') {
      errors.push(`Field "${key}" should be a number, got ${typeof val}`);
    }
    if (propSchema.type === 'boolean' && typeof val !== 'boolean') {
      errors.push(`Field "${key}" should be a boolean, got ${typeof val}`);
    }

    // Enum check (enum values are compared after coerceActorInputTypes, so a
    // model's 120 and the schema's "120" are the same choice).
    if (propSchema.enum && !propSchema.enum.includes(val)) {
      errors.push(`Field "${key}" value "${val}" not in allowed values: ${propSchema.enum.join(', ')}`);
    }
    if (typeof val === 'string' && typeof propSchema.pattern === 'string' && !new RegExp(propSchema.pattern).test(val)) {
      errors.push(`Field "${key}" value "${val}" does not match required pattern: ${propSchema.pattern}`);
    }

    // Min/Max for numbers
    if (typeof val === 'number') {
      if (propSchema.minimum !== undefined && val < propSchema.minimum) {
        errors.push(`Field "${key}" value ${val} is below minimum ${propSchema.minimum}`);
      }
      if (propSchema.maximum !== undefined && val > propSchema.maximum) {
        errors.push(`Field "${key}" value ${val} exceeds maximum ${propSchema.maximum}`);
      }
    }

    // Min/Max items for arrays
    if (Array.isArray(val)) {
      if (propSchema.items?.type === 'object') {
        val.forEach((item, index) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            errors.push(`Field "${key}.${index}" should be an object`);
            return;
          }
          for (const requiredItemField of propSchema.items.required || []) {
            if (item[requiredItemField] === undefined || item[requiredItemField] === null || item[requiredItemField] === '') {
              errors.push(`Field "${key}.${index}.${requiredItemField}" is required`);
            }
          }
        });
      }
      if (Array.isArray(propSchema.items?.enum)) {
        val.forEach((item, index) => {
          if (!propSchema.items.enum.includes(item)) {
            errors.push(`Field "${key}.${index}" value "${item}" not in allowed values: ${propSchema.items.enum.join(', ')}`);
          }
        });
      }
      if (propSchema.minItems !== undefined && val.length < propSchema.minItems) {
        errors.push(`Field "${key}" needs at least ${propSchema.minItems} item(s), got ${val.length}`);
      }
      if (propSchema.maxItems !== undefined && val.length > propSchema.maxItems) {
        errors.push(`Field "${key}" exceeds max ${propSchema.maxItems} items, got ${val.length}`);
      }
    }
  }

  // 3. Platform-specific / Actor-specific constraints
  const normalizedActorId = actorId.toLowerCase();
  
  if (normalizedActorId.includes('linkedin')) {
    const hasCompanyTargets = Array.isArray(inputs.companies)
      && inputs.companies.some(value => typeof value === 'string' && value.trim());
    const companyEmployeeSearch = normalizedActorId === 'harvestapi/linkedin-company-employees';
    const optionalLocationFilter = companyEmployeeSearch
      || normalizedActorId === 'harvestapi/linkedin-profile-search-by-name';
    if (companyEmployeeSearch && !hasCompanyTargets) {
      errors.push('LinkedIn company employee search requires company URLs');
    }
    if (normalizedActorId === 'harvestapi/linkedin-company') {
      const hasTargets = ['companies', 'searches'].some(field =>
        Array.isArray(inputs[field]) && inputs[field].some(value => typeof value === 'string' && value.trim()));
      if (!hasTargets) errors.push('LinkedIn company details requires company URLs or company names');
    }
    if ('locations' in inputs) {
      if (!Array.isArray(inputs.locations)) {
        errors.push('LinkedIn filter error: "locations" must be an array');
      } else if (inputs.locations.length === 0 && !optionalLocationFilter) {
        errors.push('LinkedIn filter error: "locations" array must not be empty');
      }
    }
    if ('currentJobTitles' in inputs && !Array.isArray(inputs.currentJobTitles)) {
      errors.push('LinkedIn filter error: "currentJobTitles" must be an array');
    }
    if ('searchQueries' in inputs) {
      if (!Array.isArray(inputs.searchQueries)) {
        errors.push('LinkedIn filter error: "searchQueries" must be an array');
      } else if (inputs.searchQueries.length === 0) {
        errors.push('LinkedIn filter error: "searchQueries" must not be empty');
      }
    }
    if ('searchQuery' in inputs && (!inputs.searchQuery || inputs.searchQuery.trim() === '')) {
      const hasFilters = (Array.isArray(inputs.currentJobTitles) && inputs.currentJobTitles.length > 0)
        || (Array.isArray(inputs.locations) && inputs.locations.length > 0)
        || (Array.isArray(inputs.seniorityLevelIds) && inputs.seniorityLevelIds.length > 0)
        || (companyEmployeeSearch && hasCompanyTargets);
      if (!hasFilters) {
        errors.push('LinkedIn filter error: "searchQuery" must not be empty unless currentJobTitles, locations, or seniorityLevelIds are provided');
      }
    }
  } else if (
    normalizedActorId.includes('google-places') ||
    normalizedActorId.includes('crawler-google-places') ||
    normalizedActorId.includes('google-maps-places') ||
    normalizedActorId.includes('google-maps-scraper')
  ) {
    if ('searchStringsArray' in inputs) {
      if (!Array.isArray(inputs.searchStringsArray)) {
        errors.push('Google Maps filter error: "searchStringsArray" must be an array');
      } else if (inputs.searchStringsArray.length === 0) {
        errors.push('Google Maps filter error: "searchStringsArray" must not be empty');
      }
    }
    if ('locationQuery' in inputs) {
      if (typeof inputs.locationQuery === 'string' && inputs.locationQuery.trim() === '') {
        errors.push('Google Maps filter error: "locationQuery" must not be empty');
      } else if (Array.isArray(inputs.locationQuery) && inputs.locationQuery.length === 0) {
        errors.push('Google Maps filter error: "locationQuery" must not be empty');
      }
    }
  } else if (normalizedActorId.includes('justdial')) {
    const hasUrls = Array.isArray(inputs.startUrls) && inputs.startUrls.some(value => typeof value === 'string' && value.trim());
    const hasCitySearch = typeof (inputs.city || inputs.location) === 'string' && (inputs.city || inputs.location).trim()
      && typeof inputs.search === 'string' && inputs.search.trim();
    if (!hasUrls && !hasCitySearch) errors.push('JustDial requires city and search, or verified startUrls');
    if ('location' in inputs && (typeof inputs.location !== 'string' || inputs.location.trim() === '')) {
      errors.push('JustDial filter error: "location" must be a non-empty string');
    }
    if (!hasUrls && 'search' in inputs && (typeof inputs.search !== 'string' || inputs.search.trim() === '')) {
      errors.push('JustDial filter error: "search" must be a non-empty string');
    }
    if ('maxItems' in inputs) {
      const maxItems = Number(inputs.maxItems);
      if (isNaN(maxItems) || maxItems < 1 || maxItems > 1000) {
        errors.push('JustDial filter error: "maxItems" must be a number between 1 and 1000');
      }
    }
  } else if (normalizedActorId.includes('instagram')) {
    if ('usernames' in inputs) {
      if (!Array.isArray(inputs.usernames)) {
        errors.push('Instagram filter error: "usernames" must be an array');
      } else if (inputs.usernames.length === 0) {
        errors.push('Instagram filter error: "usernames" must not be empty');
      }
    }
    if ('username' in inputs) {
      if (!Array.isArray(inputs.username)) {
        errors.push('Instagram filter error: "username" must be an array');
      } else if (inputs.username.length === 0) {
        errors.push('Instagram filter error: "username" must not be empty');
      }
    }
    if ('hashtags' in inputs) {
      if (!Array.isArray(inputs.hashtags)) {
        errors.push('Instagram filter error: "hashtags" must be an array');
      } else if (inputs.hashtags.length === 0) {
        errors.push('Instagram filter error: "hashtags" must not be empty');
      }
    }
  }

  return errors;
}

// ─── Workflow finalValues Support ───────────────────────────────────────────────
// Each workflow JSON can declare `finalValues` on its first actor node.
// These are system/technical fields with constant defaults that should NOT be
// sent to the LLM for generation. After LLM generates user-specific inputs,
// finalValues are merged in — they always take priority (hence "final").
// This reduces LLM prompt size, token usage, and prevents hallucinated values.

/**
 * Apply workflow finalValues to generated inputs.
 * finalValues always override — they represent fixed values the user should not change.
 */
function applyFinalValues(
   
  inputs: Record<string, any>,
   
  finalValues: Record<string, any>,
 
): Record<string, any> {
  return { ...inputs, ...finalValues };
}

/**
 * Optional provider fields that the model emits as null/blank are absent
 * settings, not reviewable parameters. Remove them before persistence so the
 * approval card and eventual actor input contain only what the user reviewed.
 * Keep false, zero, and empty arrays because those can be intentional values.
 */
export function stripEmptyGeneratedInputs(
  inputs: Record<string, any>,
): Record<string, any> {
  return Object.fromEntries(Object.entries(inputs).filter(([, value]) => (
    value !== null
    && value !== undefined
    && !(typeof value === 'string' && value.trim() === '')
  )));
}

// ─── Dynamic Field Documentation Builder ────────────────────────────────────────
// Generates LLM-readable field documentation from an actor's input schema.
// This replaces the hardcoded APIFY_ACTOR_REFERENCE fields.

function buildFieldDocFromSchema(schema: NormalizedActorSchema, excludeFields?: Set<string>): string {
  const lines: string[] = [];
  
  for (const [key, prop] of Object.entries(schema.inputProperties)) {
    // Skip system default fields — they are auto-applied, no need for LLM to generate them
    if (excludeFields && excludeFields.has(key)) continue;

    const type = prop.type || 'string';
    const isRequired = schema.requiredFields.includes(key) || prop.required === true;
    const reqLabel = isRequired ? ' [REQUIRED]' : '';
    const desc = (prop.description || prop.title || '').substring(0, 200);
    
    const extras: string[] = [];
    if (prop.default !== undefined) extras.push(`Default: ${JSON.stringify(prop.default)}`);
    if (prop.prefill !== undefined) extras.push(`Prefill: ${JSON.stringify(prop.prefill)}`);
    if (prop.enum) extras.push(`Enum: ${JSON.stringify(prop.enum)}`);
    if (prop.example) extras.push(`Example: ${JSON.stringify(prop.example)}`);
    if (prop.minimum !== undefined) extras.push(`Min: ${prop.minimum}`);
    if (prop.maximum !== undefined) extras.push(`Max: ${prop.maximum}`);
    if (prop.maxItems !== undefined) extras.push(`MaxItems: ${prop.maxItems}`);
    
    const extrasStr = extras.length > 0 ? `. ${extras.join('. ')}` : '';
    lines.push(`  - ${key} (${type}${reqLabel}): ${desc}${extrasStr}`);
  }
  
  return lines.join('\n');
}

/**
 * Preserve an explicitly reviewed enum choice instead of allowing the input LLM
 * to silently replace it with an actor default. This is intentionally limited
 * to phrases that name both the field and value (for example, "search type
 * People") so an enum value mentioned elsewhere in the request is not treated
 * as approval.
 */
export function applyExplicitEnumRequirements(
  inputs: Record<string, any>,
  inputSchema: Record<string, any>,
  userRequirements?: string,
): Record<string, any> {
  if (!userRequirements?.trim()) return inputs;

  const normalizedRequirements = userRequirements
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalizedRequirements) return inputs;

  const result = applyExplicitEmptyRequirements(inputs, inputSchema, userRequirements);
  for (const [fieldName, schema] of Object.entries(inputSchema) as [string, any][]) {
    if (!Array.isArray(schema?.enum) || schema.enum.length === 0) continue;

    const aliases = new Set<string>();
    aliases.add(fieldName.toLowerCase());
    aliases.add(fieldName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase());
    if (typeof schema.title === 'string' && schema.title.trim()) {
      aliases.add(schema.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    }

    // Prefer the longest enum label so "Full" cannot swallow "Full + email search".
    const enumValues = [...schema.enum].sort((a, b) => String(b).length - String(a).length);
    for (const enumValue of enumValues) {
      if (typeof enumValue !== 'string') continue;
      const normalizedValue = enumValue.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!normalizedValue) continue;

      const explicitlyRequested = Array.from(aliases).some((alias) => {
        if (!alias) return false;
        const pattern = new RegExp(`\\b${alias.replace(/ /g, '\\s+')}\\b(?:\\s+(?:of|to|is|should\\s+be))?\\s+${normalizedValue.replace(/ /g, '\\s+')}\\b`);
        return pattern.test(normalizedRequirements);
      });
      if (explicitlyRequested) {
        result[fieldName] = enumValue;
        break;
      }
    }
  }

  return result;
}

/** Preserve explicitly named empty optional filters; never infer clearing from vague prose. */
export function applyExplicitEmptyRequirements(
  inputs: Record<string, any>, inputSchema: Record<string, any>, userRequirements?: string,
): Record<string, any> {
  const result = { ...inputs };
  if (!userRequirements) return result;
  for (const [field, schema] of Object.entries(inputSchema)) {
    if (schema?.required === true || !['array', 'string'].includes(schema?.type)) continue;
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const emptyValue = schema.type === 'array' ? '\\[\\s*\\]' : '(?:"\\s*"|\'\\s*\')';
    const pattern = new RegExp(`\\b${escaped}\\b["']?\\s*(?::|=|is|to)?\\s*(?:${emptyValue}|empty\\b)`, 'i');
    if (pattern.test(userRequirements)) result[field] = schema.type === 'array' ? [] : '';
  }
  return result;
}

/**
 * Preserve explicitly labelled primitive and array actor inputs after LLM
 * generation. This deliberately accepts only field-adjacent JSON-like values;
 * unrelated prose must never become an approved provider parameter.
 */
export function applyExplicitTypedRequirements(
  inputs: Record<string, any>,
  inputSchema: Record<string, any>,
  userRequirements?: string,
): Record<string, any> {
  const result = { ...inputs };
  if (!userRequirements?.trim()) return result;

  const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [fieldName, schema] of Object.entries(inputSchema) as [string, any][]) {
    const aliases = Array.from(new Set([
      fieldName,
      fieldName.replace(/([a-z0-9])([A-Z])/g, '$1 $2'),
    ])).sort((a, b) => b.length - a.length);
    const fieldPattern = aliases.map(alias => escapePattern(alias).replace(/\s+/g, '\\s+')).join('|');
    const prefix = `(?:["']?(?:${fieldPattern})["']?)\\s*(?:(?:is|to|should\\s+be)\\s*|[:=]\\s*|\\s+)`;

    if (schema?.type === 'array') {
      const match = userRequirements.match(new RegExp(`${prefix}(\\[[^\\]\\r\\n]*\\])`, 'i'));
      if (!match) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(match[1]);
      } catch {
        try {
          parsed = JSON.parse(match[1].replace(/'/g, '"'));
        } catch {
          continue;
        }
      }
      if (Array.isArray(parsed)) result[fieldName] = parsed;
      continue;
    }

    if (schema?.type === 'boolean') {
      const match = userRequirements.match(new RegExp(`${prefix}(true|false)\\b`, 'i'));
      if (match) result[fieldName] = match[1].toLowerCase() === 'true';
      continue;
    }

    if (schema?.type === 'string' && !Array.isArray(schema?.enum)) {
      const match = userRequirements.match(new RegExp(`${prefix}("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`, 'i'));
      if (!match) continue;
      try {
        result[fieldName] = match[1].startsWith('"')
          ? JSON.parse(match[1])
          : match[1].slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      } catch {
        // A malformed quoted value is not an approval to replace the generated field.
      }
      continue;
    }

    if (schema?.type === 'integer' || schema?.type === 'number') {
      const match = userRequirements.match(new RegExp(`${prefix}(-?\\d+(?:\\.\\d+)?)\\b`, 'i'));
      if (!match) continue;
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && (schema.type !== 'integer' || Number.isSafeInteger(parsed))) {
        result[fieldName] = parsed;
      }
    }
  }

  return result;
}

// ─── Platform-Specific LLM Tips ─────────────────────────────────────────────────
// Tips are loaded dynamically from workflow JSON files (`"tips"` field).
// This fallback map handles platforms whose workflow files don't yet include tips.
// As tips are migrated into workflow files, entries here can be removed.

const PLATFORM_TIPS_FALLBACK: Record<string, string> = {
  google_maps: `- searchStringsArray items should be "<business category> in <city/region>" format for best results.
- locationQuery should match the target city/region from the ICP.
- Keep maxCrawledPlacesPerSearch between 10-50 for reasonable results.
- MULTIPLE SEARCHES: When the ICP targets 3 or more distinct business categories (e.g., "restaurants", "cafes", "hotels"),
  generate MULTIPLE search inputs wrapped in a "searches" array, e.g.:
  { "searches": [
      { "searchStringsArray": ["restaurants in Mumbai"], "locationQuery": "Mumbai", "maxCrawledPlacesPerSearch": 30 },
      { "searchStringsArray": ["cafes in Mumbai"], "locationQuery": "Mumbai", "maxCrawledPlacesPerSearch": 30 },
      { "searchStringsArray": ["hotels in Mumbai"], "locationQuery": "Mumbai", "maxCrawledPlacesPerSearch": 30 }
    ] }
  Split by business category so each search is focused and produces clean results.
  For 1-2 categories, return a single flat JSON object without the "searches" wrapper.`,

  linkedin: `- NEVER use OR operators in searchQuery for job titles (e.g., "CFO OR CTO OR VP" is WRONG).
  Instead, put all target titles in the currentJobTitles array: ["CFO", "CTO", "VP Engineering"]
- searchQuery should be a single broad role keyword or left empty when using currentJobTitles.
- currentJobTitles is the MOST EFFECTIVE filter — always use it with an array of ICP decision-maker titles.
- locations should use full, official names (LinkedIn resolves via autocomplete).
- Use seniorityLevelIds to target decision-makers (e.g., "220" for Director+, "300" for VP, "310" for CXO).
- MULTIPLE SEARCHES: When the ICP targets 6 or more distinct job titles across different seniority levels
  or functions, generate MULTIPLE search inputs wrapped in a "searches" array, e.g.:
  { "searches": [
      { "currentJobTitles": ["CEO","CFO","COO"], "seniorityLevelIds": ["310"], "locations": [...], "maxItems": 20 },
      { "currentJobTitles": ["VP Sales","VP Marketing","VP Engineering"], "seniorityLevelIds": ["300"], "locations": [...], "maxItems": 20 },
      { "currentJobTitles": ["Director IT","Head of Product"], "seniorityLevelIds": ["220"], "locations": [...], "maxItems": 20 }
    ] }
  Split by seniority tier (C-suite vs VP vs Director) or by function (technical vs commercial vs operations).
  Keep each search to 3-4 titles maximum for best match quality.
- For simple ICPs (1-5 titles), return a single flat JSON object without the "searches" wrapper.`,

  instagram: `- Hashtags should be relevant to the ICP industry AND location.
- Mix location-specific hashtags (e.g., "mumbairestaurants") with generic ones (e.g., "foodbusiness").
- Keep resultsLimit between 10-50 for reasonable scraping time.
- Do NOT use spaces in hashtags — combine words: "digitalmarketing" not "digital marketing".
- MULTIPLE SEARCHES: When the ICP spans multiple distinct audience segments or industries (e.g., B2B targeting
  both "food industry" and "fashion industry"), generate MULTIPLE search inputs:
  { "searches": [
      { "hashtags": ["foodbusiness", "restaurantowner", "mumbairestaurant"], "resultsLimit": 25 },
      { "hashtags": ["fashionbrand", "fashionbusiness", "clothingbrand"], "resultsLimit": 25 }
    ] }
  Each entry should have a distinct, focused hashtag cluster. Split by industry sector or audience type.
  For single-segment ICPs, return a flat JSON object without "searches".`,

  facebook: `- query should be specific business keywords or industry terms from the ICP.
- Include location in the query for local businesses: "restaurants New York".
- Keep maxResults between 10-30.
- MULTIPLE SEARCHES: When targeting multiple business types or distinct market segments, use multiple searches:
  { "searches": [
      { "query": "restaurant owners Mumbai", "maxResults": 20 },
      { "query": "cafe owners Mumbai", "maxResults": 20 }
    ] }
  For single business categories, return a flat JSON object without "searches".`,

  twitter: `- query should match ICP industry keywords or target audience interests.
- Use "People" searchType when looking for profiles rather than posts.
- Keep maxResults between 10-30.
- MULTIPLE SEARCHES: When targeting audiences with different interest themes, use multiple searches:
  { "searches": [
      { "query": "restaurant owner entrepreneur", "searchType": "People", "maxResults": 20 },
      { "query": "food business startup founder", "searchType": "People", "maxResults": 20 }
    ] }
  Split by audience interest cluster or professional topic. For single-theme ICPs, return flat JSON.`,

  justdial: `- JustDial is an INDIA-ONLY directory. For category search, "city" MUST be an Indian city name and "search" a simple business category.
- Alternatively, use "startUrls" containing only verified JustDial URLs supplied by the user. For URL-only requests, OMIT city and search entirely; do not derive them from the ICP or URL.
- Preserve explicit requested maxItems and global caps, including 1. Only suggest 20-100 when no limit was requested.
- If the ICP targets businesses outside India, do NOT use JustDial.`,

  linkedin_company_employees: `- companies MUST be full LinkedIn company URLs (e.g., "https://www.linkedin.com/company/google").
- Use jobTitles to target specific roles from the ICP decision-maker list.
- Use seniorityLevelIds to filter by seniority (220=Director, 300=VP, 310=CXO).
- This is ideal when you know TARGET COMPANIES and want to find specific people there.
- Generate MULTIPLE entries if targeting 3+ companies, one per company.`,

  linkedin_post_search: `- searchQueries should be industry-specific topics related to the ICP.
- Use authorKeywords to filter for posts by people matching the ICP roles.
- This is ideal for CONTENT-BASED lead discovery — finding people who discuss topics relevant to your offering.
- Keep maxPosts between 10-30 for reasonable results.
- Use postedLimit "month" for recent, relevant content.`,

  facebook_post_search: `- "query" should contain ICP-relevant business keywords, product category, or pain points (e.g., "SaaS for HR teams").
- Keep maxResults between 20-50.
- This finds people actively posting about your topic area — ideal for engagement-based leads.
- When targeting multiple industries or topics, generate MULTIPLE search entries with separate queries:
  { "searches": [ { "query": "HR software tools", "maxResults": 30 }, { "query": "employee management app", "maxResults": 30 } ] }`,

  facebook_competitor_pages: `- "startUrls" MUST be request objects containing full Facebook page URLs (e.g., [{ "url": "https://www.facebook.com/CompetitorBrand" }]).
- These should be DIRECT COMPETITOR pages whose followers match your ICP audience.
- Start with a small resultsLimit because each page can have many followers.
- The page's Followers section must be publicly visible without Facebook login.`,

  instagram_post_search: `- "hashtags" should be an array of industry/niche hashtags WITHOUT the # symbol (e.g., ["saas", "hrtech", "startup"]).
- Keep resultsLimit between 20-50.
- Choose hashtags that your ICP audience actively uses, not just generic ones.
- When ICP spans multiple segments, generate MULTIPLE search entries with different hashtag clusters:
  { "searches": [ { "hashtags": ["saas", "b2bsoftware"], "resultsLimit": 30 }, { "hashtags": ["hrtech", "peopleops"], "resultsLimit": 30 } ] }`,

  instagram_competitor_profiles: `- "usernames" must be an array of competitor Instagram handles WITHOUT the @ symbol (e.g., ["hubspot", "salesforce"]).
- Provide 3-10 competitor handles whose audience closely matches your ICP.
- This scrapes full profile data (bio, followers count, contact info) useful for competitor intelligence.`,

  twitter_post_search: `- "query" should be a Twitter search query using ICP-relevant keywords, hashtags, or phrases (e.g., "B2B sales automation").
- "searchType" should be "People" to find user profiles, or "Top" to find popular posts.
- Keep maxResults between 20-50.
- For targeting multiple themes, generate MULTIPLE search entries:
  { "searches": [ { "query": "SaaS sales tools", "searchType": "People", "maxResults": 30 }, { "query": "#salestech founder", "searchType": "Top", "maxResults": 30 } ] }`,

  twitter_competitor_users: `- "searchTerms" should contain concise public brand names or industry terms, not a sentence combining role, industry and location.
- This searches profile names/bios; it does not find followers or apply a geographic filter.
- The provider requires a minimum fetch budget of 5. Keep the final saved-lead cap separately and enforce geography on actual profile evidence.
- Never invent competitor handles or silently broaden and rerun an empty search.`,
};

// ─── Dynamic Tips Loader ────────────────────────────────────────────────────────
// Loads "tips" field from workflow JSON files, falling back to PLATFORM_TIPS_FALLBACK.
const _platformTipsCache = new Map<string, string>();
let _platformTipsLoaded = false;

async function loadPlatformTips(): Promise<void> {
  if (_platformTipsLoaded) return;
  
  const fsSync = await import('fs');
  const workflowsDir = resolveWorkflowsDir();
  
  // Load tips from main workflow files
  const scanDir = (dir: string) => {
    if (!fsSync.existsSync(dir)) return;
    const files = fsSync.readdirSync(dir).filter((f: string) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = fsSync.readFileSync(pathModule.join(dir, file), 'utf-8');
        const workflow = JSON.parse(content);
        if (workflow.tips) {
          const platformKey = file.replace('.json', '');
          _platformTipsCache.set(platformKey, workflow.tips);
        }
      } catch { /* skip */ }
    }
  };
  
  scanDir(workflowsDir);
  
  // Merge fallback tips for any platforms not yet covered by workflow files
  for (const [key, tips] of Object.entries(PLATFORM_TIPS_FALLBACK)) {
    if (!_platformTipsCache.has(key)) {
      _platformTipsCache.set(key, tips);
    }
  }
  
  _platformTipsLoaded = true;
  logger.info({ count: _platformTipsCache.size }, '[Lead Executor] Loaded platform tips');
}

function getPlatformTips(platform: string): string {
  return _platformTipsCache.get(platform) || PLATFORM_TIPS_FALLBACK[platform] || '';
}

/**
 * Resets all platform caches so they get reloaded on the next call.
 * Useful when workflow files or actor schemas are updated at runtime.
 */
export function clearPlatformCaches(): void {
  _validPlatformsCache = null;
  _platformAliasMap = null;
  _actorSchemaCache.clear();
  _actorSchemasLoaded = false;
  _platformTipsCache.clear();
  _platformTipsLoaded = false;
  logger.info('[Lead Executor] All platform caches cleared');
}

// APIFY_ACTOR_REFERENCE is now built dynamically from actor JSON schemas.
// See loadAllActorSchemas(), buildFieldDocFromSchema(), and tips loading above.

// ─── Channel Workflow Loader ─────────────────────────────────────────────────
// Loads all workflow files for a given base channel (e.g., "linkedin") with metadata
// for LLM-based workflow selection.
interface WorkflowSummary {
  workflowId: string;
  fileName: string;
  title: string;
  description: string;
  category: string; // Human-readable extraction category
  platform: string;
  firstActorId?: string;
  firstActorName?: string;
}

async function getChannelWorkflows(baseChannel: string): Promise<WorkflowSummary[]> {
  const fsSync = await import('fs');
  const workflowsDir = resolveWorkflowsDir();
  const workflows: WorkflowSummary[] = [];

  if (!fsSync.existsSync(workflowsDir)) return workflows;

  const files = fsSync.readdirSync(workflowsDir).filter((f: string) => f.endsWith('.json') && !f.startsWith('.'));

  for (const file of files) {
    // Match files that start with the base channel name (e.g., "linkedin", "linkedin_company_search", etc.)
    const baseName = file.replace('.json', '');
    const fileBase = baseName.split('_')[0];
    if (fileBase !== baseChannel) continue;

    try {
      const filePath = pathModule.join(workflowsDir, file);
      const content = fsSync.readFileSync(filePath, 'utf-8');
      const workflow = JSON.parse(content);
       
      const firstActorNode = workflow.nodes?.find((n: any) => n.type === 'actor');

      workflows.push({
        workflowId: workflow.workflow_id || baseName,
        fileName: baseName,
        title: workflow.title || baseName,
        description: workflow.description || '',
        category: workflow.title || baseName, // Use title as category
        platform: workflow.platform || baseName,
        firstActorId: firstActorNode?.data?.actorId,
        firstActorName: firstActorNode?.data?.actorName || firstActorNode?.data?.label,
      });
    } catch { /* skip invalid files */ }
  }

  return workflows;
}

// ─── LLM Workflow Selector ──────────────────────────────────────────────────────
// Uses LLM to select the best matching workflows for a channel based on ICP and user requirements.
async function selectBestWorkflows(
  channel: string,
  workflows: WorkflowSummary[],
   
  icpProfile: any,
  userRequirements: string | undefined,
   
  llmProvider: any,
  context: { userId: string; threadId: string }
): Promise<WorkflowSummary[]> {
  if (workflows.length <= 1) return workflows;

  const workflowList = workflows.map((w, i) => `${i + 1}. **${w.title}** (id: "${w.fileName}")\n   ${w.description}`).join('\n');

  const response = await llmProvider.createChatCompletion({
    model: llmProvider.defaultModel,
    messages: [
      {
        role: 'system',
        content: `You are an expert at selecting the best lead extraction workflows for a given business ICP (Ideal Customer Profile).
Given a list of available workflows for the "${channel}" channel, select the workflows that would produce the most relevant leads based on the ICP.
Return a JSON object with a "selectedWorkflows" array containing the "id" (fileName) values of the selected workflows, ordered by relevance.
USER REQUIREMENTS describe this search and override the ICP wherever they differ (location, audience, size). Select 1-2 workflows maximum. Choosing just 1 primary workflow is strongly preferred to keep the campaign simple and focused. Only select 2 if they are highly complementary and directly relevant to different aspects of the ICP.
Each selected workflow will generate a SEPARATE lead input entry, so pick workflows with different extraction strategies.`
      },
      {
        role: 'user',
        content: `ICP:\n${JSON.stringify(icpProfile, null, 2)}\n\n${userRequirements ? `USER REQUIREMENTS: "${userRequirements}"\n\n` : ''}AVAILABLE WORKFLOWS for ${channel}:\n${workflowList}\n\nSelect the best matching workflows. Return JSON: { "selectedWorkflows": ["workflow_id_1", "workflow_id_2"] }`
      }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
    loggingContext: {
      userId: context.userId,
      threadId: context.threadId,
      purpose: 'workflow_selection',
      service: 'LeadExecutor',
      action: 'select_best_workflows',
    },
  });

  if (response.success && response.content) {
    try {
      let raw = response.content.trim();
      raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      const parsed = JSON.parse(raw);
      const selectedIds: string[] = parsed.selectedWorkflows || [];

      if (selectedIds.length > 0) {
        const selected = selectedIds
          .map(id => workflows.find(w => w.fileName === id || w.workflowId === id))
          .filter((w): w is WorkflowSummary => w !== undefined);

        if (selected.length > 0) {
          logger.info({ channel, selected: selected.map(w => w.title) }, '[Lead Executor] LLM selected workflows');
          return selected;
        }
      }
    } catch (e) {
      logger.warn({ err: e, channel }, '[Lead Executor] Failed to parse workflow selection response');
    }
  }

  // Fallback: return the base workflow (first one, which is the main platform workflow)
  logger.warn({ channel }, '[Lead Executor] Workflow selection failed, falling back to base workflow');
  return [workflows[0]];
}

// ─── List Available Workflows for Channels ─────────────────────────────────────
// Public function for the list_available_workflows tool.
// Returns a structured list of all available workflows per channel.
export async function listWorkflowsForChannels(
  platforms: string[]
): Promise<{ success: boolean; workflows: Record<string, Array<{ id: string; title: string; description: string; category: string }>> }> {
  const result: Record<string, Array<{ id: string; title: string; description: string; category: string }>> = {};

  for (const platform of platforms) {
    const baseChannel = platform.split('_')[0].toLowerCase();
    const channelWorkflows = await getChannelWorkflows(baseChannel);
    result[baseChannel] = channelWorkflows.map(w => ({
      id: w.fileName,
      title: w.title,
      description: w.description,
      category: w.category,
    }));
  }

  return { success: true, workflows: result };
}

/**
 * True when no lead search for these channels has a data provider key, so the
 * chat can say so before offering a strategy. A failed check returns false.
 */
export async function noLeadProviderForChannels(userId: number | undefined, channels: string[]): Promise<boolean> {
  try {
    const baseChannels = [...new Set(channels.map(channel => String(channel).split('_')[0].toLowerCase()).filter(Boolean))];
    const workflows = (await Promise.all(baseChannels.map(channel => getChannelWorkflows(channel)))).flat();
    const actorIds = workflows.map(workflow => workflow.firstActorId).filter((id): id is string => Boolean(id));
    if (actorIds.length === 0) return false;
    const missing = await findLeadActorsWithoutKey(userId, actorIds);
    return actorIds.every(id => missing.has(id));
  } catch (error) {
    logger.warn({ err: error }, '[Lead Executor] Could not check lead data provider keys; offering strategies as usual');
    return false;
  }
}

/** Resolve only exact catalog names; never guess a replacement strategy. */
export async function resolveCatalogWorkflowIds(names: string[], validPlatforms: Set<string>): Promise<string[]> {
  const channels = [...new Set([...validPlatforms].map(name => name.split('_')[0]))];
  const catalog = await listWorkflowsForChannels(channels);
  const entries = Object.values(catalog.workflows).flat();
  return names.map(name => {
    const normalized = normalizePlatformName(name);
    if (validPlatforms.has(normalized)) return normalized;
    const matches = entries.filter(entry => entry.title.trim().toLowerCase() === name.trim().toLowerCase());
    return matches.length === 1 ? matches[0].id : normalized;
  });
}

export async function recommendWorkflowsForChannels(
  platforms: string[],
   
  icpProfile: any,
  userRequirements: string | undefined,
  context: { userId: string | number; threadId: string | number },
): Promise<{
  success: boolean;
  recommendations: Record<string, {
    id: string;
    title: string;
    description: string;
    category: string;
    matchPercentage: number;
    reason: string;
    /** True when no ranking was made and the channel's first strategy was used. */
    fallback?: boolean;
    /** True when the channel has exactly one saved workflow, so nothing was ranked. */
    onlyOption?: boolean;
  } | null>;
}> {
  const { LLMProviderFactory } = await import('../../../services/agents/LLMProviderFactory');
   
  let llmProvider: any = null;
  try {
    llmProvider = await LLMProviderFactory.createProviderForUser(toNumber(context.userId));
  } catch (error) {
    logger.warn({ err: error }, '[Lead Executor] LLM provider unavailable for workflow recommendation, using fallback');
  }
  const recommendations: Record<string, {
    id: string;
    title: string;
    description: string;
    category: string;
    matchPercentage: number;
    reason: string;
    /** True when no ranking was made and the channel's first strategy was used. */
    fallback?: boolean;
    /** True when the channel has exactly one saved workflow, so nothing was ranked. */
    onlyOption?: boolean;
  } | null> = {};

  for (const platform of platforms) {
    const baseChannel = platform.split('_')[0].toLowerCase();
    const channelWorkflows = await getChannelWorkflows(baseChannel);

    if (channelWorkflows.length === 0) {
      recommendations[baseChannel] = null;
      continue;
    }

    if (channelWorkflows.length === 1) {
      const workflow = channelWorkflows[0];
      recommendations[baseChannel] = {
        id: workflow.fileName,
        title: workflow.title,
        description: workflow.description,
        category: workflow.category,
        matchPercentage: 100,
        reason: 'This is the only saved workflow currently available for this channel.',
        onlyOption: true,
      };
      continue;
    }

    const explicitlyNamedWorkflowId = inferExplicitCatalogWorkflowId(userRequirements, channelWorkflows);
    if (explicitlyNamedWorkflowId) {
      const workflow = channelWorkflows.find(entry => entry.fileName === explicitlyNamedWorkflowId)!;
      recommendations[baseChannel] = {
        id: workflow.fileName,
        title: workflow.title,
        description: workflow.description,
        category: workflow.category,
        matchPercentage: 100,
        reason: 'The user explicitly requested this exact saved workflow.',
      };
      continue;
    }

    const workflowList = channelWorkflows
      .map((workflow, index) => `${index + 1}. ${workflow.title} (id: "${workflow.fileName}")\n   ${workflow.description}`)
      .join('\n');

    try {
      if (!llmProvider) {
        throw new Error('LLM provider unavailable');
      }

      const response = await llmProvider.createChatCompletion({
        model: llmProvider.defaultModel,
        messages: [
          {
            role: 'system',
            content: `You are selecting the single best lead extraction workflow for a channel.
Choose exactly one workflow that best matches the ICP and the user's current request.
USER REQUIREMENTS describe this search and override the ICP wherever they differ (location, audience, size, channel). Base the reason on the requested location and audience, never on a different ICP location; if they differ from the ICP, say so in one short clause. Write the reason in the language of USER REQUIREMENTS.
Return valid JSON only in this format: { "workflowId": "workflow_file_name", "matchPercentage": 0-100, "reason": "short explanation" }.
The matchPercentage must be realistic and should only be above 90 for an excellent fit.
For ordinary business/profile discovery on Instagram, prefer Post Author Profiles. Recommend commenters, likers or followers only when the request explicitly seeks that engagement relationship; those workflows do not save the post authors and can be empty even when matching posts exist.
Twitter keyword profile search is not a location filter and cannot guarantee decision-maker titles or verified contact details. Prefer concise reviewed brand/industry terms and explain these limitations. Never invent competitor handles or claim guaranteed results.`
          },
          {
            role: 'user',
            content: `CHANNEL: ${baseChannel}\n\nICP:\n${JSON.stringify(icpProfile, null, 2)}\n\n${userRequirements ? `USER REQUIREMENTS: ${userRequirements}\n\n` : ''}AVAILABLE WORKFLOWS:\n${workflowList}`
          },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
        loggingContext: {
          userId: toNumber(context.userId),
          threadId: toNumber(context.threadId),
          purpose: 'workflow_recommendation',
          service: 'LeadExecutor',
          action: 'recommend_workflows_for_channels',
        },
      });

      if (response.success && response.content) {
        let raw = response.content.trim();
        raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        const parsed = JSON.parse(raw);
        const matchedWorkflow = channelWorkflows.find(
          (workflow) => workflow.fileName === parsed.workflowId || workflow.workflowId === parsed.workflowId,
        );

        if (matchedWorkflow) {
          recommendations[baseChannel] = {
            id: matchedWorkflow.fileName,
            title: matchedWorkflow.title,
            description: matchedWorkflow.description,
            category: matchedWorkflow.category,
            matchPercentage: Math.max(1, Math.min(100, Number(parsed.matchPercentage) || 75)),
            reason: typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
              ? parsed.reason.trim()
              : 'This workflow best matches the current ICP and request.',
          };
          continue;
        }
      }
    } catch (error) {
      logger.warn({ err: error, baseChannel }, '[Lead Executor] Failed to rank workflows, using fallback recommendation');
    }

    const fallbackWorkflow = channelWorkflows[0];
    recommendations[baseChannel] = {
      id: fallbackWorkflow.fileName,
      title: fallbackWorkflow.title,
      description: fallbackWorkflow.description,
      category: fallbackWorkflow.category,
      matchPercentage: 75,
      reason: 'This is the default fallback recommendation for the channel.',
      fallback: true,
    };
  }

  return { success: true, recommendations };
}

export function normalizeGeneratedLeadInputEntries(
  value: unknown,
  inputSchema: Record<string, unknown>,
): { entries: Record<string, any>[]; isMultiSearch: boolean } {
  const isRecord = (entry: unknown): entry is Record<string, any> => !!entry && typeof entry === 'object' && !Array.isArray(entry);
  if (Array.isArray(value)) {
    if (!value.every(isRecord)) throw new Error('Search input entries must be objects');
    return { entries: value, isMultiSearch: true };
  }
  if (!isRecord(value)) throw new Error('Search inputs must be a JSON object');
  for (const key of ['searchInputs', 'searches']) {
    // A provider-owned field is always data, never our batch envelope.
    if (Object.hasOwn(inputSchema, key) || !Array.isArray(value[key])) continue;
    if (!value[key].every(isRecord)) throw new Error('Search input entries must be objects');
    return { entries: value[key], isMultiSearch: true };
  }
  return { entries: [value], isMultiSearch: false };
}

function userExplicitlyRequestedSearchVariants(request: string | undefined): boolean {
  if (!request?.trim()) return false;
  return /\b(?:(?:separate|multiple|distinct)\s+(?:search(?:es)?|queries|query variants|search variants)|(?:two|three|four|\d+)\s+(?:separate\s+)?(?:searches|queries|variants)|(?:one|a)\s+search\s+per|separately\s+for\s+(?:each|every))\b/i.test(request);
}

class UnrequestedLeadSearchVariantsError extends Error {
  constructor() {
    super('The AI service returned multiple search variants although none were requested. No settings were saved. Retry the selected strategy, or explicitly request separate searches if you need them.');
    this.name = 'UnrequestedLeadSearchVariantsError';
  }
}

export async function executeGenerateLeadInputs(
  input: { icp_id?: number; platforms?: string[]; selected_workflows?: string[]; user_requirements?: string },
  context: ToolContext
): Promise<ToolResult> {
  const { userId, threadId, icpProfile, brandToolkit } = context;
  const semanticLead = context.intentAnalysis?.semanticRequest?.lead;
  const originalInputRequest = semanticLead
    ? semanticLead.requirements || input.user_requirements
    : resolveOriginalLeadInputRequest(input.user_requirements, context.conversationHistory);
  
  // Convert to numbers for database/service calls
  const userIdNum = toNumber(userId);
  const threadIdNum = toNumber(threadId);
  let confirmedStrategyId: string | undefined;
  let generatedInputSet: { id: string; revision: number } | undefined;
  
  try {
    // Import dependencies
    const { LLMProviderFactory } = await import('../../../services/agents/LLMProviderFactory');
    const { createLeadInputs } = await import('../../../models/leadInputs/functions');
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
    const { getCompanySettingsByUserId } = await import('../../../models/companySettings/functions');
    const { getLeadSettingsByUserId } = await import('../../../models/leadSettings/functions');
    
    // Load dynamic platform/schema data
    const VALID_PLATFORMS = await getValidPlatforms();
    await loadAllActorSchemas();
    await loadPlatformTips();

    // Emit progress: Starting lead input generation
    webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'lead_analyzing', 'Analyzing ICP for lead parameters...', 'lead_generation');
    
    // Fetch company settings (business profile) for location info
    const companySettings = await getCompanySettingsByUserId(userIdNum);
    const businessLocation = companySettings?.city || companySettings?.state || companySettings?.country || null;
    
    // Fetch user's saved lead settings for preferred platforms
    const userLeadSettings = await getLeadSettingsByUserId(userIdNum);
    
    const llmProvider = await LLMProviderFactory.createProviderForUser(userIdNum);

    const selectionRequest = `${input.user_requirements || ''}\n${originalInputRequest || ''}`;
    const selectedStrategyWasNamed = semanticLead
      ? context.intentAnalysis?.semanticRequest?.taskRelation === 'follow_up'
      : /\b(?:selected|confirmed|chosen)\s+(?:(?:lead|search)\s+)?(?:strateg(?:y|ies)|workflow(?:s)?)\b/i.test(selectionRequest);
    const contextualSelection = !context.runContext?.runId && selectedStrategyWasNamed
      ? context.selectedWorkflows || []
      : [];
    const inferredSelectedWorkflows = semanticLead ? [] : inferExplicitWorkflowIds(originalInputRequest, VALID_PLATFORMS);
    const rawRequestedWorkflows = contextualSelection.length > 0
      ? contextualSelection
      : input.selected_workflows?.length
        ? input.selected_workflows
        : inferredSelectedWorkflows;
    const requestedSelectedWorkflows = [...new Set(rawRequestedWorkflows)];
    let explicitSelectedWorkflows = [...new Set(
      (await resolveCatalogWorkflowIds(requestedSelectedWorkflows, VALID_PLATFORMS))
        .filter((workflowName: string) => VALID_PLATFORMS.has(workflowName)),
    )];

    if (!context.runContext?.runId && explicitSelectedWorkflows.length !== requestedSelectedWorkflows.length) {
      throw new Error('A selected lead workflow is unavailable. Review and confirm a valid strategy; no substitute workflow was selected.');
    }
    if (context.runContext?.runId) {
      const { getLatestLeadStrategySelection } = await import('../../../models/conversationWorkflow/functions');
      const confirmed = await getLatestLeadStrategySelection({
        runId: context.runContext.runId, userId: userIdNum, threadId: threadIdNum,
      });
      if (!confirmed?.workflowIds.length) {
        throw new Error('Confirm the lead platform and strategy before generating search parameters.');
      }
      const confirmedWorkflows = confirmed.workflowIds.map(normalizePlatformName);
      const confirmedPlatforms = new Set(confirmedWorkflows.map(workflow => workflow.split('_')[0]));
      const requestedPlatforms = new Set(input.platforms?.map(platform => normalizePlatformName(platform).split('_')[0]));
      if (confirmedWorkflows.some(workflow => !VALID_PLATFORMS.has(workflow))
        || (requestedPlatforms.size > 0 && (requestedPlatforms.size !== confirmedPlatforms.size
          || [...requestedPlatforms].some(platform => !confirmedPlatforms.has(platform))))
        || (explicitSelectedWorkflows.length > 0 && (
          new Set(explicitSelectedWorkflows).size !== new Set(confirmedWorkflows).size
          || explicitSelectedWorkflows.some(workflow => !confirmedWorkflows.includes(workflow))
        ))) {
        throw new Error('The requested lead workflows differ from the confirmed strategy. Review and confirm the new strategy first.');
      }
      // In a durable campaign, the exact saved strategy is authoritative. A
      // model-generated unknown alias cannot select anything and must not turn
      // a valid bound UI choice into a dead end; a different *valid* workflow
      // is still rejected above.
      explicitSelectedWorkflows = [...new Set(confirmedWorkflows)];
      confirmedStrategyId = confirmed.id;
    }
    
    // Fallback: use recommended strategies from toolContext or state.selectedWorkflows
    if (explicitSelectedWorkflows.length === 0) {
       
      const recommended = (context as any).recommendedStrategies || (context as any).selectedWorkflows || [];
      if (recommended.length > 0) {
        explicitSelectedWorkflows = (recommended as string[])
          .map((workflowName: string) => normalizePlatformName(workflowName))
          .filter((workflowName: string) => VALID_PLATFORMS.has(workflowName));
        logger.info({ recommendedStrategies: explicitSelectedWorkflows }, '[Lead Executor] Using recommended strategies from context');
      }
    }
    
    // Get platforms from ICP or args and normalize names
    const rawPlatforms = input.platforms || 
      (icpProfile?.primaryChannels || []).map((ch: string) => ch.toLowerCase());
    
    // Normalize platform names (e.g., "google" -> "google_maps")
    let platforms = rawPlatforms.map((p: string) => normalizePlatformName(p))
      .filter((p: string) => VALID_PLATFORMS.has(p));

    if (requestedSelectedWorkflows.length > 0 && explicitSelectedWorkflows.length === 0 && platforms.length === 0) {
      throw new Error('The selected lead workflow is unavailable. Choose a valid platform or strategy and try again.');
    }
    
    if (explicitSelectedWorkflows.length > 0) {
      platforms = Array.from(new Set(explicitSelectedWorkflows));
      logger.info({ selectedWorkflows: platforms }, '[Lead Executor] Using explicitly confirmed workflows');
    }

    // If no platforms specified, use user's saved lead settings platforms
    if (explicitSelectedWorkflows.length === 0 && platforms.length === 0 && userLeadSettings?.leadSources && userLeadSettings.leadSources.length > 0) {
      platforms = userLeadSettings.leadSources
        .map((p: string) => normalizePlatformName(p))
        .filter((p: string) => VALID_PLATFORMS.has(p));
      logger.info({ savedPlatforms: platforms }, '[Lead Executor] Using platforms from user lead settings');
    }
    
    // If still no platforms, auto-infer from business model
    if (explicitSelectedWorkflows.length === 0 && platforms.length === 0) {
      const businessModel = (icpProfile?.targetBusinessModel || '').toUpperCase();
      if (businessModel === 'B2B') {
        platforms = ['linkedin', 'google_maps'];
      } else if (businessModel === 'B2C') {
        platforms = ['instagram', 'facebook', 'google_maps'];
      } else {
        // Default platforms for unknown business model
        platforms = ['linkedin', 'google_maps'];
      }
      logger.info({ businessModel, inferredPlatforms: platforms }, '[Lead Executor] No primaryChannels in ICP, auto-inferred platforms from business model');
    }

    // Emit progress: Configuring platforms
  webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'lead_platforms', `Configuring ${platforms.length} search target(s)...`, 'lead_generation');

     
    const inputSchemas: any[] = [];

    // ─── Phase 1: For each channel, select the best workflows based on ICP ─────
    // Build a flat list of (workflow, channel) tuples to generate inputs for
    interface SelectedWorkflowEntry {
      workflow: WorkflowSummary;
      baseChannel: string;
    }
    const selectedEntries: SelectedWorkflowEntry[] = [];

    if (explicitSelectedWorkflows.length > 0) {
      for (const workflowName of explicitSelectedWorkflows) {
        const baseChannel = workflowName.split('_')[0];
        const channelWorkflows = await getChannelWorkflows(baseChannel);
        const explicitWorkflow = channelWorkflows.find(
          (workflow) => workflow.fileName === workflowName || workflow.workflowId === workflowName || workflow.platform === workflowName,
        );

        if (!explicitWorkflow) {
          logger.warn({ workflowName, baseChannel }, '[Lead Executor] Explicit workflow not found for channel');
          continue;
        }

        selectedEntries.push({ workflow: explicitWorkflow, baseChannel });
      }
    } else {
      for (const platform of platforms) {
        const baseChannel = platform.split('_')[0]; // e.g., "linkedin" from "linkedin_company_search"
        
        // Load all available workflows for this channel
        const channelWorkflows = await getChannelWorkflows(baseChannel);
        if (channelWorkflows.length === 0) {
          logger.warn({ platform, baseChannel }, '[Lead Executor] No workflows found for channel');
          continue;
        }

        webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'lead_workflow_select', `Selecting best workflows for ${baseChannel}...`, 'lead_generation');
        
        // Use LLM to select best matching workflows for this channel
        const selected = await selectBestWorkflows(
          baseChannel,
          channelWorkflows,
          icpProfile,
          input.user_requirements,
          llmProvider,
          { userId: String(context.userId), threadId: String(context.threadId) }
        );

        for (const wf of selected) {
          selectedEntries.push({ workflow: wf, baseChannel });
        }

        logger.info({
          channel: baseChannel,
          available: channelWorkflows.map(w => w.title),
          selected: selected.map(w => w.title),
        }, '[Lead Executor] Workflow selection complete');
      }
    }

    // Say so up front when none of the chosen searches has a data provider key,
    // before any settings are prepared or credits are spent.
    const actorsWithoutKey = await findLeadActorsWithoutKey(userIdNum, selectedEntries.map(entry => entry.workflow.firstActorId || ''));
    if (selectedEntries.length > 0 && selectedEntries.every(entry => entry.workflow.firstActorId && actorsWithoutKey.has(entry.workflow.firstActorId))) {
      throw new LeadProviderUnavailableError();
    }

    // ─── Phase 2: Generate lead inputs for each selected workflow ───────────────
    const channelInputCounts: Record<string, number> = {};
    const MAX_INPUTS_PER_CHANNEL = 3; // Cap at 3 inputs max per base channel (minimum 1, max 2-3)

    for (const { workflow: selectedWorkflow, baseChannel } of selectedEntries) {
      const currentCount = channelInputCounts[baseChannel] || 0;
      if (currentCount >= MAX_INPUTS_PER_CHANNEL) {
        logger.info({ baseChannel, currentCount }, '[Lead Executor] Skipping workflow as channel has reached max inputs');
        continue;
      }

      const workflowFileName = selectedWorkflow.fileName;
      const category = selectedWorkflow.category;

      webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'lead_platform_config', `Setting up ${category} search parameters...`, 'lead_generation');

      const workflowPath = resolveWorkflowPath(workflowFileName);

      try {
        const workflowContent = await fs.readFile(workflowPath, 'utf-8');
        const workflow = JSON.parse(workflowContent);
        
         
        const firstActorNode = workflow.nodes?.find((n: any) => n.type === 'actor');
        if (!firstActorNode) continue;

        const actorData = firstActorNode.data;
        const inputMapping = actorData.inputMapping || {};
        
        // Load actor schema dynamically from data/actors/ JSON files
        const actorSchema = await buildReviewedWorkflowActorSchema(workflow);
        const inputSchema = actorSchema?.inputProperties || {};
        const requiredFields = Array.from(new Set([
          ...(actorSchema?.requiredFields || []),
          ...(Array.isArray(actorData.requiredInputFields) ? actorData.requiredInputFields : []),
        ]));
        const workflowRequiredFields = new Set<string>(
          Array.isArray(actorData.requiredInputFields)
            ? actorData.requiredInputFields.filter((field: unknown): field is string => typeof field === 'string')
            : [],
        );

        // Extract location from Business Profile (companySettings), ICP primaryRegions, or fallback to 'Global'
        // Priority: Business Profile (companySettings) -> ICP primaryRegions -> brandToolkit -> fallback to 'Global'
         
        let icpLocation: any = businessLocation;
        if (!icpLocation && icpProfile?.primaryRegions && icpProfile.primaryRegions.length > 0) {
          icpLocation = icpProfile.primaryRegions[0]; // Use first region
        }
        if (!icpLocation) {
           
          icpLocation = (brandToolkit as any)?.location ||
                        
                       (brandToolkit as any)?.city ||
                        
                       (brandToolkit as any)?.address?.city ||
                       'Global';
        }
        icpLocation = (semanticLead ? semanticLead.location : extractExplicitTargetLocation(originalInputRequest || input.user_requirements)) || icpLocation;
        
        logger.info({
          businessLocation,
          icpPrimaryRegions: icpProfile?.primaryRegions,
           
          brandToolkitLocation: (brandToolkit as any)?.location,
          resolved: icpLocation
        }, '[Lead Executor] Location sources');
        
        // Extract location city name for hashtag prefixes
        // Handle various location formats: string, object, comma-separated
        let locationName: string;
        if (typeof icpLocation === 'object' && icpLocation !== null) {
          locationName = icpLocation.city || icpLocation.region || icpLocation.country || 'Global';
        } else if (typeof icpLocation === 'string') {
          // Take the first part if comma-separated (e.g., "Bengaluru, Karnataka, India" -> "Bengaluru")
          locationName = icpLocation.split(',')[0].trim();
        } else {
          locationName = 'Global';
        }
        
        // Clean up location name - remove special characters, spaces (for hashtags)
        const cleanLocationName = locationName.replace(/[^a-zA-Z0-9]/g, '');

        // The set of valid field names for this platform (from inputMapping)
        const validFields = new Set(Object.keys(inputMapping));
        // Most workflows expose the actor schema so canonical reviewed values
        // are not lost merely because a legacy input mapping omits them. A
        // workflow may explicitly narrow that surface when the actor supports
        // several mutually exclusive acquisition modes and this strategy uses
        // only one of them.
        const reviewableInputFields = Array.isArray(actorData.reviewableInputFields)
          ? actorData.reviewableInputFields
          : Object.keys(inputSchema);
        for (const key of reviewableInputFields) {
          validFields.add(key);
        }
        
        // Read finalValues from workflow — these fields are excluded from LLM generation
         
        const finalValues: Record<string, any> = actorData.finalValues || {};
        const finalFieldNames = new Set(Object.keys(finalValues));

        // Separate user-input fields (sent to LLM) from final fields (auto-applied)
        const llmFields = Array.from(validFields).filter(f => !finalFieldNames.has(f));
        const allowedFieldNames = llmFields.join(', ');
        const multiSearchWrapper = Object.hasOwn(inputSchema, 'searches') ? 'searchInputs' : 'searches';

        // Build field documentation dynamically from actor schema — exclude final fields
        const fieldDocumentation = actorSchema ? buildFieldDocFromSchema(actorSchema, finalFieldNames) : '';
        const platformTips = getPlatformTips(workflowFileName);

        // Generate inputs using LLM with real Apify actor documentation
        const userRequirementsBlock = input.user_requirements
          ? `\nUSER REQUIREMENTS (IMPORTANT — adjust parameters to match these):\n"${input.user_requirements}"\nTailor the generated values to satisfy this request. For example, if user says "only 20 leads", set the max results/items field to 20.\n`
          : '';

        const promptContext = `Generate search parameters for the "${category}" workflow (${workflowFileName}) Apify actor based on this ICP:
${JSON.stringify(icpProfile, null, 2)}
${userRequirementsBlock}
${originalInputRequest ? `ORIGINAL USER REQUEST (authoritative for explicitly named field choices):\n${originalInputRequest}\n` : ''}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
BUSINESS LOCATION: ${(brandToolkit as any)?.location || (brandToolkit as any)?.city || 'Not specified'}
TARGET LOCATION: ${icpLocation}
LOCATION NAME (for hashtags/queries): ${locationName} (${cleanLocationName})

=== APIFY ACTOR INPUT REFERENCE (${actorSchema?.actorId || actorData.actorId}) ===
${actorSchema?.description || ''}

FIELD DEFINITIONS (with types, examples, and format requirements):
${fieldDocumentation}

${platformTips ? `TIPS FOR GENERATING GOOD INPUTS:\n${platformTips}\n` : ''}
=== END REFERENCE ===

STRICT RULES:
1. Return ONLY these fields: ${allowedFieldNames}. Do NOT invent or include any other fields.
2. ALL fields marked REQUIRED MUST be included in your response.
3. Use the EXACT field names as listed above.
4. Array fields MUST be JSON arrays (e.g., ["item1", "item2"]), not comma-separated strings.
5. String fields should be single strings, not arrays.
6. Integer fields should be numbers, not strings.
7. Use the example values and format guidance above to generate REALISTIC inputs that will actually produce results.
8. MULTI-SEARCH: Return one flat JSON object by default, combining relevant titles or queries in its provider-owned fields. Return multiple search inputs (wrapped in a "${multiSearchWrapper}" array) only when the user explicitly asks for separate/multiple searches or one search per segment/location. Do not infer permission to create multiple searches from the ICP alone. Even when explicitly requested, generate a maximum of 2 entries. Provider-owned array fields remain inside each input object.
9. Keep search queries simple and focused on the business category and location. Do not copy conversational instructions such as "that are active on Facebook" into a keyword query. Preserve distinct customer-requested segments across multiple searches and do not repeat locations.
10. Omit optional provider identifiers such as location_uid unless the user explicitly supplied that identifier. A city name is not a location UID. Do not invent numeric IDs. Include the city in the search query instead.

Return valid JSON — either a flat object with ONLY the fields: ${allowedFieldNames},
or { "${multiSearchWrapper}": [ ...array of 2 objects max... ] } for multi-search platforms.`;

        const generateInputsFromLLM = async (retryPromptSuffix?: string) => {
          const userPrompt = retryPromptSuffix ? `${promptContext}\n\n${retryPromptSuffix}` : promptContext;
          const request = (provider: typeof llmProvider) => provider.createChatCompletion({
            model: provider.defaultModel,
            messages: [
              { role: 'system', content: `You are an expert at generating Apify actor search parameters. You generate JSON input for the "${category}" workflow actor (${actorSchema?.actorId || actorData.actorId}).

CRITICAL RULES:
1. Return ONLY these fields: ${allowedFieldNames}. No other fields.
2. ALL required fields MUST be included.
3. Array fields must be actual JSON arrays, not comma-separated strings.
4. Generate REALISTIC values based on the ICP and location — values that will actually produce results from the Apify actor.
5. Search in this target location: ${locationName}. A location in the user's request overrides the ICP regions; never substitute an ICP location for it.
6. Follow the field format examples from the actor reference.
7. MULTI-SEARCH: Return one search input by default. Only return { "${multiSearchWrapper}": [ {...}, {...} ] } if the user's request explicitly asks for separate/multiple searches or one search per segment/location. Do not infer multiple searches from the ICP alone; when explicitly requested, limit to 2 entries.` },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.3,
            response_format: { type: 'json_object' },
            loggingContext: {
              userId: context.userId,
              threadId: context.threadId,
              purpose: 'lead_generation',
              service: 'LeadExecutor',
              action: 'generate_lead_inputs',
            },
          });

          // The factory tries a different configured credential/provider on a
          // provider response failure. A second bounded pass also retries when
          // the account has only one provider; validation errors are not retried
          // here and retain their separate corrective-prompt path below.
          for (let pass = 0; pass < 2; pass += 1) {
            try {
              return await LLMProviderFactory.executeProviderCallWithFallback(
                userIdNum,
                async (provider) => {
                  const response = await request(provider);
                  if (!response.success || !response.content) {
                    throw new LLMProviderResponseError(
                      response.error || 'The AI provider returned no search parameters.',
                      provider.getProviderName(),
                      provider.defaultModel,
                    );
                  }
                  return response;
                },
                2,
              );
            } catch (error) {
              if (!isProviderResponseError(error) || pass === 1) throw error;
              logger.warn({ err: error, platform: workflowFileName }, '[Lead Executor] Retrying lead input provider request');
            }
          }
          throw new Error('Lead input provider retry ended without a response.');
        };
        
        const response = await generateInputsFromLLM();

        if (response.success && response.content) {
          // Strip potential markdown code fences (some providers ignore response_format)
          let rawContent = response.content.trim();
          rawContent = rawContent.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
          const parsedLLMResponse = JSON.parse(rawContent);

          // Normalize both multi-search and single-search structures into a single entries array
          const normalizedEntries = normalizeGeneratedLeadInputEntries(parsedLLMResponse, inputSchema);
          const entries = normalizedEntries.entries;
          let isMultiSearch = normalizedEntries.isMultiSearch;
          const allowsSearchVariants = semanticLead ? semanticLead.searchVariants : userExplicitlyRequestedSearchVariants(
            `${input.user_requirements || ''}\n${originalInputRequest || ''}`,
          );
          let unrequestedSearchVariants = entries.length > 1 && !allowsSearchVariants;

          // Define a function to process and validate a set of raw entries
           
          const processAndValidateEntries = (rawEntries: Record<string, any>[]) => {
             
            const processed: Record<string, any>[] = [];
            const allErrors: string[] = [];

            for (let idx = 0; idx < rawEntries.length; idx++) {
              const entry = rawEntries[idx];
               
              const coercedEntry: Record<string, any> = {};

              // 1. Filter out fields not in schema / validFields
              for (const key of Object.keys(entry)) {
                if (validFields.has(key)) {
                  coercedEntry[key] = entry[key];
                } else {
                  logger.warn({ platform: workflowFileName, droppedField: key }, '[Lead Executor] Dropped field not in platform schema');
                }
              }

              // 2. Type coercion
              Object.assign(coercedEntry, coerceActorInputTypes(coercedEntry, inputSchema));

              Object.assign(
                coercedEntry,
                applyFacebookCompetitorPageUrls(
                  coercedEntry,
                  selectedWorkflow.workflowId,
                  originalInputRequest,
                ),
              );

              const explicitlyTypedEntry = applyExplicitTypedRequirements(
                coercedEntry,
                inputSchema,
                originalInputRequest,
              );
              Object.assign(
                coercedEntry,
                applyExplicitEmptyRequirements(explicitlyTypedEntry, inputSchema, originalInputRequest),
              );
              // 3. Validation
              const errors = validateActorInputsAgainstSchema(
                actorData.actorId,
                coercedEntry,
                inputSchema,
                requiredFields
              );

              if (errors.length > 0) {
                const prefix = rawEntries.length > 1 ? `[Search Entry #${idx + 1}] ` : '';
                allErrors.push(...errors.map(err => `${prefix}${err}`));
              }

              processed.push(coercedEntry);
            }

            return { processed, errors: allErrors };
          };

          let { processed: validatedEntries, errors: validationErrors } = processAndValidateEntries(entries);
          if (unrequestedSearchVariants) {
            validationErrors.push('The user did not request separate searches. Return exactly one search input and combine relevant query terms in that input.');
          }

          // If there are validation errors, retry/regenerate via corrective prompt
          if (validationErrors.length > 0) {
            logger.warn({ platform: workflowFileName, errors: validationErrors }, '[Lead Executor] Schema validation failed, retrying');
            webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'lead_validation_retry', `Fixing ${validationErrors.length} validation error(s) for ${category}...`, 'lead_generation');

            const retryPrompt = `VALIDATION ERRORS from your previous attempt:\n${validationErrors.map(e => `  - ${e}`).join('\n')}\n\nFix ALL these errors and return valid JSON with ONLY the fields: ${allowedFieldNames}.`;

            try {
              const retryResponse = await generateInputsFromLLM(retryPrompt);
              if (retryResponse.success && retryResponse.content) {
                let retryRaw = retryResponse.content.trim();
                retryRaw = retryRaw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
                const retryParsed = JSON.parse(retryRaw);

                 
                const { entries: retryEntries, isMultiSearch: retryIsMultiSearch } = normalizeGeneratedLeadInputEntries(retryParsed, inputSchema);

                const retryResult = processAndValidateEntries(retryEntries);
                validatedEntries = retryResult.processed;
                validationErrors = retryResult.errors;
                isMultiSearch = retryIsMultiSearch;
                unrequestedSearchVariants = retryEntries.length > 1 && !allowsSearchVariants;
                if (unrequestedSearchVariants) {
                  validationErrors.push('The user did not request separate searches. Return exactly one search input and combine relevant query terms in that input.');
                }

                if (validationErrors.length > 0) {
                  logger.warn({ platform: workflowFileName, errors: validationErrors }, '[Lead Executor] Retry still has validation errors, applying defaults');
                } else {
                  logger.info({ platform: workflowFileName }, '[Lead Executor] Retry passed validation');
                }
              }
            } catch (retryErr) {
              if (isProviderResponseError(retryErr)) throw retryErr;
              logger.warn({ err: retryErr, platform: workflowFileName }, '[Lead Executor] Failed to regenerate inputs via retry loop');
            }
          }

          if (unrequestedSearchVariants) throw new UnrequestedLeadSearchVariantsError();

          // Process the validated entries (capping at max searches per channel)
          const cappedEntries = validatedEntries.slice(0, MAX_INPUTS_PER_CHANNEL);
          
          if (isMultiSearch) {
            webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'lead_multi_search', `Generating ${cappedEntries.length} searches for ${category}...`, 'lead_generation');
          }

          for (let idx = 0; idx < cappedEntries.length; idx++) {
            const currentCount = channelInputCounts[baseChannel] || 0;
            if (currentCount >= MAX_INPUTS_PER_CHANNEL) {
              logger.info({ baseChannel, currentCount }, '[Lead Executor] Skipping entry as channel has reached max inputs');
              break;
            }

            let entryInputs = cappedEntries[idx];

            // Final fallback: fill remaining validation issues / missing required fields with prefill/defaults
            const stillMissingRequired = (requiredFields as string[]).filter((field: string) => {
              const value = entryInputs[field];
              return value === undefined || value === null || (Array.isArray(value) && value.length === 0) || (typeof value === 'string' && value.trim() === '');
            });

            for (const field of stillMissingRequired) {
              // Workflow-declared targets are semantic requirements, not an
              // invitation to scrape the actor metadata's public demo values.
              if (workflowRequiredFields.has(field)) continue;
              const schema = inputSchema[field];
              if (schema) {
                if (schema.type === 'array' && schema.prefill) {
                  entryInputs[field] = Array.isArray(schema.prefill) ? schema.prefill : [schema.prefill];
                } else if (schema.default !== undefined) {
                  entryInputs[field] = schema.default;
                } else if (schema.prefill !== undefined) {
                  entryInputs[field] = schema.prefill;
                }
              }
            }

            // Apply system defaults for technical fields the LLM didn't generate
            entryInputs = stripEmptyGeneratedInputs(applyRequestedLeadLimit(
              applyFinalValues(
                applyExplicitEnumRequirements(
                  applyExplicitTypedRequirements(
                    preserveGeneratedLeadInputs(entryInputs, originalInputRequest || input.user_requirements),
                    inputSchema,
                    originalInputRequest,
                  ),
                  inputSchema,
                  originalInputRequest,
                ),
                finalValues,
              ),
              originalInputRequest || input.user_requirements,
              inputSchema,
            ));

            const unresolvedWorkflowFields = Array.from(workflowRequiredFields).filter((field) => {
              const value = entryInputs[field];
              return value === undefined || value === null
                || (Array.isArray(value) && value.length === 0)
                || (typeof value === 'string' && !value.trim());
            });
            if (unresolvedWorkflowFields.length > 0) {
              logger.warn({ platform: workflowFileName, fields: unresolvedWorkflowFields }, '[Lead Executor] Refusing demo fallback for missing workflow target');
              continue;
            }

            logger.info({ platform: workflowFileName, category, inputs: entryInputs }, '[Lead Executor] Generated inputs');

            inputSchemas.push({
              platform: workflowFileName,
              inputs: entryInputs,
              actorId: actorData.actorId,
              actorName: actorData.actorName || actorData.label,
              category,
              workflowId: selectedWorkflow.workflowId,
              recommendedSubWorkflows: [workflowFileName],
            });

            channelInputCounts[baseChannel] = (channelInputCounts[baseChannel] || 0) + 1;
          }
        } else {
          // LLM response was unsuccessful — use workflow prefill defaults as fallback
          logger.warn({ platform: workflowFileName, error: response.error }, '[Lead Executor] LLM failed for platform, using prefill defaults');
          webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'lead_platform_fallback', `Using default parameters for ${category}...`, 'lead_generation');

           
          const fallbackInputs: Record<string, any> = {};
           
          for (const [key, schema] of Object.entries(inputSchema) as [string, any][]) {
            if (key in inputMapping) {
              if (workflowRequiredFields.has(key)) continue;
              if (schema.prefill !== undefined) {
                fallbackInputs[key] = schema.prefill;
              } else if (schema.default !== undefined) {
                fallbackInputs[key] = schema.default;
              }
            }
          }

          if (Object.keys(fallbackInputs).length > 0) {
            const fallbackWithExplicitTargets = applyFacebookCompetitorPageUrls(
              fallbackInputs,
              selectedWorkflow.workflowId,
              originalInputRequest,
            );
            const defaultedFallback = stripEmptyGeneratedInputs(applyRequestedLeadLimit(
              applyFinalValues(
                applyExplicitEnumRequirements(
                  applyExplicitTypedRequirements(
                    applyLeadIntentToFallbackInputs(fallbackWithExplicitTargets, inputMapping, icpProfile, icpLocation),
                    inputSchema,
                    originalInputRequest,
                  ),
                  inputSchema,
                  originalInputRequest,
                ),
                finalValues,
              ),
              originalInputRequest || input.user_requirements,
              inputSchema,
            ));
            const unresolvedWorkflowFields = Array.from(workflowRequiredFields).filter((field) => {
              const value = defaultedFallback[field];
              return value === undefined || value === null
                || (Array.isArray(value) && value.length === 0)
                || (typeof value === 'string' && !value.trim());
            });
            if (unresolvedWorkflowFields.length > 0) {
              logger.warn({ platform: workflowFileName, fields: unresolvedWorkflowFields }, '[Lead Executor] Refusing provider-example fallback for missing workflow target');
              continue;
            }
            const currentCount = channelInputCounts[baseChannel] || 0;
            if (currentCount < MAX_INPUTS_PER_CHANNEL) {
              inputSchemas.push({
                platform: workflowFileName,
                inputs: defaultedFallback,
                actorId: actorData.actorId,
                actorName: actorData.actorName || actorData.label,
                category,
                workflowId: selectedWorkflow.workflowId,
                recommendedSubWorkflows: [workflowFileName],
              });
              channelInputCounts[baseChannel] = (channelInputCounts[baseChannel] || 0) + 1;
              logger.info({ platform: workflowFileName, category, inputs: defaultedFallback }, '[Lead Executor] Used prefill defaults');
            }
          }
        }
      } catch (e) {
        // A provider outage must not quietly turn a selected, user-specific
        // strategy into generic prefill values or an executable review card.
        if (isProviderResponseError(e)
          || e instanceof UnrequestedLeadSearchVariantsError
          || e instanceof FacebookCompetitorPageUrlsRequiredError) throw e;
        logger.error({ err: e, platform: workflowFileName }, '[Lead Executor] Failed to generate inputs for platform');
        webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'lead_platform_error', `Failed to configure ${category}, using defaults...`, 'lead_generation');

        // Try to use prefill defaults from the workflow as a last resort
        try {
          const workflowContent = await fs.readFile(workflowPath, 'utf-8');
          const workflow = JSON.parse(workflowContent);
           
          const firstActorNode = workflow.nodes?.find((n: any) => n.type === 'actor');
          if (firstActorNode) {
            const actorData = firstActorNode.data;
            const wfInputSchema = actorData.schema?.inputSchema?.properties || {};
            const wfInputMapping = actorData.inputMapping || {};
             
            const wfFinalValues: Record<string, any> = actorData.finalValues || {};
             
            const fallbackInputs: Record<string, any> = {};
             
            for (const [key, schema] of Object.entries(wfInputSchema) as [string, any][]) {
              if (key in wfInputMapping) {
                if (schema.prefill !== undefined) fallbackInputs[key] = schema.prefill;
                else if (schema.default !== undefined) fallbackInputs[key] = schema.default;
              }
            }
            if (Object.keys(fallbackInputs).length > 0) {
              const fallbackWithExplicitTargets = applyFacebookCompetitorPageUrls(
                fallbackInputs,
                selectedWorkflow.workflowId,
                originalInputRequest,
              );
              const defaultedFallback = applyRequestedLeadLimit(
                applyFinalValues(
                  applyExplicitEnumRequirements(
                    applyExplicitTypedRequirements(
                      applyLeadIntentToFallbackInputs(fallbackWithExplicitTargets, wfInputMapping, icpProfile),
                      wfInputSchema,
                      originalInputRequest,
                    ),
                    wfInputSchema,
                    originalInputRequest,
                  ),
                  wfFinalValues,
                ),
                originalInputRequest || input.user_requirements,
                wfInputSchema,
              );
              const currentCount = channelInputCounts[baseChannel] || 0;
              if (currentCount < MAX_INPUTS_PER_CHANNEL) {
                inputSchemas.push({
                  platform: workflowFileName,
                  inputs: defaultedFallback,
                  actorId: actorData.actorId,
                  actorName: actorData.actorName || actorData.label,
                  category,
                  workflowId: selectedWorkflow.workflowId,
                  recommendedSubWorkflows: [workflowFileName],
                });
                channelInputCounts[baseChannel] = (channelInputCounts[baseChannel] || 0) + 1;
                logger.info({ platform: workflowFileName, category, inputs: defaultedFallback }, '[Lead Executor] Used prefill defaults after error');
              }
            }
          }
        } catch (fallbackErr) {
          logger.error({ err: fallbackErr, platform: workflowFileName }, '[Lead Executor] Could not even read workflow for fallback defaults');
        }
      }
    }

    await loadAllActorSchemas();
    const reviewedInputSchemas = applyRequestedLeadLimitToBatch(
      inputSchemas,
      semanticLead ? undefined : resolveLeadLimitRequirements(input.user_requirements, context.conversationHistory),
      semanticLead?.limit,
    ).map((schema) => ({
      ...schema,
      inputs: applyProviderMinimumFetchLimits(
        schema.inputs,
        getActorSchema(schema.actorId)?.inputProperties || {},
      ),
    }));

    if (explicitSelectedWorkflows.length > 0) {
      const expectedByFile = new Map(selectedEntries.map(({ workflow }) => [workflow.fileName, workflow.workflowId]));
      const actualFiles = new Set(reviewedInputSchemas.map(schema => schema.platform));
      if (actualFiles.size !== expectedByFile.size
        || [...expectedByFile.keys()].some(fileName => !actualFiles.has(fileName))
        || reviewedInputSchemas.some(schema => expectedByFile.get(schema.platform) !== schema.workflowId)) {
        throw new Error('Generated lead settings did not match the exact selected workflow. No settings were saved; choose the strategy again to retry.');
      }
    }

    if (reviewedInputSchemas.length === 0) {
      throw new Error('No valid search parameters were generated. Review the selected workflows and try again.');
    }

    // Save to database and return the exact durable IDs reviewed by the client.
    let savedInputIds: number[] = [];
    if (reviewedInputSchemas.length > 0) {
      // Emit progress: Saving inputs
      webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'lead_saving', 'Saving search parameters...', 'lead_generation');
      
      const leadInputRows = reviewedInputSchemas.map(schema => ({
        threadId: threadIdNum,
        userId: userIdNum,
        platform: schema.platform,
        inputs: schema.inputs,
        schema: {
          ...(schema.requestedLeadLimit
            ? {
                requestedLeadLimit: schema.requestedLeadLimit,
                requestedLeadTotal: schema.requestedLeadTotal,
              }
            : {}),
          reviewedConstraints: {
            regions: icpProfile?.primaryRegions || [],
            industry: icpProfile?.industry || icpProfile?.businessIndustry,
            subIndustry: icpProfile?.subIndustry,
            targetAudience: icpProfile?.targetAudience,
          },
        },
        actorId: schema.actorId,
        actorName: schema.actorName,
        category: schema.category,
        workflowId: schema.workflowId,
        recommendedSubWorkflows: schema.recommendedSubWorkflows,
      }));
      const savedInputs = context.runContext?.runId && confirmedStrategyId
        ? await (async () => {
            const { createReviewedLeadInputSet } = await import('../../../models/conversationWorkflow/functions');
            const created = await createReviewedLeadInputSet({
              runId: context.runContext!.runId,
              userId: userIdNum,
              threadId: threadIdNum,
              strategySelectionId: confirmedStrategyId,
              leadInputs: leadInputRows,
              platforms: reviewedInputSchemas.map(schema => schema.platform),
              workflowIds: reviewedInputSchemas.map(schema => schema.workflowId).filter(Boolean),
              snapshot: { schemas: reviewedInputSchemas },
            });
            generatedInputSet = created.inputSet;
            return created.inputs;
          })()
        : await createLeadInputs(leadInputRows);
      savedInputIds = savedInputs.map(inputRecord => inputRecord.id);
      if (savedInputIds.length !== reviewedInputSchemas.length
        || savedInputIds.some(id => !Number.isInteger(id) || id <= 0)
        || new Set(savedInputIds).size !== savedInputIds.length) {
        throw new Error('The generated search parameters could not all be saved. Reload the Lead Inputs tab before retrying.');
      }

      // Emit progress: Complete
      webSocketEmitter.emitProgressStep(userIdNum, threadIdNum, 'lead_complete', 'Search parameters ready!', 'lead_generation');
      
      // Emit lead_inputs_generated event
      webSocketEmitter.emit(userIdNum, 'lead_inputs_generated', {
        threadId: threadIdNum,
        userId: userIdNum,
        platforms: reviewedInputSchemas.map(s => s.platform),
        count: reviewedInputSchemas.length,
        inputIds: savedInputIds,
        workflowIds: reviewedInputSchemas.map(s => s.workflowId).filter(Boolean),
        schemas: reviewedInputSchemas,
      });
      
      // Open lead inputs tab
      webSocketEmitter.emit(userIdNum, 'open_tab', {
        thread_id: toNumber(context.threadId),
        tabType: TAB_TYPES.LEAD_INPUTS,
        tabLabel: TAB_LABELS[TAB_TYPES.LEAD_INPUTS],
        data: { threadId: threadIdNum },
      });
      
      logger.info({ workflowCount: reviewedInputSchemas.length }, '[Lead Executor] Generated reviewed inputs for workflows');
    }

    return {
      success: true,
      toolName: 'generate_lead_inputs',
      // Input generation is a mandatory review boundary. Let the shared tool
      // loop stop on this receipt instead of making another model call whose
      // failure could hide a successfully persisted review or lose its bound
      // approval state.
      requiresApproval: true,
      output: {
        status: 'succeeded',
        platforms: reviewedInputSchemas.map(s => s.platform),
        count: reviewedInputSchemas.length,
        inputIds: savedInputIds,
        workflowIds: reviewedInputSchemas.map(s => s.workflowId).filter(Boolean),
        schemas: reviewedInputSchemas,
        message: `Prepared ${reviewedInputSchemas.length} search input(s) for ${new Set(reviewedInputSchemas.map(s => s.workflowId)).size} selected workflow(s): ${[...new Set(reviewedInputSchemas.map(s => s.category || s.platform))].join(', ')}. Review the exact saved settings in the Lead Inputs tab before approving the search. No search has been executed.`,
        ...(generatedInputSet ? {
          leadInputSetId: generatedInputSet.id,
          leadInputSetRevision: generatedInputSet.revision,
          workflowRunId: context.runContext!.runId,
        } : {}),
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Lead Executor] Error');
    const providerFailure = isProviderResponseError(error);
    const errorCode = error instanceof LeadProviderUnavailableError ? 'LEAD_DATA_PROVIDER_NOT_CONNECTED'
      : providerFailure ? 'LEAD_INPUT_PROVIDER_UNAVAILABLE' : 'LEAD_INPUT_GENERATION_FAILED';
    const recoveryMessage = providerFailure
      ? 'The AI service could not prepare the selected search settings after retrying. No search was run and no settings were saved. Keep the selected strategy and try preparing its settings again in a moment.'
      : error.message;

    if (context.runContext?.runId) {
      try {
        const { transitionConversationWorkflowRun } = await import('../../../models/conversationWorkflow/functions');
        await transitionConversationWorkflowRun({
          runId: context.runContext.runId, userId: userIdNum, threadId: threadIdNum,
          onlyFromStage: 'lead_inputs_generating',
          toStage: 'needs_attention', status: 'failed',
          contextPatch: { leadInputGenerationFailed: true, leadInputGenerationErrorCode: errorCode },
        });
      } catch (transitionError) {
        logger.warn({ err: transitionError }, '[Lead Executor] Could not persist input generation failure');
      }
    }

    // Emit and persist chat message for parameter generation failure
    if (!isNaN(userIdNum) && threadIdNum) {
      try {
        const { createChatMessage } = await import('../../../models/chatMessages/functions');
        const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
        const errorMsg = error instanceof LeadProviderUnavailableError
          ? recoveryMessage
          : `I couldn't prepare the search settings. ${recoveryMessage}`;
        await createChatMessage({
          userId: userIdNum,
          threadId: threadIdNum,
          role: 'assistant',
          content: errorMsg,
          agentType: 'lead_generation',
        });
        webSocketEmitter.emitChatResponse(userIdNum, threadIdNum, {
          role: 'assistant',
          content: errorMsg,
          agentType: 'lead_generation',
          metadata: { responseId: `lead-gen-error-${Date.now()}` },
        });
      } catch (dbErr) {
        logger.warn({ err: dbErr }, '[Lead Executor] Failed to persist generation error message');
      }
    }

    return {
      success: false,
      toolName: 'generate_lead_inputs',
      error: recoveryMessage,
      output: {
        status: 'failed',
        errorCode,
        retryable: providerFailure,
        recoveryMessage,
        selectedWorkflows: input.selected_workflows || [],
      },
    };
  }
}

interface ExecuteLeadWorkflowInput {
  thread_id?: number;
  platforms?: string[];
  selected_workflows?: string[];
  leadInputSetId?: string;
  leadInputSetRevision?: number;
  workflowRunId?: string;
}

async function executeLeadWorkflowOnce(
  input: ExecuteLeadWorkflowInput,
  context: ToolContext
): Promise<ToolResult> {
  const { userId, threadId, workflowId, icpProfile, selectedWorkflows } = context;
  
  // Convert to numbers for database/service calls
  const userIdNum = toNumber(userId);
  const threadIdNum = toNumber(threadId);
  const rawIcpProfileId = Number(icpProfile?.id);
  const approvedIcpProfileId = Number.isSafeInteger(rawIcpProfileId) && rawIcpProfileId > 0
    ? rawIcpProfileId
    : undefined;
  const targetThreadId = input.thread_id || threadIdNum;
  if (targetThreadId !== threadIdNum) {
    return { success: false, toolName: 'execute_lead_workflow', error: 'Lead execution must stay in the approved conversation.' };
  }
  
  if (targetThreadId) {
    stoppedThreads.delete(targetThreadId);
  }
  
  // Use workflows from input, context, or default to all
  const rawWorkflows = input.selected_workflows || selectedWorkflows || [];
  // Deduplicate workflow names (LLM may pass duplicates)
  let workflowsToExecute = [...new Set(rawWorkflows)];
  
  try {
    const { WorkflowExecutorService } = await import('../../../services/WorkflowExecutorService');
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
    const { createChatMessage } = await import('../../../models/chatMessages/functions');

    if (!input.leadInputSetId || !input.workflowRunId || !Number.isInteger(input.leadInputSetRevision)) {
      throw new Error('Approve the exact lead input revision before running a search.');
    }
    const { getApprovedLeadInputRecords } = await import('../../../models/conversationWorkflow/functions');
    const leadInputs = await getApprovedLeadInputRecords({
      id: input.leadInputSetId,
      revision: input.leadInputSetRevision!,
      runId: input.workflowRunId,
      userId: userIdNum,
      threadId: targetThreadId,
    });
    workflowsToExecute = [...new Set(leadInputs.map(row => row.platform))];
    
    if (!leadInputs?.length) {
      return {
        success: false,
        toolName: 'execute_lead_workflow',
        error: 'No lead inputs found. Generate inputs first using generate_lead_inputs.',
      };
    }

    // Helper: emit tool execution card and persist to chat
    // Dynamic display names: derive from workflow title, fallback to formatted platform key
    const getDisplayInfo = (platformKey: string): { name: string; verb: string } => {
      // Try to read title from the workflow file (cached in-memory via node require caching)
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fsSync = require('fs');
        const workflowPath = resolveWorkflowPath(platformKey);
        if (fsSync.existsSync(workflowPath)) {
          const wf = JSON.parse(fsSync.readFileSync(workflowPath, 'utf-8'));
          if (wf.title) {
            return { name: wf.title, verb: `Searching ${wf.title.replace(' Search', '')}` };
          }
        }
      } catch { /* use fallback */ }
      // Human-readable fallback: "twitter_post_search" → "Twitter Post Search"
      const humanName = platformKey.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return { name: humanName, verb: `Searching ${humanName}` };
    };

    const emitScrapingToolCard = async (
      platformKey: string,
      status: 'started' | 'completed' | 'failed',
       
      args: Record<string, any>,
      opts?: { error?: string; durationMs?: number; leadsCount?: number; displayNameOverride?: string; toolCallId?: string }
    ) => {
      const display = getDisplayInfo(platformKey);
      const displayName = opts?.displayNameOverride || display.name;
      const toolName = `apify_${platformKey}_scraper`;

      webSocketEmitter.emitToolExecution(userIdNum, targetThreadId, {
        toolName,
        toolCallId: opts?.toolCallId,
        args,
        status,
        agentType: 'lead_generation',
        error: opts?.error,
        durationMs: opts?.durationMs,
      });

      let content: string;
      if (status === 'started') {
        content = `**${displayName}**\n${display.verb}...`;
      } else if (status === 'completed') {
        const duration = opts?.durationMs ? ` in ${(opts.durationMs / 1000).toFixed(1)}s` : '';
        content = `**${displayName}** — Completed\nFound **${opts?.leadsCount ?? 0} leads**${duration}`;
      } else {
        content = `**${displayName}** — Failed\n${opts?.error || 'Unknown error'}`;
      }
      
      try {
         
        const metadata: Record<string, any> = status === 'started'
          ? { isToolCall: true, toolName, toolCallId: opts?.toolCallId, toolArgs: args }
          : { isToolResult: true, toolName, toolCallId: opts?.toolCallId, success: status === 'completed', toolArgs: args, toolOutput: opts };
        
        const persistedMessage = await createChatMessage({
          userId: userIdNum,
          threadId: targetThreadId,
          role: 'assistant',
          content,
          agentType: 'lead_generation',
          metadata,
        });
        webSocketEmitter.emitChatResponse(userIdNum, targetThreadId, {
          role: 'assistant',
          content,
          agentType: 'lead_generation',
          metadata: { ...metadata, responseId: `tool-${status}-${toolName}-${Date.now()}` },
        });
        const persistedMessageId = Number(persistedMessage?.id);
        return Number.isSafeInteger(persistedMessageId) && persistedMessageId > 0
          ? persistedMessageId
          : undefined;
      } catch (e) {
        logger.warn({ err: e }, '[Lead Executor] Failed to persist scraping tool card');
        return undefined;
      }
    };

    let totalLeads = 0;
    const reviewedLeadIds = new Set<number>();
    let wasCancelled = false;
    let scrapingBatchMessageId: number | undefined;
    const results: any[] = [];

    const recordGlobalLimitSkip = async ({
      platform,
      inputId,
      reviewedTotalLimit,
      resultKey,
    }: {
      platform: string;
      inputId: number | string;
      reviewedTotalLimit?: number;
      resultKey: 'platform' | 'workflow';
    }) => {
      const reason = `Skipped because the reviewed global lead limit of ${reviewedTotalLimit ?? totalLeads} was already reached.`;
      results.push({
        [resultKey]: platform,
        leadsCount: 0,
        success: true,
        status: 'skipped',
        reason: 'global_limit_reached',
      });

      let skippedMessageId: number | undefined;
      try {
        const skippedMessage = await createChatMessage({
          userId: userIdNum,
          threadId: targetThreadId,
          role: 'assistant',
          content: `**${getDisplayInfo(platform).name}** — Skipped\n${reason}`,
          agentType: 'lead_generation',
          metadata: {
            isToolResult: true,
            toolName: `apify_${platform}_scraper`,
            success: true,
            toolOutput: { status: 'skipped', leadsCount: 0, reason: 'global_limit_reached' },
          },
        });
        webSocketEmitter.emitChatResponse(userIdNum, targetThreadId, {
          role: 'assistant',
          content: `**${getDisplayInfo(platform).name}** — Skipped\n${reason}`,
          agentType: 'lead_generation',
          metadata: {
            isToolResult: true,
            toolName: `apify_${platform}_scraper`,
            success: true,
            toolOutput: { status: 'skipped', leadsCount: 0, reason: 'global_limit_reached' },
            responseId: `tool-skipped-${platform}-${Date.now()}`,
          },
        });
        const persistedMessageId = Number(skippedMessage?.id);
        if (Number.isSafeInteger(persistedMessageId) && persistedMessageId > 0) {
          skippedMessageId = persistedMessageId;
        }
      } catch (skipMessageError) {
        logger.warn({ err: skipMessageError, platform }, '[Lead Executor] Failed to persist global-limit skip message');
      }

      const messageId = scrapingBatchMessageId || skippedMessageId;
      if (!messageId) {
        logger.warn({ platform }, '[Lead Executor] Could not associate global-limit skip with a scraping batch');
        return;
      }
      try {
        const {
          createScrapingDetail,
          getScrapingDetailsByExecutionId,
          updateScrapingDetailByExecutionAndPlatform,
        } = await import('../../../models/scrapingDetails/functions');
        const executionId = `lead:${targetThreadId}:${inputId}:skipped`.slice(0, 255);
        const now = new Date();
        const existing = await getScrapingDetailsByExecutionId(executionId);
        const detail = {
          totalLeadsNeeded: reviewedTotalLimit || totalLeads,
          totalLeadsFound: 0,
          progress: '100.00',
          status: 'skipped',
          error: reason,
          startedAt: now,
          completedAt: now,
        };
        if (existing.some((row) => row.platform === platform)) {
          await updateScrapingDetailByExecutionAndPlatform(executionId, platform, detail);
        } else {
          await createScrapingDetail({
            messageId,
            threadId: targetThreadId,
            userId: userIdNum,
            executionId,
            platform,
            ...detail,
          });
        }
      } catch (skipPersistenceError) {
        logger.warn({ err: skipPersistenceError, platform }, '[Lead Executor] Failed to persist global-limit provider status');
      }
    };

    // If specific workflows are selected, execute them
    if (workflowsToExecute.length > 0) {
      webSocketEmitter.emit(userIdNum, 'workflow_started', {
        thread_id: targetThreadId,
        message: `Starting lead generation with ${workflowsToExecute.length} selected workflow(s)`,
        workflows: workflowsToExecute,
        platform: workflowsToExecute.length === 1 ? workflowsToExecute[0].replace(/_/g, ' ') : 'Multi-platform',
        source: 'Lead Generation',
      });

      // A single selected workflow can have multiple persisted search rows
      // (for example, one city/query per row). Execute every row from the
      // latest reviewed batch; deduplicating only by workflow name silently
      // dropped all but the first search.
      const workflowExecutionPlan: Array<{
        rawWorkflowName: string;
        platformInput: (typeof leadInputs)[number] | undefined;
      }> = [];
      for (const rawWorkflowName of workflowsToExecute) {
        const normalizedWorkflowName = normalizePlatformName(rawWorkflowName).toLowerCase();
        const matchingInputs = leadInputs.filter((inputRecord) =>
          inputRecord.platform.toLowerCase() === normalizedWorkflowName,
        );
        if (matchingInputs.length > 0) {
          workflowExecutionPlan.push(...matchingInputs.map((platformInput) => ({ rawWorkflowName, platformInput })));
        } else {
          workflowExecutionPlan.push({ rawWorkflowName, platformInput: undefined });
        }
      }

      const workflowTotal = workflowExecutionPlan.length;
      let workflowIndex = 0;
      const reviewedTotalLimit = workflowExecutionPlan.reduce<number | undefined>((current, step) => {
        const value = Number((step.platformInput?.schema as Record<string, unknown> | null)?.requestedLeadTotal);
        return Number.isSafeInteger(value) && value > 0 ? Math.max(current || 0, value) : current;
      }, undefined);
      let remainingReviewedLeads = reviewedTotalLimit;

      for (const executionStep of workflowExecutionPlan) {
        const { rawWorkflowName, platformInput: plannedPlatformInput } = executionStep;
        if (targetThreadId && stoppedThreads.has(targetThreadId)) {
          logger.info(`[Lead Executor] Thread ${targetThreadId} has been stopped. Breaking loop.`);
          wasCancelled = true;
          break;
        }
        workflowIndex++;
        if (remainingReviewedLeads !== undefined && remainingReviewedLeads <= 0) {
          logger.info({ reviewedTotalLimit }, '[Lead Executor] Reviewed lead total reached; skipping remaining workflows');
          const skippedPlatform = normalizePlatformName(rawWorkflowName);
          await recordGlobalLimitSkip({
            platform: skippedPlatform,
            inputId: plannedPlatformInput?.id || `${workflowIndex}-${skippedPlatform}`,
            reviewedTotalLimit,
            resultKey: 'workflow',
          });
          continue;
        }

        // Normalize workflow name through platform alias system (LLM may hallucinate suffixes like "_b2b")
        const workflowName = normalizePlatformName(rawWorkflowName);
        const scrapingToolCallId = `lead-${targetThreadId}-${workflowId || Date.now()}-${workflowIndex}-${workflowName}`;
        // Resolve workflow path from data/workflows/ directory
        const workflowPath = resolveWorkflowPath(workflowName);
        
        try {
          const workflowContent = await fs.readFile(workflowPath, 'utf-8');
          const workflow = JSON.parse(workflowContent);
          
          // Get the matching lead inputs for this platform
          const platformInput = plannedPlatformInput;
          if (!platformInput) {
            throw new Error(`No reviewed input row exists for selected workflow ${workflowName}. Regenerate and review its exact parameters before approval.`);
          }
          
          // Clone inputs so we don't mutate the original record
           
          const reviewedLimit = remainingReviewedLeads
            ?? Number((platformInput.schema as Record<string, unknown> | null)?.requestedLeadLimit);
          const persistedSchema = (platformInput.schema || {}) as Record<string, any>;
          const workflowInputs: Record<string, any> & { __requestedLeadLimit?: number } = {
            ...(platformInput.inputs as Record<string, any>),
            ...(Number.isSafeInteger(reviewedLimit) && reviewedLimit > 0
              ? { __requestedLeadLimit: reviewedLimit }
              : {}),
            __leadInputId: platformInput.id,
            __leadReviewConstraints: persistedSchema.reviewedConstraints || {
              regions: icpProfile?.primaryRegions || [],
              industry: icpProfile?.industry || icpProfile?.businessIndustry,
              subIndustry: icpProfile?.subIndustry,
              targetAudience: icpProfile?.targetAudience,
            },
          };

          const firstActorNode = workflow.nodes?.find((n: any) => n.type === 'actor');
          if (firstActorNode && platformInput.actorId && firstActorNode.data.actorId !== platformInput.actorId) {
            throw new Error(`Reviewed inputs for ${workflowName} belong to a different provider actor. Regenerate and review the exact parameters before approval.`);
          }

          const platformKey = (workflow.platform || workflowName).replace(/\s+/g, '_').toLowerCase();
          const scrapingArgs = { platform: workflow.platform || workflowName, actorId: firstActorNode?.data?.actorId, inputs: workflowInputs };
          const startTime = Date.now();

          const displayLabel = workflow.title || getDisplayInfo(platformKey).name;
          const indexLabel = workflowTotal > 1 ? ` (${workflowIndex}/${workflowTotal})` : '';

          const startedMessageId = await emitScrapingToolCard(platformKey, 'started', scrapingArgs, {
            displayNameOverride: `${displayLabel}${indexLabel}`,
            toolCallId: scrapingToolCallId,
          });
          if (!scrapingBatchMessageId && Number.isSafeInteger(Number(startedMessageId))) {
            scrapingBatchMessageId = Number(startedMessageId);
          }

          const executionId = `lead:${targetThreadId}:${platformInput.id}:${workflow.workflow_id || workflowName}`.slice(0, 255);
          const result = await WorkflowExecutorService.executeWorkflow(
            workflow,
            workflowInputs,
            userIdNum.toString(),
            targetThreadId,
            executionId,
            approvedIcpProfileId,
            platformInput?.messageId || undefined,
          );

          const { leadsCount, leadIds } = readLeadSaveReceipt(result.results?.db_save_results, result.status);
          const newlyReviewedCount = leadIds.filter(id => !reviewedLeadIds.has(id)).length;
          leadIds.forEach((id: number) => reviewedLeadIds.add(id));
          totalLeads = reviewedLeadIds.size;
          if (remainingReviewedLeads !== undefined) {
            remainingReviewedLeads = Math.max(0, remainingReviewedLeads - newlyReviewedCount);
          }
          results.push({ workflow: workflowName, title: workflow.title, leadsCount, leadIds, success: true, status: result.status });

          const durationMs = Date.now() - startTime;

          await emitScrapingToolCard(platformKey, 'completed', scrapingArgs, {
            leadsCount,
            durationMs,
            displayNameOverride: `${displayLabel}${indexLabel}`,
            toolCallId: scrapingToolCallId,
          });

          webSocketEmitter.emitWorkflowCompleted(
            userIdNum,
            workflow.platform || platformKey,
            `Found ${leadsCount} leads from ${workflow.title || workflowName}`,
            leadsCount,
            undefined,
            undefined,
            targetThreadId
          );
         
        } catch (e: any) {
          results.push({ workflow: workflowName, success: false, error: e.message });
          
          const failedPlatformKey = workflowName.replace(/\s+/g, '_').toLowerCase();
          const failedLabel = workflowName.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          const failIndexLabel = workflowTotal > 1 ? ` (${workflowIndex}/${workflowTotal})` : '';
          await emitScrapingToolCard(failedPlatformKey, 'failed', { workflow: workflowName }, {
            error: e.message,
            displayNameOverride: `${failedLabel}${failIndexLabel}`,
            toolCallId: scrapingToolCallId,
          });

          webSocketEmitter.emitWorkflowError(
            userIdNum,
            workflowName,
            `Failed to execute ${workflowName}`,
            e.message,
            undefined,
            targetThreadId
          );
        }
      }
    } else {
      // Deduplicate leadInputs by platform to ensure we only scrape each platform once
      const seenPlatforms = new Set<string>();
      const uniqueLeadInputs = leadInputs.filter(inp => {
        if (seenPlatforms.has(inp.platform)) {
          return false;
        }
        seenPlatforms.add(inp.platform);
        return true;
      });
      const reviewedTotalLimit = uniqueLeadInputs.reduce<number | undefined>((current, inputRecord) => {
        const value = Number((inputRecord.schema as Record<string, unknown> | null)?.requestedLeadTotal);
        return Number.isSafeInteger(value) && value > 0 ? Math.max(current || 0, value) : current;
      }, undefined);
      let remainingReviewedLeads = reviewedTotalLimit;

      // Fallback to original behavior - use platform workflows
      webSocketEmitter.emit(userIdNum, 'workflow_started', {
        thread_id: targetThreadId,
        message: `Starting lead generation across ${uniqueLeadInputs.length} platform(s)`,
        platforms: uniqueLeadInputs.map(i => i.platform),
        platform: uniqueLeadInputs.length > 0 ? uniqueLeadInputs[0].platform : 'Lead Generation',
        source: 'Lead Generation',
      });

      // Count inputs per platform so we can label searches "(1/3)", "(2/3)" etc.
      const platformRunCounts: Record<string, number> = {};
      const platformRunIndexes: Record<string, number> = {};
      for (const inp of uniqueLeadInputs) {
        platformRunCounts[inp.platform] = (platformRunCounts[inp.platform] || 0) + 1;
      }

      for (const inputRecord of uniqueLeadInputs) {
        if (targetThreadId && stoppedThreads.has(targetThreadId)) {
          logger.info(`[Lead Executor] Thread ${targetThreadId} has been stopped. Breaking loop.`);
          wasCancelled = true;
          break;
        }
        if (remainingReviewedLeads !== undefined && remainingReviewedLeads <= 0) {
          logger.info({ reviewedTotalLimit }, '[Lead Executor] Reviewed lead total reached; skipping remaining platforms');
          await recordGlobalLimitSkip({
            platform: inputRecord.platform,
            inputId: inputRecord.id,
            reviewedTotalLimit,
            resultKey: 'platform',
          });
          continue;
        }
        platformRunIndexes[inputRecord.platform] = (platformRunIndexes[inputRecord.platform] || 0) + 1;
        const runIdx = platformRunIndexes[inputRecord.platform];
        const runTotal = platformRunCounts[inputRecord.platform];

        const platformName = inputRecord.platform.replace(/\s+/g, '_').toLowerCase();
        const scrapingToolCallId = `lead-${targetThreadId}-${workflowId || Date.now()}-${runIdx}-${platformName}`;
        const workflowPath = resolveWorkflowPath(platformName);

        // Build display name override for multi-search labeling
        const baseDisplayName = getDisplayInfo(platformName).name;
        const displayNameOverride = runTotal > 1 ? `${baseDisplayName} (${runIdx}/${runTotal})` : undefined;

        try {
          const startTime = Date.now();
          
          // Read the workflow to get actorId for the tool card
          const workflowContent = await fs.readFile(workflowPath, 'utf-8');
          const workflow = JSON.parse(workflowContent);
           
          const actorNode = workflow.nodes?.find((n: any) => n.type === 'actor');
          const scrapingArgs = { platform: inputRecord.platform, actorId: actorNode?.data?.actorId, inputs: inputRecord.inputs };

          const startedMessageId = await emitScrapingToolCard(platformName, 'started', scrapingArgs, {
            displayNameOverride,
            toolCallId: scrapingToolCallId,
          });
          if (!scrapingBatchMessageId && Number.isSafeInteger(Number(startedMessageId))) {
            scrapingBatchMessageId = Number(startedMessageId);
          }

          const persistedSchema = (inputRecord.schema || {}) as Record<string, any>;
          const reviewedInputs = {
            ...(inputRecord.inputs as Record<string, any>),
            ...(remainingReviewedLeads === undefined ? {} : { __requestedLeadLimit: remainingReviewedLeads }),
            __leadInputId: inputRecord.id,
            __leadReviewConstraints: persistedSchema.reviewedConstraints || {
              regions: icpProfile?.primaryRegions || [],
              industry: icpProfile?.industry || icpProfile?.businessIndustry,
              subIndustry: icpProfile?.subIndustry,
              targetAudience: icpProfile?.targetAudience,
            },
          };
          const executionId = `lead:${targetThreadId}:${inputRecord.id}:${workflow.workflow_id || platformName}`.slice(0, 255);
          const result = await WorkflowExecutorService.executeWorkflow(
            workflow,
            reviewedInputs,
            userIdNum.toString(),
            targetThreadId,
            executionId,
            approvedIcpProfileId,
            inputRecord.messageId || undefined,
          );

          const { leadsCount, leadIds } = readLeadSaveReceipt(result.results?.db_save_results, result.status);
          const newlyReviewedCount = leadIds.filter(id => !reviewedLeadIds.has(id)).length;
          leadIds.forEach((id: number) => reviewedLeadIds.add(id));
          totalLeads = reviewedLeadIds.size;
          if (remainingReviewedLeads !== undefined) {
            remainingReviewedLeads = Math.max(0, remainingReviewedLeads - newlyReviewedCount);
          }
          results.push({ platform: inputRecord.platform, leadsCount, leadIds, success: true, status: result.status });

          const durationMs = Date.now() - startTime;

          await emitScrapingToolCard(platformName, 'completed', scrapingArgs, {
            leadsCount,
            durationMs,
            displayNameOverride,
            toolCallId: scrapingToolCallId,
          });

          webSocketEmitter.emitWorkflowCompleted(
            userIdNum,
            inputRecord.platform,
            `Found ${leadsCount} leads from ${displayNameOverride || inputRecord.platform}`,
            leadsCount,
            undefined,
            undefined,
            targetThreadId
          );
         
        } catch (e: any) {
          results.push({ platform: inputRecord.platform, success: false, error: e.message });

          await emitScrapingToolCard(platformName, 'failed', { platform: inputRecord.platform }, {
            error: e.message,
            displayNameOverride,
            toolCallId: scrapingToolCallId,
          });

          webSocketEmitter.emitWorkflowError(
            userIdNum,
            inputRecord.platform,
            `Failed to scrape ${inputRecord.platform}`,
            e.message,
            undefined,
            targetThreadId
          );
        }
      }
    }

    // Emit execution summary so LeadsTab transitions out of "Extracting data..." state
    const skippedResults = results.filter(r => r.status === 'skipped');
    const successfulResults = results.filter(r => r.success && r.status !== 'skipped');
    const failedResults = results.filter(r => !r.success);
    const hasPartialResult = results.some((result) => result.status === 'partial_success');
    const outcome = wasCancelled
      ? 'cancelled'
      : successfulResults.length === 0
        ? 'failed'
        : failedResults.length > 0 || hasPartialResult
          ? 'partial_success'
          : totalLeads === 0
            ? 'succeeded_empty'
            : 'succeeded';
    const isSuccessfulOutcome = outcome === 'succeeded'
      || outcome === 'succeeded_empty'
      || outcome === 'partial_success';
    const terminalError = outcome === 'failed'
      ? failedResults.length === 1
        ? failedResults[0].error || 'The lead search could not run, so no leads were saved.'
        : failedResults
          .map(result => {
            // Workflow IDs such as linkedin_company_search, read as words.
            const source = String(result.platform || result.workflow || 'Lead search').replace(/[_-]+/g, ' ');
            return `${source}: ${result.error || 'The lead search could not run, so no leads were saved.'}`;
          })
          .join('; ')
      : undefined;

    webSocketEmitter.emitExecutionSummary(
      userIdNum,
      {
        status: outcome,
        total_leads: totalLeads,
        lead_ids: [...reviewedLeadIds],
        successful_platforms: successfulResults.length,
        failed_platforms: failedResults.length,
        skipped_platforms: skippedResults.length,
        results: results.map(r => ({
          platform: r.platform || r.workflow || 'unknown',
          success: r.success,
          status: r.status,
          leads_count: r.leadsCount || 0,
          error: r.error,
          reason: r.reason,
        })),
      },
      undefined,
      targetThreadId
    );

    // Open leads tab
    webSocketEmitter.emit(userIdNum, 'open_tab', {
      thread_id: toNumber(context.threadId),
      tabType: TAB_TYPES.LEADS,
      tabLabel: TAB_LABELS[TAB_TYPES.LEADS],
      data: { threadId: targetThreadId, totalLeads, leadIds: [...reviewedLeadIds], status: outcome, platformResults: results },
    });

    return {
      success: isSuccessfulOutcome,
      toolName: 'execute_lead_workflow',
      ...(terminalError ? { error: terminalError } : {}),
      output: {
        status: outcome,
        totalLeads,
        leadIds: [...reviewedLeadIds],
        platformResults: results,
        message: outcome === 'failed'
          ? `Lead generation failed across all ${results.length} workflow(s).`
          : outcome === 'cancelled'
            ? `Lead generation was cancelled after finding ${totalLeads} leads.`
            : outcome === 'partial_success'
              ? `Lead generation partially completed. Found ${totalLeads} leads across ${successfulResults.length} successful workflow(s); ${failedResults.length} failed.`
              : totalLeads === 0
                ? `Search finished with no matching leads. No leads were saved.`
                : `Lead generation completed. Found ${totalLeads} leads across ${successfulResults.length} executed platform(s)${skippedResults.length > 0 ? `; ${skippedResults.length} selected platform(s) skipped after the global limit was reached` : ''}.`,
      },
    };
   
  } catch (error: any) {
    logger.error({ err: error }, '[Lead Executor] Workflow error');

    const userIdForError = typeof userId === 'string' ? parseInt(userId, 10) : userId;
    const threadIdForError = typeof threadId === 'string' ? parseInt(threadId, 10) : threadId;

    if (!isNaN(userIdForError) && threadIdForError) {
      try {
        const { createChatMessage } = await import('../../../models/chatMessages/functions');
        const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
        const errorMsg = `The lead search couldn't finish: ${userFacingReason(error)}.`;
        await createChatMessage({
          userId: userIdForError,
          threadId: threadIdForError,
          role: 'assistant',
          content: errorMsg,
          agentType: 'lead_generation',
        });
        webSocketEmitter.emitChatResponse(userIdForError, threadIdForError, {
          role: 'assistant',
          content: errorMsg,
          agentType: 'lead_generation',
          metadata: { responseId: `lead-workflow-error-${Date.now()}` },
        });
      } catch (dbErr) {
        logger.warn({ err: dbErr }, '[Lead Executor] Failed to persist workflow error message');
      }
    }

    // Emit execution summary with error so LeadsTab stops showing "Extracting data..."
    if (!isNaN(userIdForError)) {
      const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
      webSocketEmitter.emitExecutionSummary(
        userIdForError,
        {
          status: 'failed',
          total_leads: 0,
          successful_platforms: 0,
          failed_platforms: 1,
          results: [{ platform: 'unknown', success: false, leads_count: 0, error: error.message }],
        },
        undefined,
        typeof threadId === 'string' ? parseInt(threadId, 10) : threadId
      );
    }

    return {
      success: false,
      toolName: 'execute_lead_workflow',
      error: error.message,
    };
  }
}

const activeLeadWorkflowExecutions = new Map<string, Promise<ToolResult>>();

export async function executeLeadWorkflow(
  input: ExecuteLeadWorkflowInput,
  context: ToolContext
): Promise<ToolResult> {
  const targetThreadId = toNumber(input.thread_id || context.threadId);
  // One campaign can only have one active lead-generation approval at a time.
  // Realtime delivery can invoke this entry point with different equivalent
  // payload shapes, so workflow-specific keys still permit duplicate actors.
  const executionKey = `${toNumber(context.userId)}:${targetThreadId}`;
  const activeExecution = activeLeadWorkflowExecutions.get(executionKey);
  if (activeExecution) {
    logger.warn({ executionKey }, '[Lead Executor] Coalescing duplicate active lead workflow request');
    return activeExecution;
  }

  const execution = executeLeadWorkflowOnce(input, context);
  activeLeadWorkflowExecutions.set(executionKey, execution);
  try {
    return await execution;
  } finally {
    if (activeLeadWorkflowExecutions.get(executionKey) === execution) {
      activeLeadWorkflowExecutions.delete(executionKey);
    }
  }
}

// ─── Search cost estimate (read-only) ─────────────────────────────────────
const RESULT_LIMIT_FIELDS = ['maxCrawledPlacesPerSearch', 'maxItems', 'resultsLimit', 'maxResults', 'limit', 'maxProfiles', 'maxPosts'];

/** Results a reviewed input asks for: per-search cap × number of searches. */
function requestedResultsFromInputs(inputs: unknown): number | null {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return null;
  const record = inputs as Record<string, unknown>;
  if (Array.isArray(record.searches)) {
    const parts = record.searches.map(requestedResultsFromInputs).filter((n): n is number => n !== null);
    return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  }
  const cap = RESULT_LIMIT_FIELDS.map(field => Number(record[field])).find(n => Number.isFinite(n) && n > 0);
  if (!cap) return null;
  const searches = Array.isArray(record.searchStringsArray) && record.searchStringsArray.length ? record.searchStringsArray.length : 1;
  return Math.round(cap * searches);
}

export async function estimateLeadSearchCost(
  input: { result_count?: number },
  context: ToolContext,
): Promise<ToolResult> {
  const userId = toNumber(context.userId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leadInputs = (context.leadInputs || []) as any[];
  const actors = new Map<string, string>();
  for (const leadInput of leadInputs) if (leadInput?.actorId) actors.set(String(leadInput.actorId), String(leadInput.actorName || leadInput.actorId));
  const pendingSearch = context.pendingApproval?.toolName === 'execute_lead_workflow' ? context.pendingApproval : null;
  const pendingArgs = (pendingSearch?.args || {}) as { selected_workflows?: unknown; platforms?: unknown };
  const asStrings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  if (!actors.size) {
    for (const workflowId of [...new Set([...asStrings(pendingArgs.selected_workflows), ...(context.selectedWorkflows || [])])]) {
      const channel = String(workflowId).split('_')[0].toLowerCase();
      const match = (await getChannelWorkflows(channel)).find(w => w.fileName === workflowId || w.workflowId === workflowId);
      if (match?.firstActorId) actors.set(match.firstActorId, match.firstActorName || match.title);
    }
  }
  if (!actors.size) {
    // A platform with exactly one workflow identifies its scraper.
    for (const platform of asStrings(pendingArgs.platforms)) {
      const workflows = (await getChannelWorkflows(platform.split('_')[0].toLowerCase())).filter(w => w.platform === platform || w.fileName === platform);
      if (workflows.length === 1 && workflows[0].firstActorId) actors.set(workflows[0].firstActorId, workflows[0].firstActorName || workflows[0].title);
    }
  }
  if (!actors.size && pendingSearch) {
    return { success: true, toolName: 'estimate_lead_search_cost', output: { status: 'no_history', requestedResults: input.result_count ?? null, estimates: [], totalEstimatedCredits: null,
      basis: 'A search review is waiting for your approval, but its scraper could not be identified for an estimate. Credits are charged on the actual Apify usage after the run, and nothing is charged before you approve.' } };
  }
  if (!actors.size) {
    return { success: true, toolName: 'estimate_lead_search_cost', output: { status: 'no_search_settings',
      message: 'No reviewed search settings were found, so there is nothing to estimate yet. Prepare the search settings first.' } };
  }
  const fromInputs = leadInputs.map(li => requestedResultsFromInputs(li?.inputs)).filter((n): n is number => n !== null);
  const requested = (Number.isInteger(input.result_count) && input.result_count! > 0 ? input.result_count
    : context.intentAnalysis?.semanticRequest?.lead?.limit) || (fromInputs.length ? fromInputs.reduce((a, b) => a + b, 0) : null);

  const { getActorRunHistory, getActorRunHistoryAllAccounts } = await import('../../../models/apifyUsages/functions.js');
  const { estimateCreditsFromCostCents } = await import('../../../services/CreditDeductionHooks.js');
  const history = await getActorRunHistory(userId, [...actors.keys()]);
  const missing = [...actors.keys()].filter(actorId => !history.some(h => h.actorId === actorId && h.items > 0));
  // An account's first search falls back to every account's runs of the same
  // scraper (totals only), and only when enough runs exist to average.
  const shared = missing.length ? (await getActorRunHistoryAllAccounts(missing).catch(() => [])).filter(h => h.runs >= 3 && h.items > 0) : [];
  const estimates = [];
  for (const [actorId, actorName] of actors) {
    const own = history.find(h => h.actorId === actorId && h.items > 0);
    const past = own || shared.find(h => h.actorId === actorId);
    if (!past || past.items <= 0) { estimates.push({ actorName, pastRuns: 0 }); continue; }
    const costPerResultCents = past.costCents / past.items;
    const credits = requested ? await estimateCreditsFromCostCents(costPerResultCents * requested) : null;
    estimates.push({
      actorName, source: own ? 'your_runs' : 'all_accounts', pastRuns: past.runs, pastResults: past.items,
      creditsPer100Results: await estimateCreditsFromCostCents(costPerResultCents * 100),
      requestedResults: requested, estimatedCredits: credits,
      typicalMinutes: past.avgDurationMs ? Math.max(1, Math.round(past.avgDurationMs / 60000)) : null,
      longestMinutes: past.maxDurationMs ? Math.max(1, Math.round(past.maxDurationMs / 60000)) : null,
    });
  }
  const known = estimates.filter(e => e.pastRuns > 0);
  return {
    success: true,
    toolName: 'estimate_lead_search_cost',
    output: {
      status: known.length ? 'estimated' : 'no_history',
      requestedResults: requested,
      estimates,
      totalEstimatedCredits: known.length && known.every(e => typeof e.estimatedCredits === 'number')
        ? known.reduce((sum, e) => sum + (e.estimatedCredits as number), 0) : null,
      basis: known.length
        ? `Average cost and run time of ${known.every(e => e.source === 'your_runs') ? 'your own' : known.some(e => e.source === 'your_runs') ? "your own and, where you have none, all accounts'" : "all accounts'"} successful past runs of the same scraper in the last 180 days. The actual charge is the real Apify usage after the run.`
        : 'There are no past runs of this scraper to estimate from yet. Credits are charged on the actual Apify usage after the run, and nothing is charged before you approve.',
    },
  };
}
