import { businessOwnerUserId } from '../tenancy/businessContext.js';
/**
 * Workflow Input Generation Controller
 * Generates input schemas for workflow actors using LLM provider (OpenAI/OpenRouter based on env)
 */

import type { Request, Response } from 'express';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { LLMProviderFactory } from '../services/agents/LLMProviderFactory';
import { createLeadInputs } from '../models/leadInputs/functions';
import { createChatMessage } from '../models/chatMessages/functions';
import { logger } from '../utils/logger.js';
import { resolveWorkflowPath } from '../utils/dataPathResolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// LLM providers are obtained per-user at runtime via LLMProviderFactory.createProviderForUser(userId)
// Do NOT create a global/module-level provider here (deprecated)

interface WorkflowStep {
  step_id: string;
  step_type: string;
  config: {
    prompt_template?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    example_json?: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  };
  output_key?: string;
}

interface WorkflowConfig {
  workflow_id: string;
  platform: string;
  steps: WorkflowStep[];
}

interface ICPData {
  campaign_name?: string;
  campaign_objective?: string;
  target_audience?: string;
  industry_vertical?: string;
  business_type?: string;
  geography_locations?: string[];
  target_roles_titles?: string[];
  interests?: string[];
  sources?: string[];
  company_size?: string;
  revenue_range?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Load workflow configuration from JSON file
 */
async function loadWorkflowConfig(platform: string): Promise<WorkflowConfig | null> {
  try {
    // Map ICP channel names to workflow file names
    const platformMapping: { [key: string]: string } = {
      'google': 'google_maps',
      'google_maps': 'google_maps',
      'googlemaps': 'google_maps',
      'linkedin': 'linkedin',
      'facebook': 'facebook',
      'twitter': 'twitter',
      'instagram': 'instagram',
      'justdial': 'justdial',
      'just_dial': 'justdial',
      'just dial': 'justdial',
    };
    
    const mappedPlatform = platformMapping[platform.toLowerCase()] || platform.toLowerCase();
    const workflowPath = resolveWorkflowPath(mappedPlatform);
    const content = await fs.readFile(workflowPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    logger.error({ err: error, platform }, '[WorkflowInputController] Error loading workflow');
    return null;
  }
}

/**
 * Find the first node in the workflow that has no input connectivity
 * (i.e., not a target of any edge)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findFirstNode(reactFlowWorkflow: any): any {
  const nodes = reactFlowWorkflow.nodes || [];
  const edges = reactFlowWorkflow.edges || [];
  
  // Get all node IDs that are targets (have incoming edges)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const targetNodeIds = new Set(edges.map((edge: any) => edge.target));
  
  // Find the first node that is not a target of any edge
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const firstNode = nodes.find((node: any) => !targetNodeIds.has(node.id));
  
  return firstNode;
}

/**
 * Generate input schema for a workflow platform using OpenAI
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function generateInputSchema(reactFlowWorkflow: any, icpData: ICPData, userId?: number): Promise<any> {
  try {
    // Find the first node in the workflow (no input connectivity)
    const firstNode = findFirstNode(reactFlowWorkflow);
    
    if (!firstNode) {
      throw new Error('No starting node found in workflow');
    }

    logger.info({ nodeId: firstNode.id, nodeType: firstNode.type }, '[WorkflowInputController] Found first node');

    // Get the input schema from the node's data
    const nodeData = firstNode.data || {};
    // Prefer the full inputSchema properties over the simple inputMapping
    const fullInputSchema = nodeData.schema?.inputSchema?.properties || {};
    const inputMapping = nodeData.inputMapping || {};
    const actorName = nodeData.actorName || nodeData.label || firstNode.id;
    const description = nodeData.description || nodeData.schema?.description || '';

    // Build the schema information with descriptions for better LLM understanding
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schemaFieldsDescription = Object.entries(fullInputSchema).map(([key, value]: [string, any]) => {
      return `- ${key}: ${value.description || value.title || 'No description'} (type: ${value.type || 'string'}${value.default !== undefined ? `, default: ${JSON.stringify(value.default)}` : ''})`;
    }).join('\n');

    // Build a comprehensive prompt for OpenAI
    const defaultPrompt = `You are an expert at generating search parameters for lead generation platforms.

Platform: ${reactFlowWorkflow.platform}
Actor: ${actorName}
Description: ${description}

Target Audience Information (ICP Data):
- Campaign Objective: ${icpData.campaign_objective || 'N/A'}
- Target Audience: ${icpData.target_audience || 'N/A'}
- Industry: ${icpData.industry_vertical || 'N/A'}
- Business Type: ${icpData.business_type || 'N/A'}
- Geographic Locations: ${(icpData.geography_locations || []).join(', ') || 'N/A'}
- Target Roles/Titles: ${(icpData.target_roles_titles || []).join(', ') || 'N/A'}
- Company Size: ${icpData.company_size || 'N/A'}
- Revenue Range: ${icpData.revenue_range || 'N/A'}
- Interests: ${(icpData.interests || []).join(', ') || 'N/A'}

Available Input Fields:
${schemaFieldsDescription || JSON.stringify(inputMapping, null, 2)}

Required Fields to Generate (from inputMapping):
${Object.keys(inputMapping).join(', ') || 'Use the available input fields above'}

Generate optimized search parameters for this ${reactFlowWorkflow.platform} platform based on the target audience information.
Return a JSON object with the required input field names as keys and appropriate values based on the ICP data.
- For search queries: create specific, targeted searches that match the target audience
- For location fields: use the geographic locations from ICP
- For job title fields: use the target roles/titles from ICP
- For numeric fields like maxItems and maxResults: use 5 as the safe preview default unless the user requested another exact count
- For array fields: provide arrays of relevant values based on ICP

Only include fields that are relevant and needed. Do not include optional fields unless they help target the audience better.`;

    logger.info({ platform: reactFlowWorkflow.platform }, '[WorkflowInputController] Generating inputs using user LLM provider');

    const provider = userId ? await LLMProviderFactory.createProviderForUser(userId) : null;
    if (!provider) throw new Error('No LLM provider configured for this user. Please configure OpenAI or OpenRouter in Settings > Integrations.');

    // Call user's LLM provider to generate inputs
    const response = await provider.createChatCompletion({
      model: provider.defaultModel,
      messages: [
        {
          role: 'system',
          content: 'You are an expert in generating optimized search parameters for lead generation platforms. Always respond with valid JSON matching the provided schema structure.',
        },
        {
          role: 'user',
          content: defaultPrompt,
        },
      ],
      temperature: 0.5,
      response_format: { type: 'json_object' },
      // Add logging context
      ...(userId ? {
        loggingContext: {
          userId,
          purpose: 'workflow_input_generation',
          service: 'WorkflowInputController',
          action: `generate_inputs_${reactFlowWorkflow.platform}`,
        },
      } : {}),
    });

    if (!response.success || !response.content) {
      throw new Error(`OpenAI call failed: ${response.error}`);
    }

    // Parse the generated inputs
    let generatedInputs;
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      const jsonString = jsonMatch ? jsonMatch[0] : response.content;
      generatedInputs = JSON.parse(jsonString);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (parseError) {
      logger.error({ responseContent: response.content }, '[WorkflowInputController] Failed to parse OpenAI response');
      throw new Error('Failed to parse generated inputs');
    }

    logger.info({ platform: reactFlowWorkflow.platform, generatedInputs }, '[WorkflowInputController] Successfully generated inputs');

    return {
      platform: reactFlowWorkflow.platform,
      platformDisplay: reactFlowWorkflow.platform.charAt(0).toUpperCase() + reactFlowWorkflow.platform.slice(1),
      workflowId: reactFlowWorkflow.workflow_id,
      actorId: nodeData.actorId,
      actorName: actorName,
      inputs: generatedInputs,
      schema: inputMapping,
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WorkflowInputController] Error generating inputs');
    throw error;
  }
}

/**
 * POST /api/workflows/generate-inputs
 * Generate input schemas for all platforms in an ICP
 */
export async function generateWorkflowInputsHandler(req: Request, res: Response) {
  try {
    const { platforms, icpData, threadId } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!platforms || !Array.isArray(platforms) || platforms.length === 0) {
      return res.status(400).json({ error: 'platforms array is required' });
    }

    if (!icpData) {
      return res.status(400).json({ error: 'icpData is required' });
    }

    logger.info({ platforms: platforms.join(', '), threadId }, '[WorkflowInputController] Generating inputs for platforms');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errors: any[] = [];

    // Generate inputs for each platform in parallel
    const promises = platforms.map(async (platform: string) => {
      try {
        const workflow = await loadWorkflowConfig(platform);
        
        if (!workflow) {
          errors.push({ platform, error: 'Workflow not found' });
          return null;
        }

        const inputSchema = await generateInputSchema(workflow, icpData, userId);
        results.push(inputSchema);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        logger.error({ err: error, platform }, '[WorkflowInputController] Error for platform');
        errors.push({ platform, error: error.message });
      }
    });

    await Promise.all(promises);

    // If threadId is provided, save inputs to database
    if (threadId && results.length > 0) {
      try {
        // Create a system message to associate with the lead inputs
        const message = await createChatMessage({
          userId,
          threadId,
          role: 'system',
          content: `Generated workflow inputs for ${platforms.join(', ')}`,
        });

        const leadInputsToSave = results.map(schema => ({
          messageId: message.id,
          threadId,
          userId,
          platform: schema.platform,
          inputs: schema.inputs,
          schema: schema.schema,
          actorId: schema.actorId,
          actorName: schema.actorName,
          workflowId: schema.workflowId,
        }));
        
        await createLeadInputs(leadInputsToSave);
        logger.info({ count: leadInputsToSave.length, threadId }, '[WorkflowInputController] Saved lead inputs to database');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (saveError: any) {
        logger.error({ err: saveError }, '[WorkflowInputController] Error saving to database');
        // Continue anyway, just log the error
      }
    }

    res.json({
      success: errors.length === 0,
      results,
      errors: errors.length > 0 ? errors : undefined,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WorkflowInputController] Handler error');
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/workflows/generate-inputs/:platform
 * Generate input schema for a specific platform
 */
export async function generatePlatformInputHandler(req: Request, res: Response) {
  try {
    const { platform } = req.params;
    const { icpData } = req.body;

    if (!icpData) {
      return res.status(400).json({ error: 'icpData is required' });
    }

    logger.info({ platform }, '[WorkflowInputController] Generating inputs for platform');

    const workflow = await loadWorkflowConfig(platform);
    
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found for platform' });
    }

    const inputSchema = await generateInputSchema(workflow, icpData);

    res.json({
      success: true,
      ...inputSchema,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WorkflowInputController] Handler error');
    res.status(500).json({ error: 'Internal server error' });
  }
}
