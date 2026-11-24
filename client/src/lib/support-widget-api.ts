import { api } from './api';
import type { SupportWidgetSettings, WidgetInstallation } from './support-widget-settings';

/** One dashboard read contract; each caller retains its own request/write lifetime. */
export interface SupportWidgetTeam {
  teamId: number;
  teamName: string;
  token: string | null;
  settings: SupportWidgetSettings;
  installation: WidgetInstallation | null;
}

export function listSupportWidgetTeams(options: { headers: Record<string, string>; signal: AbortSignal }) {
  return api.get<SupportWidgetTeam[]>('/api/support-widget/token', options);
}
