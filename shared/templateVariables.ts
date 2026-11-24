/** Canonical content-template variable catalog shared by preview and delivery. */
export const CANONICAL_TEMPLATE_VARIABLES = [
  'first_name',
  'last_name',
  'full_name',
  'email',
  'phone',
  'company_name',
  'company_industry',
  'company_size',
  'company_website',
  'company_location',
  'job_title',
  'department',
  'your_company_name',
  'your_industry',
  'value_proposition',
  'your_website',
  'target_audience',
  'pain_point',
  'budget_range',
  'current_date',
  'current_year',
  'current_month',
  'link',
  'unsubscribe_link',
] as const;

export type CanonicalTemplateVariable = typeof CANONICAL_TEMPLATE_VARIABLES[number];

const variableAliases: Record<string, CanonicalTemplateVariable> = {
  firstname: 'first_name',
  first_name: 'first_name',
  lastname: 'last_name',
  last_name: 'last_name',
  fullname: 'full_name',
  full_name: 'full_name',
  email: 'email',
  phone: 'phone',
  company: 'company_name',
  companyname: 'company_name',
  company_name: 'company_name',
  companyindustry: 'company_industry',
  company_industry: 'company_industry',
  industry: 'company_industry',
  companysize: 'company_size',
  company_size: 'company_size',
  companywebsite: 'company_website',
  company_website: 'company_website',
  companylocation: 'company_location',
  company_location: 'company_location',
  role: 'job_title',
  title: 'job_title',
  jobtitle: 'job_title',
  job_title: 'job_title',
  department: 'department',
  yourcompanyname: 'your_company_name',
  your_company_name: 'your_company_name',
  yourindustry: 'your_industry',
  your_industry: 'your_industry',
  valueproposition: 'value_proposition',
  value_proposition: 'value_proposition',
  yourwebsite: 'your_website',
  your_website: 'your_website',
  targetaudience: 'target_audience',
  target_audience: 'target_audience',
  painpoint: 'pain_point',
  pain_point: 'pain_point',
  budgetrange: 'budget_range',
  budget_range: 'budget_range',
  currentdate: 'current_date',
  current_date: 'current_date',
  currentyear: 'current_year',
  current_year: 'current_year',
  currentmonth: 'current_month',
  current_month: 'current_month',
  link: 'link',
  unsubscribelink: 'unsubscribe_link',
  unsubscribe_link: 'unsubscribe_link',
};

// Saved templates can contain picker display labels such as {{First Name}}.
// Accept those only when they map to a known variable; keep typos blocked.
export const TEMPLATE_TOKEN_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.\- \t\u00a0]*)\s*\}\}/g;

// Scan every brace construct so malformed or unfinished tokens cannot pass approval.
export function scanTemplateTokens(content: string): Array<{ token: string; name: string; valid: boolean }> {
  content = decodeTemplateBraces(content);
  return [...content.matchAll(/\{\{[\s\S]*?(?:\}\}|$)|\}\}/g)].map(([token]) => {
    const match = /^\{\{\s*([a-zA-Z][a-zA-Z0-9_.\- \t\u00a0]*)\s*\}\}$/.exec(token);
    const name = match?.[1].trim();
    const valid = Boolean(name && (/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(name) || canonicalizeTemplateVariable(name)));
    return { token, name: name ?? token, valid };
  });
}

function normalizedVariableName(value: string): string {
  return value.trim().toLowerCase().replace(/[.\s-]+/g, '_');
}

export function canonicalizeTemplateVariable(value: string): CanonicalTemplateVariable | undefined {
  const normalized = normalizedVariableName(value).replace(/^_+|_+$/g, '');
  return variableAliases[normalized] || variableAliases[normalized.replace(/_/g, '')];
}

/** Persist one spelling for supported variables; keep unknown tokens visible for validation. */
function decodeTemplateBraces(content: string): string {
  return content.replace(/&amp;(?=(?:#(?:0*12[35]|x0*7[bd]);|(?:lbrace|rbrace|lcub|rcub);))/gi, '&')
    .replace(/&#(?:0*123|x0*7b);|&(?:lbrace|lcub);/gi, '{')
    .replace(/&#(?:0*125|x0*7d);|&(?:rbrace|rcub);/gi, '}');
}

export function normalizeTemplateVariables(content: string): string {
  return decodeTemplateBraces(content).replace(TEMPLATE_TOKEN_PATTERN, (token, name: string) => {
    const canonical = canonicalizeTemplateVariable(name);
    return canonical ? `{{${canonical}}}` : token;
  });
}

export function extractTemplateVariables(content: string): string[] {
  const variables = new Set<string>();
  for (const token of scanTemplateTokens(content)) {
    variables.add(token.name);
  }
  return [...variables];
}

export function findUnresolvedTemplateVariables(content: string): string[] {
  return [...new Set(scanTemplateTokens(content).map(({ token, name, valid }) => valid ? `{{${name}}}` : token))];
}

export function findUnknownTemplateVariables(content: string): string[] {
  return [...new Set(scanTemplateTokens(content)
    .filter(({ name, valid }) => !valid || !canonicalizeTemplateVariable(name))
    .map(({ token, name, valid }) => valid ? `{{${name}}}` : token))];
}


export const VARIABLE_CATEGORIES = {
  lead: [
    { name: 'First Name', variable: '{{first_name}}', description: 'Contact first name' },
    { name: 'Last Name', variable: '{{last_name}}', description: 'Contact last name' },
    { name: 'Full Name', variable: '{{full_name}}', description: 'Contact full name' },
    { name: 'Email', variable: '{{email}}', description: 'Contact email address' },
    { name: 'Phone', variable: '{{phone}}', description: 'Contact phone number' },
  ],
  company: [
    { name: 'Company Name', variable: '{{company_name}}', description: 'Target company name' },
    { name: 'Industry', variable: '{{company_industry}}', description: 'Target company industry' },
    { name: 'Company Size', variable: '{{company_size}}', description: 'Target company size' },
    { name: 'Website', variable: '{{company_website}}', description: 'Target company website' },
    { name: 'Location', variable: '{{company_location}}', description: 'Target company location' },
  ],
  role: [
    { name: 'Job Title', variable: '{{job_title}}', description: 'Contact job title' },
    { name: 'Department', variable: '{{department}}', description: 'Contact department' },
  ],
  business: [
    { name: 'Your Company', variable: '{{your_company_name}}', description: 'Your business name' },
    { name: 'Your Industry', variable: '{{your_industry}}', description: 'Your industry' },
    { name: 'Value Proposition', variable: '{{value_proposition}}', description: 'Your value proposition' },
    { name: 'Your Website', variable: '{{your_website}}', description: 'Your website URL' },
  ],
  icp: [
    { name: 'Target Audience', variable: '{{target_audience}}', description: 'ICP target audience' },
    { name: 'Pain Point', variable: '{{pain_point}}', description: 'Primary pain point' },
    { name: 'Budget Range', variable: '{{budget_range}}', description: 'Target budget range' },
  ],
  dynamic: [
    { name: 'Current Date', variable: '{{current_date}}', description: 'Today\'s date' },
    { name: 'Current Year', variable: '{{current_year}}', description: 'Current year' },
    { name: 'Current Month', variable: '{{current_month}}', description: 'Current month name' },
  ],
  content: [
    { name: 'Link', variable: '{{link}}', description: 'Trackable URL/link placeholder' },
    { name: 'Unsubscribe Link', variable: '{{unsubscribe_link}}', description: 'Unsubscribe link placeholder' },
  ],
};

// All variables flattened
export const ALL_VARIABLES = Object.values(VARIABLE_CATEGORIES).flat();
