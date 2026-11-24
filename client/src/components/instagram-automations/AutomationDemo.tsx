'use client';

import { useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronLeft, Heart, Instagram, List, MessageCircle, MoreHorizontal, Send, UserCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type AutomationDemoKind = 'icebreakers' | 'menu' | 'comment_dm' | 'comment_reply' | 'follow';
const examples: Record<AutomationDemoKind, { title: string; steps: string[]; captions: string[] }> = {
  icebreakers: {
    title: 'Conversation starters', steps: ['Open DMs', 'Choose a question', 'Start a conversation'],
    captions: ['A new visitor opens your Instagram conversation.', 'Your suggested questions appear before their first message.', 'Tapping a question sends it to your inbox. Your connected assistant or team can answer.'],
  },
  menu: {
    title: 'Main menu', steps: ['Open a conversation', 'Open the menu', 'Choose an action'],
    captions: ['The menu stays available inside a DM conversation.', 'The visitor opens your saved menu options.', 'A saved-answer action replies in the chat. A website action opens your link instead.'],
  },
  comment_dm: {
    title: 'Comment to DM', steps: ['See your post', 'Comment GUIDE', 'Receive a private reply'],
    captions: ['Your post invites visitors to comment a keyword.', 'A matching GUIDE comment triggers your automation.', 'Instagram receives one private reply for the eligible comment. Further messages require the visitor to reply.'],
  },
  comment_reply: {
    title: 'Public comment reply', steps: ['See your post', 'Ask about HOURS', 'Read your public reply'],
    captions: ['Visitors can ask questions below your post or reel.', 'The visitor posts a comment containing your HOURS keyword.', 'Your answer appears beneath their comment, visible to everyone on the post.'],
  },
  follow: {
    title: 'Follow to unlock', steps: ['Comment GUIDE', 'Receive follow instructions', 'Follow and reply DONE', 'Unlock the guide'],
    captions: ['A keyword comment starts the sequence.', 'The initial private reply asks them to follow your account and reply DONE.', 'They follow you and reply DONE in the chat, allowing a follow check.', 'If Instagram verifies the follow, your promised content is sent. Otherwise the visitor receives your retry instructions.'],
  },
};

function Bubble({ children, visitor = false }: { children: ReactNode; visitor?: boolean }) {
  return <div className={cn('max-w-[90%] rounded-2xl px-3 py-2 text-xs leading-5', visitor ? 'self-end rounded-br-sm bg-primary text-primary-foreground' : 'self-start rounded-bl-sm border bg-background')}>{children}</div>;
}
function Avatar({ name }: { name: string }) {
  return <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-muted text-[10px] font-semibold">{name.slice(0, 2).toUpperCase()}</span>;
}

/** A local illustration only: no API calls, links, sends or account changes. */
export function AutomationDemo({ kind, username }: { kind: AutomationDemoKind; username: string }) {
  const [step, setStep] = useState(kind === 'icebreakers' || kind === 'menu' ? 1 : 0);
  const [question, setQuestion] = useState('What are your opening hours?');
  const [menuChoice, setMenuChoice] = useState('pricing');
  const example = examples[kind], handle = username.replace(/^@/, '') || 'your_business';
  const showPost = kind === 'comment_reply' || kind === 'comment_dm' && step < 2 || kind === 'follow' && step === 0;
  const advance = () => setStep(value => Math.min(value + 1, example.steps.length - 1));
  const demoButton = 'rounded-xl border border-primary/25 bg-background px-3 py-2 text-left text-xs text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return <section aria-label={`${example.title} example`} className="my-5 flex flex-1 flex-col rounded-xl border bg-muted/20 p-3">
    <div className="mb-3 flex items-center justify-between gap-2 text-[10px] font-medium text-muted-foreground">
      <span>Interactive example</span><span>{step + 1} of {example.steps.length}</span>
    </div>
    <div className="overflow-hidden rounded-xl border bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {showPost ? <Instagram aria-hidden="true" className="h-4 w-4" /> : <ChevronLeft aria-hidden="true" className="h-4 w-4" />}
        <Avatar name={handle} /><span className="min-w-0 flex-1 truncate text-xs font-semibold">{handle}</span>
        {showPost ? <MoreHorizontal aria-hidden="true" className="h-4 w-4" /> : <span className="text-[10px] text-muted-foreground">Direct</span>}
      </div>
      <div className="flex min-h-[240px] flex-col">
        {showPost ? <>
          <div className="flex h-24 flex-col items-center justify-center gap-1 border-b bg-gradient-to-br from-primary/10 via-primary/5 to-background px-4 text-center">
            <span className="text-[9px] uppercase tracking-widest text-muted-foreground">{kind === 'comment_reply' ? 'Visit our studio' : 'Your free guide'}</span>
            <span className="text-lg font-semibold tracking-tight">{kind === 'comment_reply' ? 'Make time for you.' : 'A little inspiration.'}</span>
            <span className="text-[10px] text-muted-foreground">{kind === 'comment_reply' ? 'Ask us about opening hours' : 'Comment GUIDE to get your copy'}</span>
          </div>
          <div className="flex gap-3 px-3 pt-2 text-muted-foreground"><Heart aria-hidden="true" className="h-4 w-4" /><MessageCircle aria-hidden="true" className="h-4 w-4" /><Send aria-hidden="true" className="h-4 w-4" /></div>
          <p className="px-3 py-2 text-[11px] leading-4"><strong>{handle}</strong> {kind === 'comment_reply' ? 'Come visit us this week.' : 'Want the guide? Leave GUIDE below.'}</p>
          {(step >= 1 || kind === 'follow') && <div className="flex items-start gap-2 px-3 py-2"><Avatar name="Alex" /><div className="text-xs"><strong>alex</strong><p>{kind === 'comment_reply' ? 'What are your HOURS?' : 'GUIDE'}</p>
            {kind === 'comment_reply' && step === 2 && <div className="mt-2 border-l-2 border-primary/30 pl-2"><strong>{handle}</strong><p className="mt-1 leading-5">We’re open Monday–Friday, 9 am–6 pm.</p><span className="text-[10px] text-muted-foreground">Public reply</span></div>}
          </div></div>}
          {step === 0 && kind !== 'follow' && <button type="button" className={cn(demoButton, 'mx-3 mb-3 mt-auto')} onClick={advance}>{kind === 'comment_reply' ? 'Try commenting HOURS' : 'Try commenting GUIDE'}</button>}
        </> : <div className="flex flex-1 flex-col gap-3 p-3">
          {kind === 'icebreakers' && <>
            {step < 2 ? <><div className="mt-2 text-center"><AvatarCenter name={handle} /><p className="mt-2 text-xs font-semibold">{handle}</p><p className="mt-1 text-[10px] text-muted-foreground">Start a conversation</p></div>
              {step === 1 ? <div className="mt-auto grid gap-2">{['What are your opening hours?', 'What services do you offer?', 'How can I book?'].map(value => <button type="button" key={value} className={demoButton} onClick={() => { setQuestion(value); setStep(2); }}>{value}</button>)}</div> : <p className="mt-auto text-center text-[11px] text-muted-foreground">Suggested questions appear for new conversations.</p>}
            </> : <><span className="text-center text-[10px] text-muted-foreground">Question selected</span><Bubble visitor>{question}</Bubble><div className="mt-auto flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-[11px] leading-5"><CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />The visitor’s question is now in your inbox, ready for your assistant or team.</div></>}
          </>}
          {kind === 'menu' && <>
            <Bubble visitor>Hi! I’d like to know more.</Bubble>
            {step === 0 && <button type="button" onClick={advance} className={cn(demoButton, 'mt-auto flex items-center gap-2')}><List aria-hidden="true" className="h-4 w-4" />Open DM menu</button>}
            {step === 1 && <div className="mt-auto overflow-hidden rounded-xl border"><p className="bg-muted/50 px-3 py-2 text-[10px] font-medium">Business menu</p>{[{ id: 'pricing', title: 'View pricing · saved answer' }, { id: 'website', title: 'Visit website · opens a link' }, { id: 'team', title: 'Talk to us · saved answer' }].map(item => <button type="button" key={item.id} onClick={() => { setMenuChoice(item.id); advance(); }} className="flex w-full items-center justify-between gap-2 border-t px-3 py-2 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">{item.title}<ArrowRight aria-hidden="true" className="h-3 w-3 shrink-0" /></button>)}</div>}
            {step === 2 && (menuChoice === 'website' ? <div className="mt-auto rounded-xl border p-4"><span className="text-[10px] text-muted-foreground">Website preview · example only</span><p className="mt-2 text-sm font-semibold">Welcome to {handle}</p><p className="mt-2 text-xs leading-5">Your configured website opens when the visitor selects this menu link.</p></div> : <><Bubble visitor>{menuChoice === 'team' ? 'Talk to us' : 'View pricing'}</Bubble><Bubble>{menuChoice === 'team' ? 'Tell us how we can help. Our team will follow up here.' : 'Here’s our pricing guide. Which service interests you?'}</Bubble><p className="mt-auto text-[10px] text-muted-foreground">Example: a saved-answer menu action</p></>)}
          </>}
          {kind === 'comment_dm' && <><p className="text-center text-[10px] text-muted-foreground">Private reply to your GUIDE comment</p><Bubble>Here’s the guide you asked for:<span className="mt-1 block break-all text-primary underline">your-business.example/guide</span></Bubble><p className="mt-auto text-[10px] leading-5 text-muted-foreground">The reply is private. It may appear in message requests.</p></>}
          {kind === 'follow' && <>
            <Bubble>Follow @{handle} to unlock the guide, then reply DONE here.</Bubble>
            {step >= 2 && <><div className="flex items-center gap-2 self-center rounded-full border bg-muted/30 px-3 py-1 text-[10px]"><UserCheck aria-hidden="true" className="h-3 w-3" />You followed @{handle}</div><Bubble visitor>DONE</Bubble></>}
            {step === 3 && <><div className="flex items-center gap-1 text-[10px] text-emerald-700 dark:text-emerald-400"><Check aria-hidden="true" className="h-3 w-3" />Follow verified</div><Bubble>Thanks for following! Here’s your guide.<span className="mt-1 block font-medium">Download your guide ↗</span></Bubble></>}
          </>}
        </div>}
        {!showPost && <div aria-hidden="true" className="m-2 flex items-center justify-between rounded-full border px-3 py-2 text-[10px] text-muted-foreground"><span>Message…</span><Send className="h-3 w-3" /></div>}
      </div>
    </div>
    <h3 className="mt-3 text-xs font-semibold">{example.steps[step]}</h3>
    <p aria-live="polite" className="mt-1 min-h-[4.5rem] text-xs leading-5 text-muted-foreground">{example.captions[step]}</p>
    <div className="mt-3 flex items-center justify-between gap-2">
      <Button size="sm" variant="ghost" disabled={step === 0} aria-label={`Previous step in ${example.title} example`} onClick={() => setStep(value => value - 1)}><ArrowLeft aria-hidden="true" className="h-3 w-3" />Back</Button>
      <Button size="sm" variant="outline" aria-label={step === example.steps.length - 1 ? `Replay ${example.title} example` : `Next step in ${example.title} example`} onClick={step === example.steps.length - 1 ? () => setStep(0) : advance}>{step === example.steps.length - 1 ? 'Replay' : 'Next step'}<ArrowRight aria-hidden="true" className="h-3 w-3" /></Button>
    </div>
  </section>;
}
function AvatarCenter({ name }: { name: string }) {
  return <span aria-hidden="true" className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{name.slice(0, 2).toUpperCase()}</span>;
}
