/**
 * Actor Schema Registry
 * Loads and caches actor input/output schemas from JSON files
 * Provides validation for inter-actor schema compatibility
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

export function resolveActorSchemaDataDirectories(
  cwd = process.cwd(),
  moduleUrl = import.meta.url,
): string[] {
  const moduleDataDir = path.resolve(path.dirname(fileURLToPath(moduleUrl)), '../../data');
  return [...new Set([
    path.join(cwd, 'data'),
    path.join(cwd, 'server', 'data'),
    moduleDataDir,
  ])];
}

interface ActorSchema {
  id: string;
  name: string;
  description: string;
  inputSchema: {
    type: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    properties: Record<string, any>;
    required?: string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  outputSchema: {
    type: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    properties: Record<string, any>;
    iterate_over?: string | null;
    skip_if_empty?: string[];
    required_inputs?: string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    validation_rules?: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
}

interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  suggestions?: string[];
}

export class ActorSchemaRegistry {
  private static instance: ActorSchemaRegistry;
  private schemas: Map<string, ActorSchema> = new Map();
  private schemasLoaded: boolean = false;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): ActorSchemaRegistry {
    if (!ActorSchemaRegistry.instance) {
      ActorSchemaRegistry.instance = new ActorSchemaRegistry();
    }
    return ActorSchemaRegistry.instance;
  }

  /**
   * Load schemas from a directory into the registry
   */
  private async loadSchemasFromDir(dirPath: string): Promise<void> {
    try {
      await fs.access(dirPath);
    } catch {
      return;
    }

    const files = await fs.readdir(dirPath);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    for (const file of jsonFiles) {
      try {
        const filePath = path.join(dirPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const raw = JSON.parse(content);
        const actorId = raw.actorId || raw.id;
        if (actorId) {
          // The catalog also ships compact { actorId, input, output } metadata.
          // Execution must understand the same fields as input generation.
          const compactInput = raw.input && !raw.input.properties ? raw.input : null;
          const schema: ActorSchema = {
            ...raw,
            id: actorId,
            name: raw.name || raw.title || actorId,
            inputSchema: raw.inputSchema || {
              type: 'object',
              properties: compactInput || raw.input?.properties || {},
              required: compactInput
                ? Object.entries(compactInput).filter(([, field]) => (field as { required?: boolean }).required === true).map(([key]) => key)
                : raw.input?.required || [],
            },
            outputSchema: raw.outputSchema || { type: 'object', properties: raw.output?.properties || raw.output || {} },
          };
          this.schemas.set(actorId, schema);
        }
      } catch (error) {
        logger.error({ err: error }, `[ActorSchemaRegistry] Error loading ${file}:`);
      }
    }
  }

  /**
   * Load all actor schemas from JSON files (data/actors and data/nodes)
   */
  async loadSchemas(): Promise<void> {
    if (this.schemasLoaded) {
      return;
    }

    try {
      for (const dataDir of resolveActorSchemaDataDirectories()) {
        await this.loadSchemasFromDir(path.join(dataDir, 'actors'));
        await this.loadSchemasFromDir(path.join(dataDir, 'nodes'));
      }

      this.schemasLoaded = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[ActorSchemaRegistry] Error loading schemas:');
      this.schemasLoaded = true;
    }
  }

  /**
   * Get schema for a specific actor
   */
  getSchema(actorId: string): ActorSchema | undefined {
    return this.schemas.get(actorId);
  }

  /**
   * Get all loaded schemas
   */
  getAllSchemas(): ActorSchema[] {
    return Array.from(this.schemas.values());
  }

  /**
   * Validate that output from one actor matches input requirements of another
   */
  validateActorChain(
    sourceActorId: string,
    targetActorId: string,
    inputMapping: Record<string, string>
  ): SchemaValidationResult {
    const result: SchemaValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
    };

    const sourceSchema = this.schemas.get(sourceActorId);
    const targetSchema = this.schemas.get(targetActorId);

    if (!sourceSchema) {
      result.valid = false;
      result.errors.push(`Source actor schema not found: ${sourceActorId}`);
      return result;
    }

    if (!targetSchema) {
      result.valid = false;
      result.errors.push(`Target actor schema not found: ${targetActorId}`);
      return result;
    }

    // Check required inputs
    const targetRequired = targetSchema.inputSchema.required || [];
    const targetProps = targetSchema.inputSchema.properties || {};

    for (const requiredField of targetRequired) {
      // Check if required field is mapped
      const isMapped = Object.keys(inputMapping).includes(requiredField);
      
      if (!isMapped) {
        result.errors.push(`Required field "${requiredField}" is not mapped in input mapping`);
        result.valid = false;
        continue;
      }

      // Get the source field from mapping (e.g., "{{output_key}}" or "{{output_key.field}}")
      const mappingValue = inputMapping[requiredField];
      const sourceField = this.extractFieldFromMapping(mappingValue);

      if (!sourceField) {
        result.warnings.push(`Field "${requiredField}" has static value or complex mapping: ${mappingValue}`);
        continue;
      }

      // Check if source actor outputs this field
      const sourceOutputProps = sourceSchema.outputSchema.properties || {};
      
      // Handle nested fields (e.g., "output.field")
      const [baseField, ...nestedPath] = sourceField.split('.');
      
      if (!sourceOutputProps[baseField]) {
        result.errors.push(
          `Source actor "${sourceActorId}" does not output field "${baseField}" (required by target actor "${targetActorId}" field "${requiredField}")`
        );
        result.valid = false;
      } else if (nestedPath.length > 0) {
        // Validate nested path if possible
        const baseType = sourceOutputProps[baseField].type;
        if (baseType !== 'object' && baseType !== 'array') {
          result.warnings.push(
            `Nested field access "${sourceField}" may fail - base field "${baseField}" is type "${baseType}", not object/array`
          );
        }
      }
    }

    // Type checking for mapped fields
    for (const [targetField, mappingValue] of Object.entries(inputMapping)) {
      const sourceField = this.extractFieldFromMapping(mappingValue);
      if (!sourceField) continue;

      const targetFieldType = targetProps[targetField]?.type;
      const [baseField] = sourceField.split('.');
      const sourceFieldType = sourceSchema.outputSchema.properties?.[baseField]?.type;

      if (sourceFieldType && targetFieldType && sourceFieldType !== targetFieldType) {
        // Allow some type coercions
        const allowedCoercions = [
          ['integer', 'number'],
          ['number', 'integer'],
          ['string', 'integer'],
          ['string', 'number'],
        ];

        const isAllowedCoercion = allowedCoercions.some(
          ([from, to]) => sourceFieldType === from && targetFieldType === to
        );

        if (!isAllowedCoercion) {
          result.warnings.push(
            `Type mismatch: "${targetField}" expects ${targetFieldType} but source provides ${sourceFieldType}`
          );
        }
      }
    }

    return result;
  }

  /**
   * Extract field name from Mustache template mapping
   * E.g., "{{output_key}}" -> "output_key", "{{data.posts}}" -> "data.posts"
   */
  private extractFieldFromMapping(mappingValue: string): string | null {
    if (typeof mappingValue !== 'string') return null;

    const mustachePattern = /\{\{([^}]+)\}\}/;
    const match = mappingValue.match(mustachePattern);

    if (match) {
      return match[1].trim();
    }

    // If no mustache template, it's a static value
    return null;
  }

  /**
   * Validate array iteration compatibility
   */
  validateIteration(
    sourceActorId: string,
    targetActorId: string,
    iterateOverField: string
  ): SchemaValidationResult {
    const result: SchemaValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
    };

    const sourceSchema = this.schemas.get(sourceActorId);
    const targetSchema = this.schemas.get(targetActorId);

    if (!sourceSchema || !targetSchema) {
      result.valid = false;
      result.errors.push('Actor schemas not found');
      return result;
    }

    const sourceOutputProps = sourceSchema.outputSchema.properties || {};
    const iterateField = sourceOutputProps[iterateOverField];

    if (!iterateField) {
      result.valid = false;
      result.errors.push(`Source actor "${sourceActorId}" does not output field "${iterateOverField}"`);
      return result;
    }

    // Check if field is an array
    if (iterateField.type !== 'array') {
      result.valid = false;
      result.errors.push(
        `Field "${iterateOverField}" from actor "${sourceActorId}" is type "${iterateField.type}", not array`
      );
      return result;
    }

    // Check if array items have required properties
    const arrayItemType = iterateField.items?.type;
    if (arrayItemType && arrayItemType !== 'object') {
      result.warnings.push(
        `Iterating over array of "${arrayItemType}" - ensure target actor can handle this type`
      );
    }

    return result;
  }

  /**
   * Get all possible output fields from an actor (including nested fields)
   */
  getOutputFields(actorId: string, maxDepth: number = 2): string[] {
    const schema = this.schemas.get(actorId);
    if (!schema) return [];

    const fields: string[] = [];
    const props = schema.outputSchema.properties || {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traverse = (obj: any, prefix: string = '', depth: number = 0) => {
      if (depth > maxDepth) return;

      for (const [key, value] of Object.entries(obj)) {
        const fullPath = prefix ? `${prefix}.${key}` : key;
        fields.push(fullPath);

        if (value && typeof value === 'object') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const schemaValue = value as any; // Type assertion for schema objects
          if (schemaValue.type === 'object' && schemaValue.properties) {
            traverse(schemaValue.properties, fullPath, depth + 1);
          } else if (schemaValue.type === 'array' && schemaValue.items?.properties) {
            traverse(schemaValue.items.properties, fullPath, depth + 1);
          }
        }
      }
    };

    traverse(props);
    return fields;
  }

  /**
   * Suggest optimal field mappings between two actors
   */
  suggestMappings(sourceActorId: string, targetActorId: string): Record<string, string> {
    const sourceSchema = this.schemas.get(sourceActorId);
    const targetSchema = this.schemas.get(targetActorId);

    if (!sourceSchema || !targetSchema) return {};

    const suggestions: Record<string, string> = {};
    const sourceFields = this.getOutputFields(sourceActorId);
    const targetProps = targetSchema.inputSchema.properties || {};

    for (const targetField of Object.keys(targetProps)) {
      // Try exact match first
      if (sourceFields.includes(targetField)) {
        suggestions[targetField] = `{{${targetField}}}`;
        continue;
      }

      // Try fuzzy match (e.g., "url" matches "pageUrl", "startUrls")
      const fuzzyMatch = sourceFields.find(sf => 
        sf.toLowerCase().includes(targetField.toLowerCase()) ||
        targetField.toLowerCase().includes(sf.toLowerCase())
      );

      if (fuzzyMatch) {
        suggestions[targetField] = `{{${fuzzyMatch}}}`;
      }
    }

    return suggestions;
  }
}
