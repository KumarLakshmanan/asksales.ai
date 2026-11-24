export function sanitizePromptInput(input: string, maxLength: number = 5000): string {
  if (!input || typeof input !== 'string') return '';

  // Truncate to max length
  let sanitized = input.slice(0, maxLength);

  // Remove potential instruction override patterns (case-insensitive)
  const injectionPatterns = [
    /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
    /forget\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
    /disregard\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
    /you\s+are\s+now\s+a/gi,
    /act\s+as\s+(if\s+you\s+are\s+)?a/gi,
    /system\s*:\s*/gi,
    /assistant\s*:\s*/gi,
    /user\s*:\s*/gi,
    /\[INST\]/gi,
    /\[\/INST\]/gi,
    /<\|im_start\|>/gi,
    /<\|im_end\|>/gi,
    /<\|system\|>/gi,
    /<\|endoftext\|>/gi,
    /```system/gi,
    /```assistant/gi,
    // Role marker injections
    /^Human\s*:/gim,
    /^AI\s*:/gim,
    /^Assistant\s*:/gim,
    // Separator-based injections
    /\n{2,}---+\n{2,}/g,
    /\n{2,}===+\n{2,}/g,
    // New instruction header patterns
    /new\s+(system\s+)?instructions?\s*[:：]/gi,
    /updated?\s+(system\s+)?instructions?\s*[:：]/gi,
  ];

  for (const pattern of injectionPatterns) {
    sanitized = sanitized.replace(pattern, '[filtered]');
  }

  // Remove excessive newlines that could be used to visually separate injections
  sanitized = sanitized.replace(/\n{4,}/g, '\n\n\n');

  // Escape backticks to prevent code block injection
  sanitized = sanitized.replace(/`{3,}/g, '\\`\\`\\`');

  return sanitized.trim();
}
