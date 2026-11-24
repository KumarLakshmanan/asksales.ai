"use client";

import Link from 'next/link';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { assistantAvailabilityIssues, type AssistantAvailability } from '@/lib/outreach-assistants';
import type { AssistantPanelProps } from './AssistantConfiguration';
import { ConfigurationSection, Field } from './AssistantShared';
import { deviceTimeZone } from '../../../../../shared/timeZones';

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function nextRange(ranges: AssistantAvailability['weekly'][number]['ranges']) {
  const start = ranges.at(-1)?.end || '09:00';
  const [hour, minute] = start.split(':').map(Number);
  const endMinutes = Math.min(hour * 60 + minute + 60, 1440);
  const end = endMinutes === 1440
    ? '24:00'
    : `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
  return { start, end };
}

export function AvailabilityConfiguration({ draft, catalog, onChange }: AssistantPanelProps) {
  const availability = draft.availability;
  const issues = assistantAvailabilityIssues(availability);
  const updateAvailability = (next: AssistantAvailability) => onChange({ ...draft, availability: next });
  const updateDay = (day: number, ranges: AssistantAvailability['weekly'][number]['ranges']) =>
    updateAvailability({
      ...availability,
      weekly: [...availability.weekly.filter(item => item.day !== day), { day, ranges }].sort((a, b) => a.day - b.day),
    });

  return (
    <div className="ak-availability space-y-5">
      <ConfigurationSection
        title="Availability"
        description="Choose when customers can receive automated replies."
      >
        <fieldset className="grid gap-3 sm:grid-cols-2"><legend className="sr-only">Reply schedule</legend>{[[false, 'Always available', 'Reply any day, at any time.'], [true, 'Weekly schedule', 'Choose the days and hours for replies.']].map(([enabled, title, description]) => <label key={String(enabled)} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${availability.enabled === enabled ? 'border-primary bg-primary/5' : ''}`}><input type="radio" name="assistant-availability-mode" checked={availability.enabled === enabled} onChange={() => updateAvailability({ ...availability, enabled: Boolean(enabled) })} className="mt-1 h-4 w-4 shrink-0 accent-primary" /><span><span className="block text-sm font-medium">{title}</span><span className="mt-1 block text-xs leading-6 text-muted-foreground">{description}</span></span></label>)}</fieldset>
        <p className="mt-3 text-xs leading-6 text-muted-foreground">{availability.enabled ? 'Outside these hours, replies pause and support check-ins wait until the next open period.' : 'Available 24/7, subject to provider restrictions and human-support mode.'}</p>
        <div className="mt-5 space-y-5">
          <Field
            label="Timezone"
            htmlFor="assistant-timezone"
            hint="All weekly hours and delivery history use this timezone."
          >
            <Input
              id="assistant-timezone"
              list="assistant-timezone-options"
              maxLength={100}
              value={availability.timezone}
              onChange={event => updateAvailability({ ...availability, timezone: event.target.value })}
              placeholder="Asia/Kolkata"
              autoComplete="off"
            />
          </Field>

          <datalist id="assistant-timezone-options">{['UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'].map(zone => <option key={zone} value={zone} />)}</datalist>
          <Button type="button" variant="outline" onClick={() => updateAvailability({ ...availability, timezone: deviceTimeZone() })}>Use my timezone</Button>
          {availability.enabled && <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => updateAvailability({ ...availability, weekly: weekdays.map((_, at) => ({ day: at + 1, ranges: at < 5 ? [{ start: '09:00', end: '17:00' }] : [] })) })}>Use weekdays 9–5</Button><Button type="button" variant="outline" onClick={() => updateAvailability({ ...availability, weekly: weekdays.map((_, at) => ({ day: at + 1, ranges: [{ start: '09:00', end: '17:00' }] })) })}>Use every day 9–5</Button></div>}
          {issues.length > 0 && (
            <Callout
              tone="warning"
              role="alert"
              title="Repair the stored availability settings before saving or publishing"
              actions={availability.weekly.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => updateAvailability({ ...availability, weekly: [] })}
                >
                  Clear stored weekly hours
                </Button>
              ) : undefined}
            >
              <ul className="list-disc space-y-1 pl-5">
                {issues.map(issue => <li key={issue}>{issue}</li>)}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Turning weekly restrictions off does not repair an invalid timezone or stored range.
              </p>
            </Callout>
          )}

          <details open={availability.enabled || issues.length > 0}>
            <summary className="min-h-11 cursor-pointer text-sm font-semibold">
              {availability.enabled ? 'Weekly hours' : 'Stored weekly hours · Inactive'}
            </summary>
            <div className="mt-3 divide-y rounded-xl border">
              {weekdays.map((label, index) => {
                const day = index + 1;
                const ranges = availability.weekly.find(item => item.day === day)?.ranges || [];
                return (
                  <div key={day} className="ak-schedule-row">
                    <div className="ak-schedule-heading">
                      <h3 className="text-sm font-semibold">{label}</h3>
                      <label className="flex min-h-11 items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          aria-label={`${label} open`}
                          className="h-4 w-4 accent-primary"
                          checked={ranges.length > 0}
                          onChange={event => updateDay(day, event.target.checked ? [{ start: '09:00', end: '17:00' }] : [])}
                        />
                        {ranges.length ? 'Open' : 'Closed'}
                      </label>
                    </div>
                    <div className="ak-schedule-ranges space-y-3">
                      {ranges.map((range, rangeIndex) => (
                        <div key={rangeIndex} className="flex flex-wrap items-end gap-3">
                          <div className="min-w-[120px] flex-1 sm:max-w-[200px]">
                            <Field label="From" htmlFor={`availability-start-${day}-${rangeIndex}`}>
                              <Input
                                id={`availability-start-${day}-${rangeIndex}`}
                                type="time"
                                value={range.start}
                                onChange={event => updateDay(day, ranges.map((item, at) => at === rangeIndex ? { ...item, start: event.target.value } : item))}
                              />
                            </Field>
                          </div>
                          <div className="min-w-[120px] flex-1 sm:max-w-[200px]">
                            <Field label="Until" htmlFor={`availability-end-${day}-${rangeIndex}`} hint="HH:MM; use 24:00 for midnight.">
                              <Input
                                id={`availability-end-${day}-${rangeIndex}`}
                                type="text"
                                inputMode="numeric"
                                maxLength={5}
                                placeholder="17:00 or 24:00"
                                value={range.end}
                                onChange={event => updateDay(day, ranges.map((item, at) => at === rangeIndex ? { ...item, end: event.target.value } : item))}
                              />
                            </Field>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            aria-label={`Remove ${label} hours ${rangeIndex + 1}`}
                            onClick={() => updateDay(day, ranges.filter((_, at) => at !== rangeIndex))}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                    {ranges.length > 0 && <div className="ak-schedule-actions mt-3 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={ranges.length >= 8 || ranges.at(-1)?.end === '24:00'}
                        onClick={() => updateDay(day, [...ranges, nextRange(ranges)])}
                      >
                        <Plus className="h-4 w-4" />Add hours
                      </Button>
                      {day === 1 && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => updateAvailability({ ...availability, weekly: weekdays.map((_, at) => ({ day: at + 1, ranges: ranges.map(range => ({ ...range })) })) })}
                        >
                          Copy Monday to all
                        </Button>
                      )}
                    </div>}
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              A full day is 00:00–24:00. Ranges cannot overlap or cross midnight. For an overnight period, use 22:00–24:00 on one day and 00:00–06:00 on the next day.
            </p>
          </details>

          <details open={availability.enabled} className="rounded-xl border px-4"><summary className="min-h-11 cursor-pointer py-3 text-sm">Away message</summary><div className="pb-4">          <Field
            label="Away message (optional)"
            htmlFor="assistant-away-message"
            hint="Used only when weekly restrictions are enabled. Sent at most once every six hours per customer and receiving account; it does not start follow-ups."
          >
            <Textarea
              id="assistant-away-message"
              rows={3}
              maxLength={1000}
              value={availability.awayMessage || ''}
              onChange={event => updateAvailability({ ...availability, awayMessage: event.target.value || null })}
            />
          </Field></div></details>
        </div>
      </ConfigurationSection>
      <details className="rounded-xl border bg-card px-5"><summary className="min-h-12 cursor-pointer py-4 text-sm font-medium">Staff access</summary><p className="pb-4 text-sm leading-6 text-muted-foreground">{catalog.permissions.description} Assistant assignments do not change staff roles or access to private customer data.</p><Button type="button" variant="outline" asChild className="mb-5"><Link href="/dashboard/settings/team">Manage staff permissions</Link></Button></details>
    </div>
  );
}
