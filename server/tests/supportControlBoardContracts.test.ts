import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('support control board contracts', () => {
  it('uses reader-scoped cursors instead of clearing a shared unread counter', () => {
    const migration = read('migrations/232_add_support_ticket_read_receipts.js');
    const owner = read('controllers/supportController.ts');
    const member = read('controllers/supportMemberController.ts');
    const service = read('services/SupportService.ts');
    expect(migration).toContain('support_ticket_read_receipts');
    expect(migration).toContain("reader_kind IN ('owner', 'member')");
    expect(owner).toContain("markTicketRead(userId, ticket.id, 'owner', req.user!.id)");
    expect(member).toContain("markTicketRead(ticket.userId, ticketId, 'member', member.id)");
    expect(owner).not.toContain('SET unread_count = 0');
    expect(member).not.toContain('set({ unreadCount: 0 })');
    expect(service).toContain('operational_unread_count');
  });

  it('returns a complete operational queue workspace', () => {
    const service = read('services/SupportService.ts');
    expect(service).toContain('customerName:');
    expect(service).toContain('assignedMemberPresent:');
    expect(service).toContain('handoffReason:');
    expect(service).toContain('deliveryStatus:');
    expect(service).toContain("filters?.sort === 'oldest'");
    expect(service).toContain("filters?.sla === 'breached'");
  });

  it('keeps analytics statuses mutually intelligible and reports operational health', () => {
    const service = read('services/SupportService.ts');
    expect(service).toContain('waitingOnCustomerTickets');
    expect(service).toContain('avgFirstResponseHours');
    expect(service).toContain('deliveryFailures');
    expect(service).toContain('averageRating');
    expect(service).toContain('openTickets: Number(statusDist?.open || 0)');
  });

  it('makes handoff resolution ownership explicit in the owner workspace', () => {
    const page = read('../client/src/app/dashboard/(main)/support/[id]/page.tsx');
    const routes = read('routes/support.routes.ts');
    expect(page).toContain('Keep human ownership');
    expect(page).toContain('End human takeover after resolution');
    expect(page).toContain('AI replies still require runtime, assistant and delivery readiness');
    expect(page).toContain('deliveryAttemptCount');
    expect(routes).toContain("'/:id/resolve-ownership'");
  });

  it('renders member activity on a dedicated week-aligned history page', () => {
    const teamPage = read('../client/src/app/dashboard/(main)/support/teams/[id]/page.tsx');
    const activityPage = read('../client/src/app/dashboard/(main)/support/teams/[id]/members/[memberId]/activity/page.tsx');
    const activityCalendar = read('../client/src/components/support/SupportActivityCalendar.tsx');
    expect(teamPage).not.toContain('MemberPresence');
    expect(activityPage).toContain('<SupportActivityCalendar daily={presence.daily} days={days} timezone={presence.timezone}');
    expect(activityCalendar).toContain('grid-flow-col grid-rows-7');
    expect(activityCalendar).toContain('<span>Mon</span>');
    expect(activityPage).toContain('90 days');
    expect(activityPage).toContain('365 days');
  });

  it('keeps team operations centered on a team-first workload and separate member workspaces', () => {
    const controller = read('controllers/supportTeamsController.ts');
    const teamsPage = read('../client/src/app/dashboard/(main)/support/teams/page.tsx');
    const detailPage = read('../client/src/app/dashboard/(main)/support/teams/[id]/page.tsx');
    const memberPage = read('../client/src/app/dashboard/(main)/support/teams/[id]/members/[memberId]/page.tsx');
    const pipelinePage = read('../client/src/app/dashboard/(main)/support/pipeline/page.tsx');
    const sidebar = read('../client/src/lib/sidebarConfig.tsx');
    expect(controller).toContain('ticketPipeline:');
    expect(controller).toContain('pipelineByMember');
    expect(controller).toContain("status === 'waiting_on_customer'");
    expect(teamsPage).toContain('Teams and assigned tickets');
    expect(teamsPage).toContain('Choose a team to open its member roster and complete ticket worklist.');
    expect(teamsPage).toContain('Assigned tickets');
    expect(teamsPage).toContain('/dashboard/support/teams/${team.id}');
    expect(teamsPage).toContain('<TeamPipeline');
    expect(detailPage).toContain('Queue pipeline');
    expect(detailPage).toContain('waiting_on_customer');
    expect(detailPage).toContain('visibleTickets');
    expect(detailPage).toContain('Team roster');
    expect(detailPage).toContain('Team task list');
    expect(detailPage).toContain('Reset password');
    expect(detailPage).toContain('member.isActive ? "Disable" : "Activate"');
    expect(detailPage).toContain('/members/${member.id}');
    expect(memberPage).toContain('Assigned tickets');
    expect(memberPage).toContain('Activity history');
    expect(memberPage).toContain('Disable member');
    expect(memberPage).toContain('Activate member');
    expect(memberPage).toContain('Reset password');
    expect(pipelinePage).toContain('Support ticket pipeline');
    expect(pipelinePage).toContain('Filter pipeline by support team');
    expect(pipelinePage).toContain('All team members');
    expect(pipelinePage).toContain('/api/support?page=1&limit=100&sort=operational');
    expect(pipelinePage).not.toContain('safeTeams.map((team) => api.get');
    expect(sidebar).toContain('{ label: "Pipeline", path: "/dashboard/support/pipeline"');
  });

  it('keeps nested support navigation and member ticket controls operator-facing', () => {
    const breadcrumbs = read('../client/src/components/Breadcrumbs.tsx');
    const ownerQueue = read('../client/src/app/dashboard/(main)/support/page.tsx');
    const ownerTicketWorkspace = read('../client/src/app/dashboard/(main)/support/[id]/page.tsx');
    const teamWorkspace = read('../client/src/app/dashboard/(main)/support/teams/[id]/page.tsx');
    const memberTickets = read('../client/src/app/support/tickets/page.tsx');
    const ticketWorkspace = read('../client/src/app/support/tickets/[id]/page.tsx');
    const assistant = read('../client/src/app/support/chat/page.tsx');
    const knowledgeBase = read('../client/src/app/support/knowledge-base/page.tsx');
    const settings = read('../client/src/app/support/settings/page.tsx');
    expect(breadcrumbs).toContain('Team settings');
    expect(breadcrumbs).toContain('Member tickets');
    expect(breadcrumbs).toContain('Ticket workspace');
    expect(breadcrumbs).toContain('segment === "members"');
    expect(memberTickets).toContain('aria-label="Search assigned tickets"');
    expect(memberTickets).toContain('ariaLabel="Filter tickets by status"');
    expect(memberTickets).toContain('window.setTimeout(() => update({ search: search.trim() }, true), 300)');
    expect(ticketWorkspace).toContain('This ticket is closed. Reopen it');
    expect(ticketWorkspace).toContain('ticket.status === "closed" && !isInternal');
    expect(ownerTicketWorkspace).toContain('aria-label="Update ticket status"');
    expect(ownerTicketWorkspace).toContain('aria-label="Assign support team member"');
    expect(ownerTicketWorkspace).toContain('Sending a customer reply from the client workspace will reopen it');
    expect(teamWorkspace).toContain('aria-label="Back to support teams"');
    const createDialog = read('../client/src/components/support/CreateSupportTicketDialog.tsx');
    expect(ownerQueue).toContain('CreateSupportTicketDialog');
    expect(createDialog).toContain('aria-label="New ticket priority"');
    expect(createDialog).toContain('aria-label="Assign new ticket to support team"');
    expect(assistant).toContain('aria-label="Send message"');
    expect(assistant).toContain('aria-label="Log out"');
    expect(knowledgeBase).toContain('aria-label="Filter knowledge base by type"');
    expect(knowledgeBase).toContain('aria-label="Search knowledge base"');
    expect(settings).toContain('htmlFor="support-timezone"');
    expect(settings).toContain('htmlFor="current-password"');
  });

  it('shows authoritative member presence and account status on the profile', () => {
    const profile = read('../client/src/app/support/profile/page.tsx');
    const authContext = read('../client/src/contexts/SupportAuthContext.tsx');
    const login = read('../client/src/app/support/login/page.tsx');
    const memberController = read('controllers/supportMemberController.ts');
    expect(profile).toContain('/api/support-portal/presence?days=1');
    expect(profile).toContain('Today&apos;s first login');
    expect(profile).toContain('Active member');
    expect(profile).not.toContain('Today, 2:42 PM');
    expect(profile).not.toContain('Verified Agent');
    expect(authContext).toContain('isActive: boolean');
    expect(login).toContain('isActive: boolean');
    expect(memberController).toContain('isActive: member.isActive !== false');
  });

  it('keeps support-member resources read-only and removes the social inbox', () => {
    const memberRoutes = read('routes/supportMember.routes.ts');
    const memberSidebar = read('../client/src/lib/supportSidebarConfig.tsx');
    expect(memberRoutes).toContain("router.get('/knowledge-base', getSupportKnowledgeBase)");
    expect(memberRoutes).toContain("router.get('/media-galleries', listMemberMediaGalleries)");
    expect(memberRoutes).toContain("router.get('/playbooks', listMemberPlaybooks)");
    expect(memberRoutes).not.toMatch(/router\.(post|put|patch|delete)\('\/(knowledge-base|media-galleries|playbooks)/);
    expect(memberSidebar).not.toContain('/support/social-inbox');
  });

  it('places support-member notification administration on its dedicated page', () => {
    const teamsPage = read('../client/src/app/dashboard/(main)/support/teams/page.tsx');
    const notificationsPage = read('../client/src/app/dashboard/(main)/support/notifications/page.tsx');
    expect(teamsPage).not.toContain('<OwnerSupportNotificationSettings');
    expect(teamsPage).toContain('/dashboard/support/notifications');
    expect(notificationsPage).toContain('<OwnerSupportNotificationSettings');
  });
});
