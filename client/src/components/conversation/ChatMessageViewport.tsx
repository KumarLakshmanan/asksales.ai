"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ChatMessageViewportProps {
  children: ReactNode;
  sessionKey: string | number | null;
  messages: readonly { role: string }[];
  busy?: boolean;
  className?: string;
}

const dimensions = (viewport: HTMLDivElement) =>
  `${viewport.clientWidth}:${viewport.clientHeight}:${viewport.scrollHeight}`;

/** A single scroll owner. Never scrollIntoView: it also scrolls clipped ancestors. */
export function ChatMessageViewport({
  children,
  sessionKey,
  messages,
  busy,
  className,
}: ChatMessageViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const previousSessionRef = useRef(sessionKey);
  const previousMessagesRef = useRef(messages);
  const dimensionsRef = useRef("");

  useLayoutEffect(() => {
    if (
      previousSessionRef.current !== sessionKey ||
      (previousMessagesRef.current !== messages &&
        messages.at(-1)?.role === "user")
    ) {
      followingRef.current = true;
    }
    previousSessionRef.current = sessionKey;
    previousMessagesRef.current = messages;
    const viewport = viewportRef.current;
    if (viewport) {
      if (followingRef.current)
        viewport.scrollTop = messages.length ? viewport.scrollHeight : 0;
      dimensionsRef.current = dimensions(viewport);
    }
  }, [sessionKey, messages, busy]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (followingRef.current)
          viewport.scrollTop = previousMessagesRef.current.length
            ? viewport.scrollHeight
            : 0;
        dimensionsRef.current = dimensions(viewport);
      });
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div
      ref={viewportRef}
      role="region"
      aria-label="Support messages"
      tabIndex={0}
      className={cn(
        "min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain p-4 lg:p-6",
        className,
      )}
      onScroll={() => {
        const viewport = viewportRef.current;
        // Browser scroll anchoring can fire a scroll event before ResizeObserver
        // when wrapping changes. That is layout movement, not a user opting out.
        if (viewport && dimensionsRef.current === dimensions(viewport)) {
          followingRef.current =
            viewport.scrollHeight -
              viewport.clientHeight -
              viewport.scrollTop <=
            64;
        }
      }}
    >
      <div ref={contentRef} className="min-h-full min-w-0">
        {children}
      </div>
    </div>
  );
}
