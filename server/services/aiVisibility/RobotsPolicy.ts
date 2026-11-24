export interface RobotsRule {
  path: string;
  allow: boolean;
  /** 1-based line in robots.txt, kept so findings can cite the exact directive. */
  line?: number;
}
export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

/** Product token the audit crawler announces and obeys. Shared by crawl discovery and SEO findings. */
export const AUDIT_CRAWLER_TOKEN = 'SalesMarketingBot';

/** Parse groups once, then share the same policy between crawl discovery and SEO findings. */
export function parseRobotsPolicy(body: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let hasDirectives = false;
  // A UTF-8 byte-order mark would otherwise hide the first User-agent line.
  const lines = (body.charCodeAt(0) === 0xfeff ? body.slice(1) : body).split(/\r\n|\r|\n/);
  lines.forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) return;
    const [, key, value] = match;
    if (key.toLowerCase() === 'user-agent') {
      if (!current || hasDirectives) {
        current = { agents: [], rules: [] };
        groups.push(current);
        hasDirectives = false;
      }
      // "User-agent: ExampleBot/2.1" names the ExampleBot product; versions are ignored.
      current.agents.push(value.trim().split('/')[0].trim().toLowerCase());
    } else if (current && /^(allow|disallow)$/i.test(key)) {
      hasDirectives = true;
      if (value)
        current.rules.push({
          path: value.trim(),
          allow: key.toLowerCase() === 'allow',
          line: index + 1,
        });
    }
  });
  return groups;
}

export interface RobotsDecision {
  allowed: boolean;
  /** User-agent lines of the group that governed the decision; empty when no group applies. */
  group: string[];
  /** The longest matching rule, or undefined when nothing matched (allowed by default). */
  rule?: RobotsRule;
}

/**
 * Extract the product token ("SalesMarketingBot") from a full user-agent string
 * ("Mozilla/5.0 (compatible; SalesMarketingBot/1.0)"). Robots groups match product
 * tokens, never the Mozilla prefix, so matching the full string causes false matches.
 */
function productToken(userAgent: string): string {
  const compatible = /compatible;\s*([^/;)\s]+)/i.exec(userAgent);
  if (compatible) return compatible[1].toLowerCase();
  return userAgent.split('/')[0].trim().toLowerCase();
}

function encodePath(value: string): string {
  // Compare both sides in the same percent-encoded form (RFC 9309 section 2.2.2).
  try {
    return encodeURI(decodeURI(value));
  } catch {
    return value;
  }
}

export function explainRobots(
  url: string,
  groups: RobotsGroup[],
  userAgent: string = AUDIT_CRAWLER_TOKEN,
): RobotsDecision {
  let target: string;
  try {
    const parsed = new URL(url);
    target = parsed.pathname + parsed.search;
  } catch {
    return { allowed: false, group: [] };
  }
  const agent = productToken(userAgent);
  const matches = groups.map((group) => ({
    group,
    specificity: Math.max(
      -1,
      ...group.agents.map((name) =>
        name === '*'
          ? 0
          : name && (agent === name || agent.startsWith(`${name}-`))
            ? name.length
            : -1,
      ),
    ),
  }));
  const mostSpecific = Math.max(-1, ...matches.map((match) => match.specificity));
  if (mostSpecific < 0) return { allowed: true, group: [] };
  const governing = matches.filter((match) => match.specificity === mostSpecific);
  let winner: { length: number; rule: RobotsRule } | undefined;
  for (const { group } of governing) {
    for (const rule of group.rules) {
      const anchored = rule.path.endsWith('$');
      const rulePath = encodePath(anchored ? rule.path.slice(0, -1) : rule.path);
      const pattern = rulePath
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      if (!new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(encodePath(target))) continue;
      const length = rule.path.replace(/[*$]/g, '').length;
      if (!winner || length > winner.length || (length === winner.length && rule.allow))
        winner = { length, rule };
    }
  }
  return {
    allowed: winner?.rule.allow ?? true,
    group: [...new Set(governing.flatMap(({ group }) => group.agents))],
    rule: winner?.rule,
  };
}

export type CrawlerPurpose = 'search' | 'ai_search' | 'ai_user' | 'ai_training';

/** Crawlers whose access decides whether a site can appear in search and AI answers. */
export const KNOWN_CRAWLERS: Array<{ token: string; owner: string; purpose: CrawlerPurpose }> = [
  { token: 'Googlebot', owner: 'Google', purpose: 'search' },
  { token: 'Bingbot', owner: 'Microsoft', purpose: 'search' },
  { token: 'OAI-SearchBot', owner: 'OpenAI', purpose: 'ai_search' },
  { token: 'ChatGPT-User', owner: 'OpenAI', purpose: 'ai_user' },
  { token: 'PerplexityBot', owner: 'Perplexity', purpose: 'ai_search' },
  { token: 'Claude-SearchBot', owner: 'Anthropic', purpose: 'ai_search' },
  { token: 'GPTBot', owner: 'OpenAI', purpose: 'ai_training' },
  { token: 'ClaudeBot', owner: 'Anthropic', purpose: 'ai_training' },
  { token: 'Google-Extended', owner: 'Google', purpose: 'ai_training' },
  { token: 'CCBot', owner: 'Common Crawl', purpose: 'ai_training' },
];

export interface CrawlerAccess {
  crawler: string;
  owner: string;
  purpose: CrawlerPurpose;
  allowed: boolean;
  /** The directive that decided access, e.g. "Disallow: /". */
  rule?: string;
  line?: number;
  group: string[];
}

export function describeRule(rule: RobotsRule | undefined): string | undefined {
  return rule ? `${rule.allow ? 'Allow' : 'Disallow'}: ${rule.path}` : undefined;
}

export function crawlerAccess(url: string, groups: RobotsGroup[]): CrawlerAccess[] {
  return KNOWN_CRAWLERS.map(({ token, owner, purpose }) => {
    const decision = explainRobots(url, groups, token);
    return {
      crawler: token,
      owner,
      purpose,
      allowed: decision.allowed,
      rule: describeRule(decision.rule),
      line: decision.rule?.line,
      group: decision.group,
    };
  });
}

export function robotsAllows(
  url: string,
  groups: RobotsGroup[],
  userAgent: string = AUDIT_CRAWLER_TOKEN,
): boolean {
  return explainRobots(url, groups, userAgent).allowed;
}
