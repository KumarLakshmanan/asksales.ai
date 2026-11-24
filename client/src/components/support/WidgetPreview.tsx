"use client";
import { useState } from "react";
import { Bot, Send, MessageCircle, X } from "lucide-react";
import {
  widgetColorForeground,
  type SupportWidgetSettings,
} from "@/lib/support-widget-settings";

/** Local demo: no credentials, API requests, leads or customer sessions. */
export function WidgetPreview({
  settings,
  teamName,
}: {
  settings: SupportWidgetSettings;
  teamName: string;
}) {
  const [open, setOpen] = useState(true);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const style = {
    backgroundColor: settings.primaryColor,
    color: widgetColorForeground(settings.primaryColor),
  };
  return (
    <section
      aria-label="Live widget preview"
      className="min-w-0 rounded-xl border bg-muted/30 p-4 sm:p-6"
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="font-semibold">Live preview</h2>
        <span className="text-xs text-muted-foreground">Local demo</span>
      </div>
      <p className="mb-5 text-sm text-muted-foreground">
        Try the greeting and button. Preview messages are kept here and do not
        create customer conversations.
      </p>
      <div className="relative flex min-h-[420px] flex-col justify-end rounded-lg border bg-background/60 p-3">
        {open && (
          <div className="mb-3 flex min-h-[310px] flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex items-center gap-2 border-b p-3">
              {settings.logoUrl ? (
                <img
                  src={settings.logoUrl}
                  alt=""
                  className="h-8 w-8 rounded object-contain"
                />
              ) : (
                <Bot
                  className="h-5 w-5"
                  style={{ color: settings.primaryColor }}
                />
              )}
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                {settings.displayName || teamName}
              </span>
              <button
                aria-label="Close preview chat"
                className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted"
                onClick={() => setOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 space-y-3 p-3 text-sm">
              <p className="break-words rounded-lg bg-muted p-3">
                {settings.greeting}
              </p>
              {messages.map((message, index) => (
                <div key={index} className="space-y-2">
                  <p
                    className="ml-6 break-words rounded-lg p-2.5"
                    style={style}
                  >
                    {message}
                  </p>
                  <p className="mr-6 rounded-lg bg-muted p-2.5">
                    Demo only. Live replies require enabled AI and a ready assistant assigned to this widget.
                  </p>
                </div>
              ))}
            </div>
            <form
              className="flex gap-2 border-t p-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (input.trim()) {
                  setMessages([input.trim()]);
                  setInput("");
                }
              }}
            >
              <input
                aria-label="Preview message"
                value={input}
                maxLength={200}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Try a message…"
                className="min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
              />
              <button
                type="submit"
                aria-label="Send preview message"
                disabled={!input.trim()}
                className="flex h-10 w-10 items-center justify-center rounded-md disabled:opacity-40"
                style={style}
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>
        )}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-label={open ? "Close preview widget" : "Open preview widget"}
          aria-expanded={open}
          style={style}
          className={`flex h-12 w-12 items-center justify-center rounded-full shadow-sm ${settings.launcherPosition === "right" ? "self-end" : "self-start"}`}
        >
          <MessageCircle className="h-6 w-6" />
        </button>
      </div>
    </section>
  );
}
