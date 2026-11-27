import { currentConversationRequest } from '../ConversationRequestCoordinator.js';
/**
 * WebSocket Emitter - Sends real-time progress updates to frontend clients
 * Implements same event patterns as Python websocket_emitter.py
 * 
 * Architecture V2: Also publishes events to EventBus (Redis Pub/Sub)
 * so that horizontally scaled WebSocket gateways can relay events.
 */

import type { WebSocketProgressEvent } from './types';
import { logger } from '../../utils/logger.js';
import { getDisplayName } from '../../mastra/agentPersonas';
import { sanitizeAssistantContent, sanitizeErrorFields, toUserFacingError } from '../../../shared/userFacingError.js';
import '../../mastra/utils/technicalTerms.js';

interface TrackedClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ws: any;
  threadId?: number; // The thread this connection is currently viewing
}

export class WebSocketEmitter {
  /** Await Redis acceptance for outbox-backed events. This is not a browser
   * delivery receipt: offline clients must still reload authoritative state.
   * The caller owns retrying the same eventId after any rejection.
   */
  async emitPersistedWidgetUpdate(userId: number, threadId: number, widget: Record<string, unknown>, eventId: string): Promise<void> {
    if (!Number.isSafeInteger(userId) || userId <= 0
      || !Number.isSafeInteger(threadId) || threadId <= 0
      || !eventId.trim() || widget.userId !== userId || widget.threadId !== threadId) {
      throw new Error('Durable widget events require matching owner, thread and event identity');
    }
    const { eventBus } = await import('../../events/EventBus.js');
    await eventBus.publish({
      channel: 'events:ws:widget_update',
      messageId: eventId,
      userId,
      threadId,
      timestamp: new Date().toISOString(),
      data: sanitizeErrorFields({ schema_version: 1, event_id: eventId, eventId, thread_id: threadId, widget }),
    });
  }

  private clients: Map<number, Set<TrackedClient>>; // userId -> Set of tracked connections
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wsToClient: WeakMap<any, TrackedClient>; // ws -> TrackedClient lookup

  constructor() {
    this.clients = new Map();
    this.wsToClient = new WeakMap();
  }

  /**
   * Register a WebSocket client for a user
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerClient(userId: number, ws: any): void {
    if (!this.clients.has(userId)) {
      this.clients.set(userId, new Set());
    }
    const tracked: TrackedClient = { ws };
    this.clients.get(userId)!.add(tracked);
    this.wsToClient.set(ws, tracked);
    logger.info({ userId, clientCount: this.clients.get(userId)!.size }, '[WebSocketEmitter] Registered client');
  }

  /**
   * Update the threadId a client is currently viewing.
   * Called when a client sends a 'subscribe_thread' message.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateClientThread(userId: number, ws: any, threadId: number | undefined): void {
    const tracked = this.wsToClient.get(ws);
    if (tracked) {
      tracked.threadId = threadId;
      logger.debug({ userId, threadId }, '[WebSocketEmitter] Updated client thread subscription');
    }
  }

  /**
   * Unregister a WebSocket client
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unregisterClient(userId: number, ws: any): void {
    const userClients = this.clients.get(userId);
    if (userClients) {
      const tracked = this.wsToClient.get(ws);
      if (tracked) {
        userClients.delete(tracked);
        this.wsToClient.delete(ws);
      }
      if (userClients.size === 0) {
        this.clients.delete(userId);
      }
      logger.info(`[WebSocketEmitter] Unregistered client for user ${userId}`);
    }
  }

  /**
   * Emit orchestrator progress to chat (Python: emit_orchestrator_progress_to_chat)
   */
  emitOrchestratorProgress(
    userId: number,
    message: string,
    promptId?: number,
    details?: string,
    executionId?: string,
    threadId?: number
  ): void {
    const event: WebSocketProgressEvent = {
      event_type: 'orchestrator_progress',
      user_id: userId,
      prompt_id: promptId,
      thread_id: threadId,
      message,
      details,
      execution_id: executionId,
      timestamp: Date.now(),
    };
    this.emitToUser(userId, 'orchestrator_progress', event);
  }

  /**
   * Emit workflow started event (Python: emit_workflow_event_to_chat with event_type='workflow_started')
   */
  emitWorkflowStarted(
    userId: number,
    platform: string,
    message: string,
    promptId?: number,
    executionId?: string,
    threadId?: number
  ): void {
    const event: WebSocketProgressEvent = {
      event_type: 'workflow_started',
      user_id: userId,
      platform,
      message,
      prompt_id: promptId,
      thread_id: threadId,
      execution_id: executionId,
      timestamp: Date.now(),
    };
    this.emitToUser(userId, 'workflow_started', event);
  }

  /**
   * Emit workflow completed event
   */
  emitWorkflowCompleted(
    userId: number,
    platform: string,
    message: string,
    count: number,
    promptId?: number,
    executionId?: string,
    threadId?: number
  ): void {
    const event: WebSocketProgressEvent = {
      event_type: 'workflow_completed',
      user_id: userId,
      platform,
      message,
      count,
      prompt_id: promptId,
      thread_id: threadId,
      execution_id: executionId,
      timestamp: Date.now(),
    };
    this.emitToUser(userId, 'workflow_completed', event);
  }

  /**
   * Emit workflow error event
   */
  emitWorkflowError(
    userId: number,
    platform: string,
    message: string,
    error: string,
    promptId?: number,
    threadId?: number
  ): void {
    const event: WebSocketProgressEvent = {
      event_type: 'workflow_error',
      user_id: userId,
      platform,
      message,
      error: toUserFacingError(error),
      prompt_id: promptId,
      thread_id: threadId,
      timestamp: Date.now(),
    };
    this.emitToUser(userId, 'workflow_error', event);
  }

  /**
   * Emit workflow step progress
   */
  emitWorkflowStep(
    userId: number,
    platform: string,
    step: string,
    message: string,
    promptId?: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata?: Record<string, any>,
    threadId?: number
  ): void {
    const event: WebSocketProgressEvent = {
      event_type: 'workflow_step',
      user_id: userId,
      platform,
      step,
      message,
      prompt_id: promptId,
      thread_id: threadId,
      metadata,
      timestamp: Date.now(),
      execution_id: metadata?.executionId || metadata?.execution_id || undefined,
    };
    this.emitToUser(userId, 'workflow_step', event);
  }

  /**
   * Emit batch progress (Python: emit_batch_progress)
   */
  emitBatchProgress(
    userId: number,
    completed: number,
    total: number,
    currentPlatform?: string,
    promptId?: number,
    threadId?: number
  ): void {
    const percentage = total > 0 ? (completed / total) * 100 : 0;
    const event: WebSocketProgressEvent = {
      event_type: 'batch_progress',
      user_id: userId,
      completed,
      total,
      percentage,
      message: `Batch progress: ${completed}/${total} workflows completed (${percentage.toFixed(1)}%)`,
      platform: currentPlatform,
      prompt_id: promptId,
      thread_id: threadId,
      timestamp: Date.now(),
    };
    this.emitToUser(userId, 'batch_progress', event);
  }

  /**
   * Emit execution summary
   */
  emitExecutionSummary(
    userId: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    summary: any,
    promptId?: number,
    threadId?: number
  ): void {
    const event: WebSocketProgressEvent = {
      event_type: 'execution_summary',
      user_id: userId,
      message: `Execution completed: ${summary.total_leads} leads from ${summary.successful_platforms} platforms`,
      prompt_id: promptId,
      thread_id: threadId,
      ...summary,
      metadata: summary,
      timestamp: Date.now(),
    };
    this.emitToUser(userId, 'execution_summary', event);
  }

  /**
   * Emit agent status update for dynamic thinking messages
   */
  emitAgentStatus(
    userId: number,
    agentType: string,
    status: 'thinking' | 'processing' | 'completed' | 'error',
    message?: string,
    executionId?: string,
    threadId?: number
  ): void {
    const event = {
      event_type: 'agent_status',
      user_id: userId,
      agent_type: agentType,
      status,
      message: message || `${agentType} is ${status}`,
      execution_id: executionId,
      thread_id: threadId,
      timestamp: Date.now(),
    };
    this.emitToUser(userId, 'agent_status', event);
    logger.info(`[WebSocketEmitter] Emitted agent status: ${agentType} - ${status}${executionId ? ` (execution: ${executionId})` : ''}${threadId ? ` (thread: ${threadId})` : ''}`);
  }

  /**
   * Emit progress step for detailed progress updates in chat
   * This shows step-by-step progress like "Detecting user intention...", "Checking ICP status..."
   */
  emitProgressStep(
    userId: number,
    threadId: number,
    step: string,
    message: string,
    agentType?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata?: Record<string, any>
  ): void {
    const event = {
      event_type: 'progress_step',
      user_id: userId,
      thread_id: threadId,
      step,
      message,
      agent_type: agentType,
      metadata,
      timestamp: Date.now(),
    };
    this.emitToUser(userId, 'progress_step', event);
    logger.info(`[WebSocketEmitter] Progress step: ${step} - ${message}`);
  }

  /**
   * Emit tool execution event for transparency in chat
   * Shows which tool was called, with what args, and the result
   */
  emitToolExecution(
    userId: number,
    threadId: number,
    data: {
      toolName: string;
      toolCallId?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args?: Record<string, any>;
      status: 'started' | 'completed' | 'failed' | 'gated';
      agentType?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      output?: any;
      error?: string;
      durationMs?: number;
    }
  ): void {
    const safeData = sanitizeErrorFields({
      ...data,
      ...(data.error ? { error: toUserFacingError(data.error) } : {}),
    });
    const event = {
      event_type: 'tool_execution',
      user_id: userId,
      thread_id: threadId,
      ...safeData,
      timestamp: Date.now(),
    };
    this.emitToUser(userId, 'tool_execution', event);
    logger.info(`[WebSocketEmitter] Tool execution: ${data.toolName} - ${data.status}${data.error ? ' (error details retained in server logs)' : ''}`);
  }

  /**
   * Emit ICP update event for real-time ICP updates
   */
  emitICPUpdate(
    userId: number,
    icpId: number,
    icpData: {
      threadId?: number;
      fit_score?: number;
      status?: string;
      target_audience?: string;
      summary?: string;
      user_intent?: string;
      recommended_agent_scores?: Record<string, number>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updatedFields?: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fullProfile?: any;
      executionId?: string;
    }
  ): void {
    const event = {
      event_type: 'icp_update',
      user_id: userId,
      icp_id: icpId,
      thread_id: icpData.threadId,
      fit_score: icpData.fit_score,
      status: icpData.status,
      target_audience: icpData.target_audience,
      summary: icpData.summary,
      user_intent: icpData.user_intent,
      recommended_agent_scores: icpData.recommended_agent_scores,
      updated_fields: icpData.updatedFields,
      full_profile: icpData.fullProfile,
      execution_id: icpData.executionId,
      timestamp: Date.now(),
    };
    this.emitToUser(userId, 'icp_update', event);
    logger.info(`[WebSocketEmitter] Emitted ICP update for ICP ${icpId} to user ${userId}${icpData.executionId ? ` (execution: ${icpData.executionId})` : ''}`);
  }

  /**
   * Emit chat message for real-time message streaming
   */
  emitChatMessage(
    userId: number,
    threadId: number,
    message: {
      id?: number;
      role: string;
      content: string;
      agentType: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata?: any;
      timestamp?: number;
    }
  ): void {
    const safeMessage = {
      ...message,
      metadata: sanitizeErrorFields(message.metadata),
      ...(message.role === 'assistant' && message.content
        ? { content: sanitizeAssistantContent(message.content, message.metadata) }
        : {}),
    };
    const event = {
      event_type: 'chat_message',
      user_id: userId,
      thread_id: threadId,
      message: {
        ...safeMessage,
        timestamp: message.timestamp || Date.now(),
      },
      timestamp: Date.now(),
    };
    this.emitToUser(userId, 'chat_message', event);
    logger.info(`[WebSocketEmitter] Emitted chat message for thread ${threadId} to user ${userId}`);
  }

  /**
   * Emit chat response for real-time assistant responses
   */
  emitChatResponse(
    userId: number,
    threadId: number,
    response: {
      role: string;
      content: string;
      agentType: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata?: any;
      icpId?: number;
      fitScore?: number;
      recommendedAgents?: string[];
    }
  ): void {
    const safeResponse = {
      ...response,
      content: sanitizeAssistantContent(response.content, response.metadata),
      metadata: sanitizeErrorFields(response.metadata),
    };
    const event = {
      event_type: 'chat_response',
      user_id: userId,
      thread_id: threadId,
      response: {
        ...safeResponse,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    };
    this.emitToUser(userId, 'chat_response', event);
    logger.info(`[WebSocketEmitter] Emitted chat response for thread ${threadId} to user ${userId}`);
  }

  /**
   * Emit a streaming token for real-time message display
   * This is called for each token as it's generated by the LLM
   */
  emitStreamingToken(
    userId: number,
    threadId: number,
    token: string,
    agentType: string,
    responseId: string,
    done: boolean = false
  ): void {
    const event = {
      event_type: 'streaming_token',
      user_id: userId,
      thread_id: threadId,
      token,
      agent_type: agentType,
      response_id: responseId,
      done,
      timestamp: Date.now(),
    };
    this.emitToUser(userId, 'streaming_token', event);
  }

  /**
   * Emit chat response chunk for real-time streaming
   */
  emitChatResponseChunk(
    userId: number,
    threadId: number,
    chunk: {
      responseId: string;
      role: string;
      agentType?: string;
      chunk: string;
      sequence: number;
      done: boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata?: Record<string, any>;
    }
  ): void {
    const safeChunk = chunk.role === 'assistant'
      ? sanitizeAssistantContent(chunk.chunk, chunk.metadata)
      : chunk.chunk;
    const event = {
      event_type: 'chat_response_chunk',
      user_id: userId,
      thread_id: threadId,
      responseId: chunk.responseId,
      role: chunk.role,
      agentType: chunk.agentType,
      chunk: safeChunk,
      sequence: chunk.sequence,
      done: chunk.done,
      metadata: sanitizeErrorFields(chunk.metadata),
      timestamp: Date.now(),
    };
    this.emitToUser(userId, 'chat_response_chunk', event);
    
    if (chunk.done) {
      logger.info(`[WebSocketEmitter] Emitted final chunk (done) for responseId ${chunk.responseId}`);
    }
  }

  /**
   * Get human-readable agent display name
   */
  private getAgentDisplayName(agentType: string): string {
    return getDisplayName(agentType);
  }

  /**
   * Generic emit method for custom events
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public emit(userId: number, eventType: string, data: any): void {
    this.emitToUser(userId, eventType, sanitizeErrorFields(data));
  }

  /**
   * Emit open tab event to trigger UI tab changes
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public emitOpenTab(userId: number, tabType: string, tabLabel?: string, data?: any, threadId?: number): void {
    const payload = {
      ...(threadId ? { thread_id: threadId } : {}),
      tabType,
      tabLabel: tabLabel || tabType,
      ...data,
    };
    this.emitToUser(userId, 'open_tab', payload);
    logger.info(`[WebSocketEmitter] Emitted open_tab event for user ${userId}: ${tabType}`);
  }

  /**
   * Emit widget_created event when an AI tool call triggers an interactive widget
   */
  public emitWidgetCreated(userId: number, threadId: number, widget: {
    id: number;
    toolName: string;
    widgetType: string;
    formValues: Record<string, unknown>;
    status?: string;
    agentType?: string;
    messageId?: number;
  }): void {
    this.emitToUser(userId, 'widget_created', {
      thread_id: threadId,
      widget,
    });
    logger.info(`[WebSocketEmitter] Emitted widget_created for user ${userId}, thread ${threadId}: ${widget.widgetType}`);
  }

  /**
   * Emit widget_update event when widget state changes (auto-save, submit, close)
   */
  public emitWidgetUpdate(userId: number, threadId: number, widget: {
    id: number;
    status: string;
    formValues?: Record<string, unknown>;
  }): void {
    this.emitToUser(userId, 'widget_update', {
      thread_id: threadId,
      widget,
    });
  }

  /**
   * Emit event to WebSocket connections for a user, filtered by thread.
   * Thread-specific events (those with thread_id in data) are only sent to
   * connections subscribed to that thread. Non-thread events go to all.
   * V2: Also publishes to Event Bus for cross-process distribution.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private emitToUser(userId: number, eventType: string, data: any): void {
    const eventThreadId = data?.thread_id as number | undefined;
    const messageId = `${eventType}_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const turn = currentConversationRequest();
    const correlation = turn && turn.userId === userId && turn.conversationId === eventThreadId
      ? { requestId: turn.requestId, request_id: turn.requestId,
        ...(turn.workflowRunId ? { runId: turn.workflowRunId, run_id: turn.workflowRunId } : {}),
        ...(turn.workflowTurnId ? { turnId: turn.workflowTurnId, turn_id: turn.workflowTurnId } : {}) } : {};
    const enrichedData = data && typeof data === 'object'
      ? { schema_version: 1, event_id: messageId, ...correlation, ...data }
      : data;
    // The RealtimeGateway is the sole socket writer. Sending here as well as
    // publishing caused every local event to arrive twice.
    this.publishToEventBus(userId, eventType, enrichedData, eventThreadId, messageId);
    logger.debug({ eventType, messageId, userId, eventThreadId }, '[WebSocketEmitter] Published event');
  }

  /**
   * Publish event to Redis Event Bus (non-blocking, fire-and-forget)
   */
  private publishToEventBus(
    userId: number,
    eventType: string,
    data: Record<string, unknown>,
    threadId: number | undefined,
    messageId: string,
  ): void {
    try {
      // Lazy import to avoid circular dependency at startup
      import('../../events/EventBus.js').then(({ eventBus }) => {
        eventBus.publish({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel: `events:ws:${eventType}` as any,
          messageId,
          userId,
          threadId,
          timestamp: new Date().toISOString(),
          data: data || {},
        }).catch(() => {}); // Silently ignore if Redis unavailable
      }).catch(() => {});
    } catch {
      // Ignore errors - Event Bus is optional
    }
  }

  /**
   * Get count of connected clients for a user
   */
  getClientCount(userId: number): number {
    return this.clients.get(userId)?.size || 0;
  }

  /**
   * Get the raw WebSocket from a tracked client (for RealtimeGateway compatibility)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTrackedClient(userId: number, ws: any): TrackedClient | undefined {
    return this.wsToClient.get(ws);
  }

  /**
   * Get total number of connected clients
   */
  getTotalClientCount(): number {
    let total = 0;
    this.clients.forEach((clients) => {
      total += clients.size;
    });
    return total;
  }
}

// Singleton instance
export const webSocketEmitter = new WebSocketEmitter();
