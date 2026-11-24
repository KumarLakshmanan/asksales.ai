import type { WidgetState } from '../models/widgetStates/schema.js';

interface CompletionNotificationDependencies {
  pending(): Promise<WidgetState[]>;
  emit(userId: number, threadId: number, widget: WidgetState, eventId: string): Promise<void> | void;
  resume?(widget: WidgetState): Promise<'resumed' | 'waiting' | 'obsolete' | 'completed' | 'failed'>;
  acknowledge(id: number, userId: number, eventId: string): Promise<void>;
  onError(error: unknown, widgetId: number): void;
}

/** At-least-once dispatch: a crash after emit replays the same event identity.
 * Dispatched means handed to the realtime gateway, not received by a browser.
 * Reconnecting clients still rebuild from the authoritative widget row.
 */
export async function dispatchWidgetCompletionNotifications(deps: CompletionNotificationDependencies): Promise<number> {
  let dispatched = 0;
  for (const widget of await deps.pending()) {
    const result = widget.executionResult as { completionNotification?: { status?: string; eventId?: string } } | null;
    const notification = result?.completionNotification;
    if (!['succeeded', 'failed'].includes(widget.status) || notification?.status !== 'pending'
      || typeof notification.eventId !== 'string' || !notification.eventId
      || !Number.isSafeInteger(widget.userId) || widget.userId <= 0
      || !Number.isSafeInteger(widget.threadId) || widget.threadId <= 0) continue;
    try {
      // Realtime transport availability must not gate durable orchestration.
      // Keep the marker pending if delivery fails, but still resume the run.
      let emitted = false;
      try {
        await deps.emit(widget.userId, widget.threadId, widget, notification.eventId);
        emitted = true;
      } catch (error) { deps.onError(error, widget.id); }
      const continuation = await deps.resume?.(widget);
      if (!emitted || continuation === 'waiting' || continuation === 'failed') continue;
      await deps.acknowledge(widget.id, widget.userId, notification.eventId);
      dispatched += 1;
    } catch (error) { deps.onError(error, widget.id); }
  }
  return dispatched;
}
