import {
  PLATFORM_MODULES,
  isPlatformModuleKey,
  isPlatformModuleStatus,
  isUserModuleMode,
  type PlatformModuleKey,
  type PlatformModuleStatus,
  type UserModuleMode,
} from './platformModules.js';
import { asRecordOrNull as record } from '../../shared/records.js';

const DEFAULT_MAINTENANCE_MESSAGE = 'We are performing scheduled maintenance. Please try again shortly.';

function cleanMessage(value: unknown, field: string, allowEmpty = true): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const message = value.trim();
  if (!allowEmpty && !message) throw new Error(`${field} is required`);
  if (message.length > 500) throw new Error(`${field} must be 500 characters or fewer`);
  return message || null;
}

export interface PlatformControlsInput {
  maintenance?: { enabled: boolean; message: string };
  modules?: Array<{ key: PlatformModuleKey; status: PlatformModuleStatus; message: string | null }>;
}

export function parsePlatformControlsInput(value: unknown): PlatformControlsInput {
  const input = record(value);
  if (!input) throw new Error('Request body must be an object');
  const allowed = new Set(['maintenance', 'modules']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('Request contains unsupported fields');
  if (input.maintenance === undefined && input.modules === undefined) {
    throw new Error('At least one platform control must be provided');
  }

  const output: PlatformControlsInput = {};
  if (input.maintenance !== undefined) {
    const maintenance = record(input.maintenance);
    if (!maintenance || typeof maintenance.enabled !== 'boolean') {
      throw new Error('maintenance.enabled must be a boolean');
    }
    if (Object.keys(maintenance).some((key) => !['enabled', 'message'].includes(key))) {
      throw new Error('maintenance contains unsupported fields');
    }
    const message = cleanMessage(maintenance.message, 'maintenance.message', !maintenance.enabled);
    output.maintenance = {
      enabled: maintenance.enabled,
      message: message || DEFAULT_MAINTENANCE_MESSAGE,
    };
  }

  if (input.modules !== undefined) {
    if (!Array.isArray(input.modules) || input.modules.length > PLATFORM_MODULES.length) {
      throw new Error(`modules must contain at most ${PLATFORM_MODULES.length} entries`);
    }
    const seen = new Set<string>();
    output.modules = input.modules.map((raw) => {
      const module = record(raw);
      if (!module || Object.keys(module).some((key) => !['key', 'status', 'message'].includes(key))) {
        throw new Error('Each module must contain only key, status, and message');
      }
      if (!isPlatformModuleKey(module.key)) throw new Error(`Unknown module key: ${String(module.key)}`);
      if (!isPlatformModuleStatus(module.status)) throw new Error(`Invalid status for module ${module.key}`);
      if (seen.has(module.key)) throw new Error(`Duplicate module key: ${module.key}`);
      seen.add(module.key);
      const message = cleanMessage(module.message, `modules.${module.key}.message`);
      return { key: module.key, status: module.status, message };
    });
  }
  return output;
}

export function parseUserModuleAccessInput(value: unknown): Array<{ key: PlatformModuleKey; mode: UserModuleMode }> {
  const input = record(value);
  if (!input || Object.keys(input).some((key) => key !== 'modules') || !Array.isArray(input.modules)) {
    throw new Error('modules must be an array');
  }
  if (input.modules.length !== PLATFORM_MODULES.length) {
    throw new Error(`modules must contain all ${PLATFORM_MODULES.length} platform modules`);
  }
  const seen = new Set<string>();
  const modules = input.modules.map((raw) => {
    const module = record(raw);
    if (!module || Object.keys(module).some((key) => !['key', 'mode'].includes(key))) {
      throw new Error('Each user module entry must contain only key and mode');
    }
    if (!isPlatformModuleKey(module.key)) throw new Error(`Unknown module key: ${String(module.key)}`);
    if (!isUserModuleMode(module.mode)) throw new Error(`Invalid mode for module ${module.key}`);
    if (seen.has(module.key)) throw new Error(`Duplicate module key: ${module.key}`);
    seen.add(module.key);
    return { key: module.key, mode: module.mode };
  });
  if (PLATFORM_MODULES.some((module) => !seen.has(module.key))) throw new Error('modules must contain every platform module');
  return modules;
}
