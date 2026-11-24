/**
 * Template Variables Tests
 * Tests: replaceTemplateVariables, extractVariables,
 *        hasUnreplacedVariables, highlightVariables,
 *        VARIABLE_CATEGORIES, ALL_VARIABLES
 */
import { describe, it, expect } from 'vitest';
import {
  replaceTemplateVariables,
  replaceTemplateVariableValues,
  extractVariables,
  hasUnreplacedVariables,
  highlightVariables,
  VARIABLE_CATEGORIES,
  ALL_VARIABLES,
  findUnresolvedTemplateTokens,
  renderTemplateVariableMap,
} from '@/utils/templateVariables';

describe('unified template rendering', () => {
  it('resolves encoded variables and still flags missing company values', () => {
    expect(renderTemplateVariableMap('Hi &#123;&#123;first_name&#125;&#125; at {{company}}', { firstName: 'Uma' })).toEqual({ content: 'Hi Uma at {{company_name}}', unresolved: ['company_name'] });
  });
  it.each(['{{First Name}}', '{{first Name}}', '{{ first name }}', '{{firstName}}'])('resolves selected name alias %s for each recipient', token => {
    expect(renderTemplateVariableMap(`Hi ${token},`, { firstName: 'Uma' })).toEqual({ content: 'Hi Uma,', unresolved: [] });
    expect(renderTemplateVariableMap(`Hi ${token},`, { first_name: 'Ravi' })).toEqual({ content: 'Hi Ravi,', unresolved: [] });
  });
  it('canonicalizes legacy aliases and reports only unresolved tokens', () => {
    const result = renderTemplateVariableMap(
      'Hi {{first_name}} at {{company}} — {{missing_value}}',
      { firstName: 'Asha', company_name: 'Acme' },
    );

    expect(result.content).toBe('Hi Asha at Acme — {{missing_value}}');
    expect(result.unresolved).toEqual(['missing_value']);
  });

  it('finds spaced and mixed-case unresolved variables across fields', () => {
    expect(findUnresolvedTemplateTokens('Hi {{ First_Name }}', '{{ROLE}}')).toEqual([
      'first_name',
      'job_title',
    ]);
  });
});

describe('replaceTemplateVariableValues', () => {
  it('creates different messages from the same template for each lead', () => {
    const template = 'Scaling {{company_name}} operations for {{first_name}}';

    expect(replaceTemplateVariableValues(template, {
      '{{company_name}}': 'Acme',
      '{{first_name}}': 'Asha',
    })).toBe('Scaling Acme operations for Asha');

    expect(replaceTemplateVariableValues(template, {
      '{{company_name}}': 'Globex',
      '{{first_name}}': 'Ravi',
    })).toBe('Scaling Globex operations for Ravi');
  });

  it('preserves literal replacement characters in an edited value', () => {
    expect(replaceTemplateVariableValues('Hello {{company_name}}', {
      '{{company_name}}': 'R&D $1',
    })).toBe('Hello R&D $1');
  });
});

describe('replaceTemplateVariables', () => {
  it('should return content unchanged if no variables', () => {
    expect(replaceTemplateVariables('Hello world!', {})).toBe('Hello world!');
  });

  it('should replace {{first_name}} with provided value', () => {
    const result = replaceTemplateVariables('Hi {{first_name}}, welcome!', { firstName: 'Mahesh' });
    expect(result).toBe('Hi Mahesh, welcome!');
  });

  it('should replace {{last_name}} with provided value', () => {
    const result = replaceTemplateVariables('Dear {{last_name}}', { lastName: 'Kumar' });
    expect(result).toBe('Dear Kumar');
  });

  it('should replace {{full_name}} with provided value', () => {
    const result = replaceTemplateVariables('Hello {{full_name}}!', { fullName: 'Mahesh Kumar' });
    expect(result).toBe('Hello Mahesh Kumar!');
  });

  it('should replace {{company_name}} with provided value', () => {
    const result = replaceTemplateVariables('I work at {{company_name}}', { companyName: 'OroCircle' });
    expect(result).toBe('I work at OroCircle');
  });

  it('should replace multiple variables in one template', () => {
    const result = replaceTemplateVariables(
      'Hi {{first_name}} from {{company_name}},',
      { firstName: 'Ravi', companyName: 'TechCorp' }
    );
    expect(result).toBe('Hi Ravi from TechCorp,');
  });

  it('should NOT replace variables with no matching data', () => {
    const result = replaceTemplateVariables('Hi {{first_name}}!', {});
    // firstName not provided — variable should remain
    expect(result).toBe('Hi {{first_name}}!');
  });

  it('should replace {{current_year}} dynamically', () => {
    const result = replaceTemplateVariables('Year: {{current_year}}', {});
    expect(result).toContain(new Date().getFullYear().toString());
  });

  it('should replace {{your_company_name}} variable', () => {
    const result = replaceTemplateVariables('From {{your_company_name}}', { yourCompanyName: 'AskSales' });
    expect(result).toBe('From AskSales');
  });

  it('should be case-insensitive for variable matching', () => {
    const result = replaceTemplateVariables('{{FIRST_NAME}} {{First_Name}}', { firstName: 'Test' });
    expect(result).toBe('Test Test');
  });

  it('should replace all occurrences of a variable', () => {
    const result = replaceTemplateVariables('{{first_name}} and {{first_name}}', { firstName: 'Ana' });
    expect(result).toBe('Ana and Ana');
  });
});

describe('extractVariables', () => {
  it('should return empty array for content with no variables', () => {
    expect(extractVariables('Hello world')).toEqual([]);
    expect(extractVariables('')).toEqual([]);
  });

  it('should extract a single variable', () => {
    const result = extractVariables('Hi {{first_name}}!');
    expect(result).toContain('{{first_name}}');
    expect(result).toHaveLength(1);
  });

  it('should extract multiple unique variables', () => {
    const result = extractVariables('{{first_name}} works at {{company_name}}');
    expect(result).toContain('{{first_name}}');
    expect(result).toContain('{{company_name}}');
    expect(result).toHaveLength(2);
  });

  it('should deduplicate repeated variables', () => {
    const result = extractVariables('{{first_name}} and {{first_name}} again');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('{{first_name}}');
  });
});

describe('hasUnreplacedVariables', () => {
  it('should return false for clean content', () => {
    expect(hasUnreplacedVariables('Hello world!')).toBe(false);
    expect(hasUnreplacedVariables('')).toBe(false);
  });

  it('should return true when template vars are present', () => {
    expect(hasUnreplacedVariables('Hi {{first_name}}!')).toBe(true);
    expect(hasUnreplacedVariables('{{company_name}} is great')).toBe(true);
  });

  it('should return false after all variables are replaced', () => {
    const template = '{{first_name}} from {{company_name}}';
    const replaced = replaceTemplateVariables(template, {
      firstName: 'Ravi',
      companyName: 'TechCorp',
    });
    expect(hasUnreplacedVariables(replaced)).toBe(false);
  });
});

describe('highlightVariables', () => {
  it('should return content unchanged if no variables', () => {
    expect(highlightVariables('Hello world')).toBe('Hello world');
  });

  it('should wrap variable in HTML span', () => {
    const result = highlightVariables('Hi {{first_name}}!');
    expect(result).toContain('<span');
    expect(result).toContain('first_name');
    expect(result).toContain('</span>');
  });

  it('should preserve surrounding text', () => {
    const result = highlightVariables('Hello {{first_name}} from {{company_name}}');
    expect(result).toContain('Hello');
    expect(result).toContain('from');
  });
});

describe('VARIABLE_CATEGORIES', () => {
  it('should have all expected categories', () => {
    expect(VARIABLE_CATEGORIES).toHaveProperty('lead');
    expect(VARIABLE_CATEGORIES).toHaveProperty('company');
    expect(VARIABLE_CATEGORIES).toHaveProperty('role');
    expect(VARIABLE_CATEGORIES).toHaveProperty('business');
    expect(VARIABLE_CATEGORIES).toHaveProperty('dynamic');
  });

  it('should have variables in correct format', () => {
    VARIABLE_CATEGORIES.lead.forEach((v) => {
      expect(v.variable).toMatch(/^\{\{[a-z_]+\}\}$/);
      expect(v.name).toBeTruthy();
      expect(v.description).toBeTruthy();
    });
  });

  it('has first_name in lead category', () => {
    const firstNameVar = VARIABLE_CATEGORIES.lead.find((v) => v.variable === '{{first_name}}');
    expect(firstNameVar).toBeDefined();
  });
});

describe('ALL_VARIABLES', () => {
  it('should be a non-empty flat array', () => {
    expect(ALL_VARIABLES.length).toBeGreaterThan(0);
  });

  it('should contain first_name and company_name', () => {
    const names = ALL_VARIABLES.map((v) => v.variable);
    expect(names).toContain('{{first_name}}');
    expect(names).toContain('{{company_name}}');
  });
});

describe('malformed token guard and deterministic clock', () => {
  it.each(['{{1}}','{{ first name }}','{{}}','{{first_name'])('keeps %s blocked until corrected', token => {
    expect(hasUnreplacedVariables(token)).toBe(true);
  });
  it('formats dates in the supplied zone independently of the browser locale', () => {
    expect(replaceTemplateVariables('{{current_date}} / {{current_year}}', {}, {
      now:new Date('2027-01-01T00:30:00Z'),timeZone:'America/Los_Angeles',
    })).toBe('12/31/2026 / 2026');
  });
});
