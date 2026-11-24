import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';
import type { Page } from '@playwright/test';

test.setTimeout(240_000);

async function mockSupportProgressSocket(page: Page) {
  await page.routeWebSocket('**/api/agents/progress**', () => {});
}

const notificationEvents = {
  ticketCreatedUnassigned: true,
  ticketAssigned: true,
  ticketReassigned: true,
  humanHandoff: true,
  customerReplied: true,
  ticketReopened: true,
  slaAtRisk: true,
  slaBreached: true,
  approvalRequired: true,
  deliveryFailed: true,
  ticketResolved: false,
};

const notificationPreferences = Object.fromEntries(
  ['email', 'whatsapp', 'slack', 'teams'].map(channel => [channel, {
    enabled: false,
    recipient: '',
    verificationStatus: 'unverified',
    events: notificationEvents,
  }]),
);

async function installSupportPortalShellMocks(page: Page) {
  await page.route('**/api/support-portal/me', route => route.fulfill({ json: { ...member, teamName: 'Billing' } }));
  await page.route('**/api/auth/csrf-token', route => route.fulfill({ json: { csrfToken: 'regression-token' } }));
  await page.route('**/api/support-portal/presence/heartbeat', route => route.fulfill({ json: { success: true } }));
  await page.route('**/api/support-portal/presence?*', route => route.fulfill({ json: { success: true, data: {
    memberId: member.id,
    timezone: 'Asia/Kolkata',
    presenceState: 'away',
    lastActivity: '2026-08-30T13:10:00.000Z',
    todayActiveMinutes: 147,
    todayFirstLogin: '2026-08-30T10:00:00.000Z',
    activeSessions: 0,
    unrepliedWorkload: 0,
    daily: [],
  } } }));
  await page.route('**/api/support-portal/stats', route => route.fulfill({ json: {
    total: 1, open: 0, inProgress: 0, waitingOnCustomer: 0, resolved: 0, closed: 1,
    highPriority: 0, totalReviews: 0, avgRating: 0,
  } }));
  await page.route('**/api/support-portal/notifications?*', route => route.fulfill({ json: { notifications: [], unreadCount: 0 } }));
  await page.route('**/api/support-portal/team-members', route => route.fulfill({ json: [] }));
}

const member = {
  id: 3,
  teamId: 1,
  userId: 4101,
  name: 'Support QA',
  email: 'support.qa@example.test',
  role: 'member',
  isActive: true,
  isOnCall: true,
  presenceState: 'away',
  unrepliedWorkload: 0,
  ticketPipeline: { open: 0, inProgress: 0, waitingOnCustomer: 0, resolved: 0, closed: 1, total: 1 },
};

const team = {
  id: 1,
  name: 'Billing',
  description: 'Billing support',
  color: '#3B82F6',
  icon: 'users',
  isActive: true,
  members: [member],
  activeMemberCount: 0,
  unrepliedWorkload: 0,
  ticketPipeline: member.ticketPipeline,
};

const ticket = {
  id: 55,
  ticketNumber: 'TKT-REGRESSION-55',
  subject: 'Invoice clarification for a customer',
  description: 'The customer needs a clear billing explanation.',
  status: 'closed',
  priority: 'high',
  category: 'billing',
  teamId: 1,
  assignedMemberId: 3,
  assignedMemberName: 'Support QA',
  customerName: 'Regression Customer',
  customerEmail: 'customer@example.test',
  channel: 'web',
  unreadCount: 0,
  operationalUnreadCount: 0,
  updatedAt: '2026-08-30T13:10:00.000Z',
  createdAt: '2026-08-30T12:10:00.000Z',
};

test('client support operations preserve team-first navigation and responsive member pipeline views', async ({ page, audit }) => {
  await mockSupportProgressSocket(page);
  const teamTicketRequests: string[] = [];
  const presenceRanges: string[] = [];
  page.on('request', request => {
    if (/\/api\/support\/teams\/\d+\/tickets/.test(request.url())) teamTicketRequests.push(request.url());
    const url = new URL(request.url());
    if (url.pathname === '/api/support/teams/1/members/3/presence') presenceRanges.push(url.searchParams.get('days') || '');
  });
  await page.route('**/api/support/teams', route => route.fulfill({ json: [team] }));
  await page.route('**/api/support/teams/capacity-settings', route => route.fulfill({ json: { handlingMinutesPerTicket: 5, socialFallbackSlaMinutes: 30, emailFallbackSlaMinutes: 240 } }));
  await page.route('**/api/support/teams/1', route => route.fulfill({ json: team }));
  await page.route('**/api/support/teams/1/tickets', route => route.fulfill({ json: [ticket] }));
  await page.route('**/api/support/teams/1/members/3/tickets', route => route.fulfill({ json: [ticket] }));
  await page.route('**/api/support/notification-settings', route => route.fulfill({ json: { recipients: [] } }));
  await page.route('**/api/support/teams/1/members/3/presence?*', route => route.fulfill({ json: {
    timezone: 'Asia/Kolkata', presenceState: 'away', lastActivity: '2026-08-30T13:10:00.000Z',
    todayActiveMinutes: 147, todayFirstLogin: '2026-08-30T10:00:00.000Z', activeSessions: 0, unrepliedWorkload: 0,
    daily: [{ date: '2026-08-30', activeMinutes: 147, firstLogin: '2026-08-30T10:00:00.000Z', lastActive: '2026-08-30T13:10:00.000Z', replies: 2, intervals: [] }],
  } }));
  await page.route('**/api/support?page=*', route => route.fulfill({ json: { tickets: [ticket], totalPages: 1, total: 1 } }));
  await page.route('**/api/support/analytics?*', route => route.fulfill({ json: {
    totalTickets: 1, openTickets: 0, activeTickets: 0, waitingOnCustomerTickets: 0, resolvedTickets: 1,
    avgResolutionHours: 0.5, avgFirstResponseHours: 0.3, slaBreaches: 0, handoffs: 1, deliveryFailures: 0,
    reviewCount: 0, averageRating: 0, days: 30, priorityDistribution: { high: 1 },
    statusDistribution: { closed: 1 }, ticketsByDay: [{ date: '2026-08-30', count: 1 }],
  } }));
  await page.route('**/api/support/55', route => route.fulfill({ json: {
    ...ticket,
    contactId: null,
    slaDeadline: null,
    tags: ['billing'],
    totalMessages: 1,
    closedAt: '2026-08-30T13:10:00.000Z',
    reviewRequestSentAt: null,
    rating: null,
    reviewComment: null,
    reviewSubmittedAt: null,
    customerName: 'Regression Customer',
    customerEmail: 'customer@example.test',
    conversationId: null,
    teamName: 'Billing',
    assignedMemberPresent: true,
    ownershipMode: 'human_owned',
    handoffId: null,
    handoffStatus: null,
    handoffReason: null,
    handoffTriggerType: null,
    handoffConfidenceScore: null,
    handoffSlaDeadline: null,
    deliveryStatus: 'sent',
    deliveryError: null,
    providerMessageId: null,
    latestTicketAutomation: null,
  } }));
  await page.route('**/api/support/55/timeline?*', route => route.fulfill({ json: {
    events: [{ key: 'ticket:71', id: 71, source: 'ticket', type: 'customer', direction: 'inbound',
      content: 'Synthetic billing timeline question.', actorName: 'Regression Customer',
      attachments: [], createdAt: ticket.createdAt, deliveryStatus: 'received',
      providerMessageId: null, deliveryError: null, restricted: false }],
    nextCursor: null,
  } }));
  await page.route('**/api/proposals/related?supportTicketId=55', route => route.fulfill({ json: [] }));

  await page.goto('/dashboard/support/teams', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Support teams' })).toBeVisible();
  await expect(page.getByText('Teams and assigned tickets')).toBeVisible();
  await expect(page.getByText('Assigned tickets', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open Billing team roster and task list' }).click();
  await expect(page.getByText('Team roster')).toBeVisible();
  await expect(page.getByText('Team task list')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset password', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open Support QA assigned tickets' }).click();
  await expect(page.getByRole('heading', { name: 'Support QA' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Team settings');
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Member tickets');
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).not.toContainText(/^Members$/);
  await expect(page.getByRole('button', { name: 'Disable member' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset password' })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: 'Activity history' }).click();
  await expect(page.getByText('Activity calendar · last 90 days')).toBeVisible();
  await page.getByRole('button', { name: '365 days' }).click();
  await expect(page.getByText('Activity calendar · last 365 days')).toBeVisible();
  expect(presenceRanges).toContain('90');
  expect(presenceRanges).toContain('365');
  await expectNoHorizontalOverflow(page);

  await page.goto('/dashboard/support/pipeline', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Support ticket pipeline' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Closed' })).toContainText('TKT-REGRESSION-55');
  expect(teamTicketRequests.length).toBeGreaterThan(0);
  await expectNoHorizontalOverflow(page);

  await page.goto('/dashboard/support/analytics', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('ticket created on 2026-08-30')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto('/dashboard/support/55', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Back to support tickets' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Update ticket status' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Update ticket priority' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Assign support team member' })).toBeVisible();
  await expect(page.getByText(/Sending a customer reply.*will reopen it/)).toBeVisible();
  await expect(page.getByText('Synthetic billing timeline question.', { exact: true })).toBeVisible();
  await expect(page.getByText('Proposals (0)', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(audit.consoleErrors).toEqual([]);
});
test('support member ticket views are labeled and protect closed customer conversations', async ({ page, audit }) => {
  await mockSupportProgressSocket(page);
  await installSupportPortalShellMocks(page);
  await page.route('**/api/support-portal/tickets?*', route => route.fulfill({ json: { tickets: [{
    ...ticket, totalMessages: 1, rating: null, reviewSubmittedAt: null, slaDeadline: null,
  }], totalPages: 1, total: 1, page: 1 } }));
  await page.route('**/api/support-portal/tickets/55', route => route.fulfill({ json: {
    ...ticket, totalMessages: 1, tags: ['billing'], slaDeadline: null, resolvedAt: null,
    closedAt: '2026-08-30T13:10:00.000Z', reviewRequestSentAt: null, rating: null,
    reviewComment: null, reviewSubmittedAt: null,
    messages: [{ id: 1, ticketId: 55, userId: null, direction: 'inbound', content: 'Please clarify this invoice.', isInternal: false, attachments: [], createdAt: '2026-08-30T12:10:00.000Z' }],
  } }));
  await page.route('**/api/support-portal/tickets/55/timeline?*', route => route.fulfill({ json: { events: [], nextCursor: null } }));

  await page.goto('/support/tickets', { waitUntil: 'domcontentloaded' });
  const mobileNavigation = page.viewportSize()!.width < 1024;
  const navigationTrigger = page.getByRole('button', { name: 'Open support navigation' });
  if (mobileNavigation) {
    await navigationTrigger.click();
    await expect(page.getByRole('dialog', { name: 'Support navigation' })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Tickets', exact: true })).toBeVisible();
  if (mobileNavigation) {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Support navigation' })).toBeHidden();
    await expect(navigationTrigger).toBeFocused();
  }
  await expect(page.getByRole('textbox', { name: 'Search assigned tickets' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Filter tickets by status' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invoice clarification for a customer' })).toBeVisible();
  await page.goto('/support/tickets/55', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/This ticket is closed\. Reopen it/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Write a customer reply' })).toBeDisabled();
  await page.getByRole('button', { name: 'Internal Note' }).click();
  await expect(page.getByRole('textbox', { name: 'Write an internal note' })).toBeEnabled();
  await expectNoHorizontalOverflow(page);
  expect(audit.consoleErrors).toEqual([]);
});
test('support member auxiliary pages expose named controls on desktop and mobile', async ({ page, audit }) => {
  await mockSupportProgressSocket(page);
  await installSupportPortalShellMocks(page);
  await page.route('**/api/support-portal/knowledge-base?*', route => route.fulfill({ json: {
    entries: [], total: 0, page: 1, totalPages: 1,
  } }));
  await page.route('**/api/support-portal/chat/sessions?*', route => route.fulfill({ json: [] }));
  await page.route('**/api/support-portal/notification-availability', route => route.fulfill({ json: {
    isOnCall: true,
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    quietHours: { enabled: false, start: '22:00', end: '08:00' },
  } }));
  await page.route('**/api/support-portal/notification-preferences', route => route.fulfill({ json: notificationPreferences }));
  await page.route('**/api/support-portal/notification-defaults', route => route.fulfill({ json: notificationPreferences }));
  await page.route('**/api/support-portal/media-galleries', route => route.fulfill({ json: { galleries: [] } }));
  await page.route('**/api/support-portal/playbooks', route => route.fulfill({ json: { playbooks: [] } }));
  await page.route('**/api/support-portal/tickets?*', route => route.fulfill({ json: { tickets: [], totalPages: 1, total: 0, page: 1 } }));
  await page.route('**/api/support-portal/handoffs?*', route => route.fulfill({ json: [] }));
  await page.route('**/api/support-portal/canned-responses', route => route.fulfill({ json: [] }));

  await page.goto('/support/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toContainText('Support');
  await expect(page.getByText('No assigned tickets found')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto('/support/handoffs', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/support\/tickets\?handoff=active$/);
  await expect(page.getByRole('heading', { name: 'Ticket operations' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Filter tickets by handoff' })).toHaveValue('active');
  await expect(page.getByText('No tickets match this view')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto('/support/knowledge-base', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('textbox', { name: 'Search knowledge base' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Filter knowledge base by type' })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto('/support/media', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Media Library' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search media library' })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto('/support/playbooks', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Support Playbooks' })).toBeVisible();
  await expect(page.getByText('No published playbooks')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto('/support/analytics', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'My performance' })).toBeVisible();
  await expect(page.getByLabel('100% workload completion')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto('/support/notifications', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Notification center' })).toBeVisible();
  await expect(page.getByText('No support alerts yet')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto('/support/profile', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'My Profile' })).toBeVisible();
  await expect(page.getByText('Away', { exact: true })).toBeVisible();
  await expect(page.getByText('Active member', { exact: true })).toBeVisible();
  await expect(page.getByText('Today, 2:42 PM', { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await page.goto('/support/chat', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(1);
  await expectNoHorizontalOverflow(page);

  await page.goto('/support/settings', { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Timezone')).toBeVisible();
  await expect(page.getByLabel('Quiet hours start')).toBeVisible();
  await expect(page.getByLabel('Current Password')).toBeVisible();
  await expect(page.getByLabel('Confirm Password')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(audit.consoleErrors).toEqual([]);
});
