"use client";

import type { CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DEFAULT_BUSINESS_TIMEZONE } from '@/lib/timezoneDefaults';
import { calculateProposalPricing, type ProposalDocument as DocumentModel, type ProposalSection } from '../../../../shared/proposals';

export type ProposalBrand = { companyName: string; logoUrl?: string | null; primaryColor?: string };
export type CustomerProposalDocument = DocumentModel & { generatedSections?: ProposalSection[]; signedByName?: string | null; signedAt?: string | null };

function documentUrl(value?: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('/uploads/') && !value.includes('\\')) return value;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}

export function ProposalMarkdown({ children }: { children: string }) {
  return <div className="proposal-prose"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children: label }) => documentUrl(href) ? <a href={documentUrl(href)} target="_blank" rel="noopener noreferrer">{label}</a> : <span>{label}</span>,
    // Images are explicitly added by the seller and never interpreted as HTML.
    img: ({ src, alt }) => documentUrl(typeof src === 'string' ? src : undefined) ? <img src={documentUrl(String(src))} alt={alt || ''} crossOrigin="anonymous" /> : <span>{alt || 'Image unavailable'}</span>,
  }}>{children}</ReactMarkdown></div>;
}

export function ProposalDocument({ proposal, brand, compact = false, id }: { proposal: CustomerProposalDocument; brand?: ProposalBrand; compact?: boolean; id?: string }) {
  const pricing = calculateProposalPricing(proposal);
  const sections = proposal.metadata?.generatedSections || proposal.generatedSections || [];
  const commercial = proposal.metadata?.commercial;
  const color = /^#[0-9a-f]{6}$/i.test(brand?.primaryColor || '') ? brand!.primaryColor : '#2563eb';
  const currency = /^[A-Z]{3}$/.test(proposal.currency || '') ? proposal.currency! : 'USD';
  const amount = (value: number) => `${currency} ${new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
  const termsInSections = sections.some(section => section.kind === 'terms' && section.body.trim());
  const periodLabels = { one_time: 'One time', monthly: '/ month', quarterly: '/ quarter', yearly: '/ year' };
  const date = (value: string | Date) => new Date(value).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: DEFAULT_BUSINESS_TIMEZONE });
  return <article id={id} className={`proposal-paper ${compact ? 'proposal-paper-compact' : ''}`} style={{ '--proposal-brand': color } as CSSProperties} aria-label="Customer proposal document">
    <style>{`
      .proposal-paper{color:#0f172a;background:#fff;padding:40px;box-shadow:0 1px 3px #0f172a12;border:1px solid #e2e8f0;font:14px/1.6 "Avenir Next","Segoe UI",Arial,sans-serif;overflow-wrap:anywhere;color-scheme:light}
      .proposal-paper-compact{padding:24px;font-size:12px}
      .proposal-paper h1,.proposal-paper h2,.proposal-paper h3{color:#0f172a;line-height:1.3}
      .proposal-paper h1{font-size:30px;margin:28px 0 10px;letter-spacing:-.025em}
      .proposal-paper h2{font-size:19px;margin:0 0 12px}.proposal-paper h3{font-size:16px}
      .proposal-paper section{margin-top:28px}.proposal-paper small{color:#475569}
      .proposal-paper .proposal-brand{display:flex;flex-wrap:wrap;align-items:center;gap:14px;border-bottom:3px solid var(--proposal-brand);padding-bottom:20px}
      .proposal-paper .proposal-brand img{max-height:48px;max-width:160px;object-fit:contain}.proposal-paper .proposal-brand strong{font-size:18px;flex:1 1 160px;min-width:0}
      .proposal-paper .proposal-meta{display:flex;flex-wrap:wrap;gap:20px 40px;margin:16px 0 28px}.proposal-paper .proposal-meta strong{display:block}
      .proposal-paper table{border-collapse:collapse;width:100%;font-size:11px}.proposal-paper th{text-align:left;background:#f1f5f9;color:#334155}
      .proposal-paper th,.proposal-paper td{padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top}.proposal-paper .amount{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
      .proposal-paper thead{display:table-header-group}.proposal-paper tr{break-inside:avoid}.proposal-paper .proposal-pricing-table{table-layout:fixed}.proposal-paper .proposal-brand small{flex:0 1 auto;max-width:100%}
      .proposal-paper .proposal-option{color:#475569;font-size:11px}.proposal-paper .proposal-summary{margin:20px 0 0 auto;max-width:360px}
      .proposal-paper .proposal-summary div{display:flex;justify-content:space-between;gap:20px;padding:5px 0}.proposal-paper .proposal-total{font-size:20px;border-top:2px solid var(--proposal-brand);margin-top:8px;padding-top:12px!important}
      .proposal-prose p{margin:0 0 12px}.proposal-prose ul{list-style:disc;padding-left:22px;margin:10px 0}.proposal-prose ol{list-style:decimal;padding-left:22px;margin:10px 0}
      .proposal-prose h1,.proposal-prose h2,.proposal-prose h3{margin:16px 0 8px}.proposal-prose img{max-width:100%;max-height:360px;object-fit:contain;margin:12px 0}.proposal-prose a{color:#1d4ed8;text-decoration:underline}
      .proposal-prose blockquote{border-left:3px solid #cbd5e1;padding-left:16px}.proposal-prose pre{white-space:pre-wrap}.proposal-prose table{margin:12px 0;table-layout:fixed}
      @media(max-width:600px){.proposal-paper{padding:20px 16px}.proposal-paper h1{font-size:24px}.proposal-paper th,.proposal-paper td{padding:8px 4px;font-size:11px}.proposal-paper .amount{white-space:normal}}
      @media print{.proposal-paper{border:0;box-shadow:none;padding:0}.proposal-paper h2,.proposal-paper h3{break-after:avoid}.proposal-paper tr,.proposal-summary{break-inside:avoid} }
    `}</style>
    <div className="proposal-brand">{documentUrl(brand?.logoUrl || undefined) && <img src={documentUrl(brand!.logoUrl!)} crossOrigin="anonymous" alt="" />}<strong>{brand?.companyName || 'Your company'}</strong><small style={{ marginLeft: 'auto' }}>{proposal.proposalNumber || 'Draft proposal'}</small></div>
    <h1>{proposal.title || 'Proposal title'}</h1>
    <div className="proposal-meta"><div><small>Prepared for</small><strong>{proposal.recipientName || 'Customer name'}</strong>{proposal.recipientEmail && <small>{proposal.recipientEmail}</small>}</div>{proposal.validUntil && <div><small>Valid until</small><strong>{date(proposal.validUntil)}</strong></div>}</div>
    {proposal.coverNote && <ProposalMarkdown>{proposal.coverNote}</ProposalMarkdown>}
    {sections.filter(section => section.body.trim()).map((section, index) => <section key={index}><h2>{section.title}</h2><ProposalMarkdown>{section.body}</ProposalMarkdown></section>)}
    <section><h2>Scope and investment</h2>
      {commercial?.packages?.length ? <p>Selected package: <strong>{commercial.packages.find(item => item.id === commercial.selectedPackageId)?.name || 'To be confirmed'}</strong></p> : null}
      <table className="proposal-pricing-table"><colgroup><col style={{ width: '49%' }}/><col style={{ width: '14%' }}/><col style={{ width: '18%' }}/><col style={{ width: '19%' }}/></colgroup><thead><tr><th scope="col">Item</th><th scope="col" className="amount">Quantity</th><th scope="col" className="amount">Unit price</th><th scope="col" className="amount">Amount</th></tr></thead><tbody>
        {pricing.rows.map((item, index) => <tr key={item.id || index}><td><strong>{item.name || 'Untitled item'}</strong>{item.description && <ProposalMarkdown>{item.description}</ProposalMarkdown>}<div className="proposal-option">{item.packageId && `${commercial?.packages?.find(option => option.id === item.packageId)?.name || item.packageId} · `}{item.isComplimentary ? 'Complimentary' : periodLabels[item.billingPeriod || 'one_time']}{item.isOptional && ` · Optional add-on${item.included ? ', included' : ', not included'}`}{!item.included && !item.isOptional && ' · Alternative, not included'}</div></td><td className="amount">{Number(item.quantity ?? 1)} {item.unit}</td><td className="amount">{amount(Number(item.unitPrice ?? 0))}</td><td className="amount">{amount(item.total)}{Number(item.discount || 0) > 0 && <div className="proposal-option">Includes {amount(Number(item.discount))} discount</div>}</td></tr>)}
      </tbody></table>
      <div className="proposal-summary"><div><span>Subtotal</span><span>{amount(pricing.subtotal)}</span></div><div><span>Discount{proposal.discountType === 'percentage' ? ` (${proposal.discountValue}%)` : ''}</span><span>-{amount(pricing.discount)}</span></div><div><span>Tax ({Number(proposal.taxRate || 0)}%)</span><span>{amount(pricing.tax)}</span></div><div className="proposal-total"><strong>{Object.keys(pricing.recurring).length ? 'Initial total' : 'Total'}</strong><strong>{amount(pricing.total)}</strong></div></div>
      {Object.entries(pricing.recurring).map(([period, value]) => <p key={period} className="proposal-option">Recurring: {amount(value)} {periodLabels[period as keyof typeof periodLabels]}, before proposal discount and tax. The initial total includes the first billing period.</p>)}
    </section>
    {!!pricing.milestones.length && <section><h2>Payment schedule</h2><table><thead><tr><th>Milestone</th><th>Due date</th><th className="amount">Share</th><th className="amount">Amount</th></tr></thead><tbody>{pricing.milestones.map(item => <tr key={item.id}><td>{item.title}</td><td>{item.dueDate ? date(item.dueDate) : 'As agreed in the terms'}</td><td className="amount">{item.percentage}%</td><td className="amount">{amount(item.amount)}</td></tr>)}</tbody></table></section>}
    {proposal.termsAndConditions && proposal.showTermsAndConditions !== false && <section><h2>{termsInSections ? 'Additional terms' : 'Terms and conditions'}</h2><ProposalMarkdown>{proposal.termsAndConditions}</ProposalMarkdown></section>}
    {proposal.signedByName && proposal.signedAt && <section><h2>Accepted</h2><p>{proposal.signedByName} · {date(proposal.signedAt)}</p></section>}
  </article>;
}

/** Render the same document element used in preview and public review. */
export async function downloadProposalPdf(element: HTMLElement, filename: string) {
  const { jsPDF } = await import('jspdf');
  await document.fonts.ready;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  await pdf.html(element, { x: 0, y: 0, width: 180, windowWidth: Math.max(element.scrollWidth, 600), margin: [12, 15, 12, 15], autoPaging: 'text', html2canvas: { useCORS: true, backgroundColor: '#ffffff', logging: false } });
  pdf.save(`${filename.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100) || 'proposal'}.pdf`);
}
