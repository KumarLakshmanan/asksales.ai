'use client';
import { useState } from 'react';
import { ArrowLeft, Heart, MessageCircle, MoreHorizontal, Send } from 'lucide-react';
import {
  renderInstagramText,
  instagramFollowPrompt,
  type InstagramMessage,
  type InstagramProfileConfig,
  type InstagramProfileKind,
  type InstagramRuleDefinition,
} from '@/lib/instagram-automations';

function Message({ message, keyword = '' }: { message: InstagramMessage; keyword?: string }) {
  return (
    <div className="space-y-2">
      <div className="whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-zinc-800 p-3 text-xs leading-5">
        {message.format !== 'carousel' &&
          (renderInstagramText(message.text, {
            name: 'Alex',
            username: 'alex',
            keyword,
          }) || <span className="text-zinc-400">Your message appears here</span>)}
        {message.format === 'buttons' &&
          message.buttons.map((button, i) => (
            <div key={i} className="mt-3 border-t border-white/10 pt-2 text-center text-sky-400">
              {button.title || 'Link button'}
            </div>
          ))}
        {message.format === 'carousel' && (
          <div className="flex gap-3 overflow-x-auto">
            {message.cards.length ? (
              message.cards.map((card, i) => (
                <div
                  key={i}
                  className="w-48 shrink-0 overflow-hidden rounded-lg border border-white/10"
                >
                  {card.imageUrl.startsWith('https://') && (
                    <img src={card.imageUrl} alt="" className="h-24 w-full object-cover" />
                  )}
                  <div className="p-2">
                    <p className="font-semibold">{card.title || 'Card title'}</p>
                    <p className="text-zinc-400">{card.subtitle}</p>
                    {card.buttons.map((button, n) => (
                      <p key={n} className="mt-2 text-center text-sky-400">
                        {button.title || 'Link button'}
                      </p>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <span className="text-zinc-400">Your cards appear here</span>
            )}
          </div>
        )}
      </div>
      {message.format === 'quick_replies' && (
        <div className="flex flex-wrap gap-2">
          {message.quickReplies.map((reply, i) => (
            <span
              key={i}
              className="rounded-full border border-sky-400 px-2 py-1 text-[11px] text-sky-400"
            >
              {reply.title || 'Quick reply'}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
export function PhonePreview({
  username,
  rule,
  profile,
  kind,
  locale = 0,
  tab = 'dm',
  onTab,
}: {
  username: string;
  rule?: InstagramRuleDefinition;
  profile?: InstagramProfileConfig;
  kind?: InstagramProfileKind;
  locale?: number;
  tab?: 'post' | 'comments' | 'dm';
  onTab?: (tab: 'post' | 'comments' | 'dm') => void;
}) {
  const group = profile?.locales[locale];
  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(null);
  const selectedMenu = group?.items.find(item => item.id === selectedMenuId);
  return (
    <aside className="mx-auto w-full max-w-[310px] lg:sticky lg:top-6 lg:self-start">
      <p className="mb-3 text-center text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        Simulated Instagram preview
      </p>
      {rule && (
        <div className="mb-3 grid grid-cols-3 rounded-lg bg-muted p-1">
          {(['post', 'comments', 'dm'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onTab?.(value)}
              aria-pressed={tab === value}
              className={`rounded-md py-1.5 text-xs font-medium ${tab === value ? 'bg-card shadow-sm' : 'text-muted-foreground'}`}
            >
              {value === 'dm' ? 'DM' : value === 'post' ? 'Post' : 'Comments'}
            </button>
          ))}
        </div>
      )}
      <div className="overflow-hidden rounded-[38px] border-[7px] border-zinc-800 bg-black text-white shadow-xl">
        <div className="mx-auto mt-3 h-4 w-20 rounded-full bg-zinc-900" />
        <div className="flex items-center gap-2 border-b border-white/10 px-4 pb-4 pt-5">
          <ArrowLeft className="h-4 w-4" />
          <div className="grid h-7 w-7 place-items-center rounded-full border border-rose-500 text-xs font-semibold">
            {username.slice(0, 1).toUpperCase()}
          </div>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">
            {username.replace(/^@/, '')}
          </span>
          <MoreHorizontal className="h-4 w-4" />
        </div>
        <div className="min-h-[390px] space-y-4 p-4">
          {group && (
            <>
              <div className="py-5 text-center">
                <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full border-2 border-rose-500 text-lg">
                  {username.slice(0, 1).toUpperCase()}
                </div>
                <p className="text-sm font-semibold">{username}</p>
                <p className="mt-1 text-xs text-zinc-500">@{username.replace(/^@/, '')}</p>
              </div>
              <p className="text-center text-[11px] text-zinc-400">
                {kind === 'menu' ? 'More options' : 'Tap a question to start a conversation'}
              </p>
              {kind === 'icebreakers'
                ? group.questions.map((question) => (
                    <div
                      key={question.id}
                      className="rounded-2xl border border-sky-400/40 bg-sky-400/5 px-3 py-2 text-center text-xs text-sky-400"
                    >
                      {question.question || 'Your question'}
                    </div>
                  ))
                : group.items.map((item) => (
                    <button type="button" onClick={() => setSelectedMenuId(item.id)} aria-label={`Preview menu item ${item.title || 'Untitled'}`}
                      key={item.id}
                      className="w-full border-b border-white/10 py-3 text-center text-xs text-sky-400 hover:bg-white/5 focus-visible:outline focus-visible:outline-sky-400"
                    >
                      {item.title || 'Menu item'}
                    </button>
                  ))}
              {kind === 'menu' && selectedMenu && <div className="space-y-2 border-t border-white/10 pt-3"><p className="text-center text-[10px] text-zinc-400">{selectedMenu.type === 'link' ? 'Opens this link' : 'Response after tapping'}</p>{selectedMenu.type === 'link' ? <p className="break-all text-xs text-sky-400">{selectedMenu.url || 'Add a link in the editor'}</p> : <Message message={selectedMenu.response} />}</div>}
            </>
          )}
          {rule && tab === 'post' && (
            <>
              <div className="grid aspect-square place-items-center rounded-lg bg-zinc-900 text-center text-xs text-zinc-500">
                <div>
                  <MessageCircle className="mx-auto mb-3 h-8 w-8" />
                  {rule.trigger.scope === 'specific'
                    ? `${rule.trigger.mediaIds.length} selected post${rule.trigger.mediaIds.length === 1 ? '' : 's'}`
                    : rule.trigger.scope === 'reels'
                      ? 'Your reels'
                      : 'Your posts and reels'}
                </div>
              </div>
              <div className="flex gap-3">
                <Heart className="h-5 w-5" />
                <MessageCircle className="h-5 w-5" />
                <Send className="h-5 w-5" />
              </div>
              <p className="text-xs">
                <strong>alex</strong> {rule.trigger.keywords[0] || 'info'}
              </p>
            </>
          )}
          {rule && tab === 'comments' && (
            <>
              <p className="text-xs font-semibold">Comments</p>
              <p className="text-xs">
                <strong>alex</strong> {rule.trigger.keywords[0] || 'info'}
              </p>
              {rule.publicReplies.length > 0 ? (
                <p className="ml-5 border-l border-zinc-700 pl-3 text-xs leading-5">
                  <strong>{username}</strong>
                  <br />
                  {renderInstagramText(rule.publicReplies[0], {
                    username: 'alex',
                    name: 'Alex',
                    keyword: rule.trigger.keywords[0] || 'info',
                  })}
                </p>
              ) : (
                <p className="text-xs text-zinc-500">No public reply configured</p>
              )}
            </>
          )}
          {rule &&
            tab === 'dm' &&
            (rule.kind === 'comment_reply' ? (
              <p className="py-8 text-center text-xs text-zinc-500">
                This automation replies in the comments.
              </p>
            ) : (
              <>
                {rule.followGate.enabled && (
                  <>
                    <p className="rounded-2xl rounded-bl-sm bg-zinc-800 p-3 text-xs leading-5">
                      {renderInstagramText(instagramFollowPrompt(rule.followGate.prompt), { username: 'alex', name: 'Alex', keyword: rule.trigger.keywords[0] || '' })}
                    </p>
                    <p className="ml-auto w-fit rounded-2xl rounded-br-sm bg-sky-600 px-3 py-2 text-xs">
                      DONE
                    </p>
                    <p className="text-center text-[10px] text-zinc-500">
                      Content sent after follow verification
                    </p>
                  </>
                )}
                <Message message={rule.message} keyword={rule.trigger.keywords[0] || ''} />
              </>
            ))}
        </div>
        <div className="m-3 rounded-full border border-white/15 px-4 py-2.5 text-[11px] text-zinc-500">
          Message…
        </div>
        <div className="mx-auto mb-2 h-1 w-24 rounded-full bg-zinc-500" />
      </div>
      <p className="mt-3 text-center text-xs leading-5 text-muted-foreground">
        Preview only. No message is sent.
      </p>
    </aside>
  );
}
