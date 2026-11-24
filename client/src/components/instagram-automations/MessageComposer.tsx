'use client';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { instagramTextBytes, type InstagramMessage, type InstagramMessageButton } from '@/lib/instagram-automations';
import { Field } from './Fields';

const formats = [
  { id: 'text', label: 'Simple text' },
  { id: 'quick_replies', label: 'Quick replies' },
  { id: 'buttons', label: 'Button card' },
  { id: 'carousel', label: 'Carousel' },
] as const;
function LinkButtons({
  value,
  onChange,
  prefix,
}: {
  value: InstagramMessageButton[];
  onChange: (value: InstagramMessageButton[]) => void;
  prefix: string;
}) {
  return (
    <div className="space-y-3">
      {value.map((button, i) => (
        <div key={i} className="flex items-end gap-2">
          <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
            <Field label={`${prefix} ${i + 1} label`}>
              <Input
                maxLength={20}
                value={button.title}
                onChange={(e) =>
                  onChange(value.map((b, n) => (n === i ? { ...b, title: e.target.value } : b)))
                }
              />
            </Field>
            <Field label={`${prefix} ${i + 1} link`}>
              <Input
                type="url"
                placeholder="https://"
                value={button.url}
                onChange={(e) =>
                  onChange(value.map((b, n) => (n === i ? { ...b, url: e.target.value } : b)))
                }
              />
            </Field>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Remove ${prefix.toLowerCase()} ${i + 1}`}
            onClick={() => onChange(value.filter((_, n) => n !== i))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={value.length >= 3}
        onClick={() => onChange([...value, { title: '', url: '' }])}
      >
        <Plus className="h-3.5 w-3.5" />
        Add link button
      </Button>
    </div>
  );
}
export function MessageComposer({
  value,
  onChange,
  richAllowed,
  tokens = ['username', 'name', 'keyword'],
  label = 'DM message',
  richReason = 'Rich messages become available after the person interacts with your follow prompt.',
  showErrors = false,
}: {
  value: InstagramMessage;
  onChange: (value: InstagramMessage) => void;
  richAllowed: boolean;
  tokens?: Array<'username' | 'name' | 'keyword'>;
  label?: string;
  richReason?: string;
  showErrors?: boolean;
}) {
  const update = (patch: Partial<InstagramMessage>) => onChange({ ...value, ...patch });
  const textLimit = value.format === 'buttons' ? 640 : 1000;
  const textSize = value.format === 'buttons' ? value.text.length : instagramTextBytes(value.text);
  const textError = textSize > textLimit ? `Shorten this message to ${textLimit.toLocaleString()} ${value.format === 'buttons' ? 'characters' : 'bytes'}.` : showErrors && !value.text.trim() ? 'Write the message this person will receive.' : undefined;
  return (
    <div className="space-y-4">
      <div
        role="group"
        aria-label={`${label} format`}
        className="grid grid-cols-2 gap-2 xl:grid-cols-4"
      >
        {formats.map((format) => (
          <Button
            type="button"
            key={format.id}
            variant={value.format === format.id ? 'default' : 'outline'}
            className="text-xs"
            disabled={format.id !== 'text' && !richAllowed}
            aria-pressed={value.format === format.id}
            onClick={() => update({ format: format.id,
              ...(format.id === 'buttons' && !value.buttons.length ? { buttons: [{ title: '', url: '' }] } : {}),
              ...(format.id === 'quick_replies' && !value.quickReplies.length ? { quickReplies: [{ title: '', payload: '' }] } : {}),
              ...(format.id === 'carousel' && !value.cards.length ? { cards: [{ title: '', subtitle: '', imageUrl: '', buttons: [] }] } : {}),
            })}
          >
            {format.label}
          </Button>
        ))}
      </div>
      {!richAllowed && <p className="text-xs leading-5 text-muted-foreground">{richReason}</p>}
      {value.format !== 'carousel' && (
        <div className="space-y-2">
          <Field label={label} error={textError} hint={value.format === 'buttons' ? 'Button cards allow up to 640 characters.' : 'Instagram allows 1,000 bytes. Some languages and symbols use more than one byte per character.'}>
            <Textarea
              rows={5}
              maxLength={textLimit}
              value={value.text}
              onChange={(e) => update({ text: e.target.value })}
              placeholder="e.g. Hi {{name}}, thanks for asking! Here are the details: https://your-website.com"
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1">
              {tokens.map((token) => (
                <Button
                  key={token}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => update({ text: (value.text + `{{${token}}}`).slice(0, textLimit) })}
                >{`+ ${token}`}</Button>
              ))}
            </div>
            <span className={`text-xs tabular-nums ${textSize > textLimit ? 'text-destructive' : 'text-muted-foreground'}`}>
              {textSize.toLocaleString()} / {textLimit.toLocaleString()} {value.format === 'buttons' ? 'characters' : 'bytes'}
            </span>
          </div>
        </div>
      )}
      {value.format === 'buttons' && (
        <LinkButtons
          value={value.buttons}
          onChange={(buttons) => update({ buttons })}
          prefix="Button"
        />
      )}
      {value.format === 'quick_replies' && (
        <div className="space-y-3">
          {value.quickReplies.map((reply, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
                <Field label={`Quick reply ${i + 1} label`}>
                  <Input
                    maxLength={20}
                    value={reply.title}
                    onChange={(e) =>
                      update({
                        quickReplies: value.quickReplies.map((r, n) =>
                          n === i ? { ...r, title: e.target.value, payload: !r.payload || r.payload === r.title ? e.target.value : r.payload } : r
                        ),
                      })
                    }
                  />
                </Field>
                <Field label={`Quick reply ${i + 1} payload`}>
                  <Input
                    maxLength={1000}
                    value={reply.payload}
                    onChange={(e) =>
                      update({
                        quickReplies: value.quickReplies.map((r, n) =>
                          n === i ? { ...r, payload: e.target.value } : r
                        ),
                      })
                    }
                  />
                </Field>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove quick reply ${i + 1}`}
                onClick={() =>
                  update({ quickReplies: value.quickReplies.filter((_, n) => n !== i) })
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={value.quickReplies.length >= 13}
            onClick={() =>
              update({ quickReplies: [...value.quickReplies, { title: '', payload: '' }] })
            }
          >
            Add quick reply
          </Button>
        </div>
      )}
      {value.format === 'carousel' && (
        <div className="space-y-4">
          <p className="text-xs leading-5 text-muted-foreground">Each card needs a title plus a subtitle, image, or link button. Add up to 10 cards.</p>
          {value.cards.map((card, i) => (
            <div key={i} className="space-y-3 rounded-lg border bg-muted/20 p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Card {i + 1}</h3>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove card ${i + 1}`}
                  onClick={() => update({ cards: value.cards.filter((_, n) => n !== i) })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {(['title', 'subtitle', 'imageUrl'] as const).map((key) => (
                <Field key={key} label={`Card ${i + 1} ${key === 'imageUrl' ? 'image link' : key}`} hint={key === 'title' ? 'Required. Up to 80 characters.' : key === 'subtitle' ? 'Optional if you add an image or button.' : 'Optional. Use a public HTTPS image link.'} error={showErrors && key === 'title' && !card.title.trim() ? 'Give this card a title.' : undefined}>
                  <Input
                    value={card[key]}
                    maxLength={key === 'imageUrl' ? undefined : 80}
                    placeholder={key === 'imageUrl' ? 'https://' : undefined}
                    onChange={(e) =>
                      update({
                        cards: value.cards.map((c, n) =>
                          n === i ? { ...c, [key]: e.target.value } : c
                        ),
                      })
                    }
                  />
                </Field>
              ))}
              <LinkButtons
                prefix={`Card ${i + 1} button`}
                value={card.buttons}
                onChange={(buttons) =>
                  update({ cards: value.cards.map((c, n) => (n === i ? { ...c, buttons } : c)) })
                }
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={value.cards.length >= 10}
            onClick={() =>
              update({
                cards: [...value.cards, { title: '', subtitle: '', imageUrl: '', buttons: [] }],
              })
            }
          >
            Add carousel card
          </Button>
        </div>
      )}
    </div>
  );
}
