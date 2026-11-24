import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DocumentationContent } from '@/components/documentation/DocumentationWorkspace';
import { documentationArticles, searchDocumentation } from '@/content/documentation';
import { canOpenDocumentationDestination, documentationHrefForPath, type DocumentationAccess } from '@/lib/documentation-navigation';
import { bottomNavItems } from '@/lib/sidebarConfig';
import DocumentationPage from '@/app/documentation/[[...slug]]/page';

vi.mock('@/components/PublicLayout', () => ({ default: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('@/hooks/use-business-profiles', () => ({ useBusinessProfiles: vi.fn() }));
vi.mock('@/hooks/use-platform-access', () => ({ usePlatformAccess: vi.fn() }));
afterEach(cleanup);
const root = path.resolve(__dirname, '../../..');
const owner: DocumentationAccess = { verified: true, role: 'owner', modules: ['campaigns', 'lead_generation', 'content', 'performance_marketing', 'ai_visibility', 'outreach', 'crm', 'support', 'support_ai', 'proposals', 'knowledge_base', 'integrations', 'billing', 'storage'] };

describe('Documentation content and destinations', () => {
  it.each([['unknown-topic'], ['assistants', 'unexpected-child']])('recovers an invalid topic path without throwing a dashboard error: %j', async (...segments) => {
    const element = await DocumentationPage({ params: Promise.resolve({ slug: segments }) });
    render(element);
    expect(screen.getByRole('heading', { name: 'Documentation topic not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse documentation' })).toHaveAttribute('href', '/documentation');
  });
  it('renders a guide without a session or private destination links', async () => {
    const element = await DocumentationPage({ params: Promise.resolve({ slug: ['integrations'] }) });
    render(element);
    expect(screen.getByRole('heading', { name: documentationArticles.find(article => article.slug === 'integrations')!.title })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open All Integrations' })).not.toBeInTheDocument();
  });
  it('provides discoverable help and full-text search without making external requests', () => {
    expect(bottomNavItems.find(item => item.path === '/documentation')?.aliases).toContain('Help');
    render(<DocumentationContent access={owner} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search documentation' }), { target: { value: 'receipt recovery' } });
    expect(searchDocumentation('receipt recovery').length).toBeGreaterThan(0);
    expect(screen.getByRole('status')).toHaveTextContent('matching');
    const results = screen.getByRole('region', { name: 'Documentation search results' });
    expect(within(results).getAllByRole('link').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no-such-topic-9z' } });
    expect(screen.getByText(/No topics match/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('region', { name: 'Documentation search results' })).getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('heading', { name: 'Learn your workspace' })).toBeInTheDocument();
  });

  it('retains mandatory assistant gating, no fallback and no replay explanations in context', () => {
    render(<DocumentationContent slug="assistants" access={owner} />);
    expect(screen.getByText('Customer delivery is blocked while assistant runtime is disabled.')).toBeInTheDocument();
    expect(screen.getByText(/Legacy specialist settings provide no delivery fallback/)).toBeInTheDocument();
    expect(screen.getByText('Setup does not automatically replay held work.')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'On this page' })).toHaveTextContent('mandatory delivery prerequisite');
    expect(screen.getByRole('img')).toHaveAttribute('src', '/documentation/diagrams/assistant-gate.svg');
    expect(screen.getByRole('img').getAttribute('alt')!.length).toBeGreaterThan(80);
  });

  it('withholds action links on failed role verification and filters role and module destinations', () => {
    const { rerender } = render(<DocumentationContent slug="integrations" access={{ ...owner, verified: false }} />);
    expect(screen.queryByRole('link', { name: 'Open All Integrations' })).not.toBeInTheDocument();
    rerender(<DocumentationContent slug="integrations" access={{ ...owner, role: 'member' }} />);
    expect(screen.queryByRole('link', { name: 'Open All Integrations' })).not.toBeInTheDocument();
    rerender(<DocumentationContent slug="integrations" access={{ ...owner, modules: [] }} />);
    expect(screen.queryByRole('link', { name: 'Open All Integrations' })).not.toBeInTheDocument();
    rerender(<DocumentationContent slug="integrations" access={owner} />);
    expect(screen.getByRole('link', { name: 'Open All Integrations' })).toHaveAttribute('href', '/dashboard/integrations');
    expect(canOpenDocumentationDestination('/dashboard/support/teams', { ...owner, role: 'billing_admin' })).toBe(false);
    expect(canOpenDocumentationDestination('/dashboard/settings/outreach', { ...owner, modules: ['outreach'] })).toBe(false);
    expect(canOpenDocumentationDestination('/dashboard/outreach/twitter', owner)).toBe(false);
    expect(canOpenDocumentationDestination('https://example.com', owner)).toBe(false);
  });

  it('maps contextual deep links without prefix collisions', () => {
    expect(documentationHrefForPath('/dashboard/settings/outreach/assistants/demo')).toBe('/documentation/assistants');
    expect(documentationHrefForPath('/dashboard/crm/import')).toBe('/documentation/imports-and-exports');
    expect(documentationHrefForPath('/dashboard/outreach/follow-ups')).toBe('/documentation/manual-follow-ups');
    expect(documentationHrefForPath('/dashboard/saved-templates/email/generate')).toBe('/documentation/email-and-templates');
    expect(documentationHrefForPath('/dashboard/documentation')).toBeNull();
    expect(documentationHrefForPath('/dashboard/supportive')).toBeNull();
  });

  it('keeps source evidence, unique anchors, rendered SVGs and internal guide links valid', () => {
    expect(new Set(documentationArticles.map(article => article.slug)).size).toBe(documentationArticles.length);
    for (const article of documentationArticles) {
      expect(new Set(article.sections.map(section => section.id)).size).toBe(article.sections.length);
      expect(article.prerequisites.length).toBeGreaterThan(0);
      for (const file of article.evidence) expect(existsSync(path.join(root, file)), `${article.slug}: ${file}`).toBe(true);
      for (const section of article.sections) {
        for (const match of section.body.matchAll(/\]\(\/documentation\/([^\s)]+)\)/g)) {
          const [slug, anchor] = match[1].split('#');
          const target = documentationArticles.find(item => item.slug === slug);
          expect(target).toBeDefined();
          if (anchor) expect(target?.sections.some(item => item.id === anchor)).toBe(true);
        }
        if (!section.diagram) continue;
        const svg = readFileSync(path.join(root, 'client/public/documentation/diagrams', `${section.diagram.id}.svg`), 'utf8');
        expect(svg).toContain('<svg');
        expect(svg).toContain('<title');
        expect(svg).toContain('<desc');
        expect(svg).not.toMatch(/<script\b|<foreignObject\b|(?:href|src)=["'](?:https?:|javascript:)/i);
        expect(existsSync(path.join(root, 'scripts/documentation/diagrams', `${section.diagram.id}.mmd`))).toBe(true);
      }
    }
  });
});
