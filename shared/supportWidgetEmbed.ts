/** The loader and customer page share a dismissal command, never session data. */
export const SUPPORT_WIDGET_CLOSE_MESSAGE = 'asksales:support-widget:close';
export const SUPPORT_WIDGET_HOST_PARAMETER = 'widgetHostOrigin';

export function supportWidgetHostOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}
