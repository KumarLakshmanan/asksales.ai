/**
 * Conversational message detection.
 *
 * Reads greetings.json once at module load and caches per-locale regexes.
 * Used by the Mastra orchestrator to short-circuit specialist agent routing
 * for simple greetings and acknowledgements.
 *
 * What this file does:
 *   1. Reads `greetings.json` once at module load.
 *   2. Caches a per-locale regex on the result so the regex compile
 *      cost is paid once, not per call.
 *   3. Falls back to the `en` locale if the requested locale is missing.
 */

import greetings from './greetings.json' with { type: 'json' };
import { escapeRegExp as escape } from '../../utils/matchText.js';

interface LocaleConfig {
  conversationalPhrases: string[];
  taskKeywords: string[];
}

interface GreetingsConfig {
  locales: Record<string, LocaleConfig>;
  defaults: { maxShortMessageLength: number };
}

const config: GreetingsConfig = greetings as GreetingsConfig;
const compiledRegex = new Map<string, { conversational: RegExp; task: RegExp; maxLen: number }>();

function compileLocale(locale: string): { conversational: RegExp; task: RegExp; maxLen: number } {
  const cached = compiledRegex.get(locale);
  if (cached) return cached;

  // Fall back to English if the requested locale is missing.
  const data = config.locales[locale] ?? config.locales.en;
  if (!data) {
    throw new Error(`[greetings] locale "${locale}" and "en" both missing from config`);
  }

  const conversational = new RegExp(
    `^(${data.conversationalPhrases.map(escape).join('|')})([.!?,;:\\s]|$)`,
    'i',
  );
  const task = new RegExp(`\\b(${data.taskKeywords.map(escape).join('|')})\\b`, 'i');
  const compiled = {
    conversational,
    task,
    maxLen: config.defaults.maxShortMessageLength,
  };
  compiledRegex.set(locale, compiled);
  return compiled;
}

/**
 * Detect whether a message is a greeting / short conversational filler
 * that should NOT trigger specialist tool calls.
 *
 * Two-tier check:
 *   1. Short messages (≤ maxShortMessageLength): must match the
 *      conversational pattern.
 *   2. Longer messages: must match the conversational pattern AND
 *      must NOT contain any task keyword.
 */
export function isConversationalMessage(content: string, locale: string = 'en'): boolean {
  if (!content) return false;
  const cleaned = content.trim().toLowerCase();
  if (cleaned.length === 0) return false;

  const { conversational, task, maxLen } = compileLocale(locale);

  if (cleaned.length <= maxLen) {
    return conversational.test(cleaned);
  }
  return conversational.test(cleaned) && !task.test(cleaned);
}

/**
 * Test-helper: returns the list of locales the loader knows about.
 * Exported so unit tests can iterate over all locales.
 */
export function listLocales(): string[] {
  return Object.keys(config.locales);
}
