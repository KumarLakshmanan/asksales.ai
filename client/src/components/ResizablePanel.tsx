import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type PointerEvent } from 'react';
import { ChevronRight, ChevronLeft } from 'lucide-react';

interface ResizablePanelProps {
  children: React.ReactNode;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  position: 'left' | 'right';
  onClose?: () => void;
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  className?: string;
  stackOnMobile?: boolean;
  resizable?: boolean;
  storageKey?: string;
}

export default function ResizablePanel({
  children,
  defaultWidth = 300,
  minWidth = 200,
  maxWidth = 600,
  position = 'left',
  onClose,
  isOpen = true,
  onOpenChange,
  className = '',
  stackOnMobile = false,
  resizable = true,
  storageKey,
}: ResizablePanelProps) {
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [isClosed, setIsClosed] = useState(!isOpen);
  const panelRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);

  const clampWidth = useCallback(
    (nextWidth: number) => Math.min(maxWidth, Math.max(minWidth, nextWidth)),
    [maxWidth, minWidth],
  );

  const persistWidth = useCallback((nextWidth: number) => {
    if (!storageKey || typeof window === 'undefined') return;
    window.localStorage.setItem(storageKey, String(Math.round(clampWidth(nextWidth))));
  }, [clampWidth, storageKey]);

  useEffect(() => {
    if (!storageKey) return;
    const rawStored = window.localStorage.getItem(storageKey);
    const stored = rawStored === null ? Number.NaN : Number(rawStored);
    setWidth(Number.isFinite(stored) ? clampWidth(stored) : clampWidth(defaultWidth));
  }, [clampWidth, defaultWidth, storageKey]);

  // Pointer events cover mouse, touch, and pen input.
  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setIsResizing(true);
  };

  // Handle pointer movement during resize.
  useEffect(() => {
    if (!isResizing) return;

    const handlePointerMove = (e: globalThis.PointerEvent) => {
      if (!panelRef.current) return;

      const panelRect = panelRef.current.getBoundingClientRect();
      let newWidth: number;

      if (position === 'left') {
        // For left panel, calculate width from left edge to mouse
        newWidth = e.clientX - panelRect.left;
      } else {
        // For right panel, calculate width from mouse to right edge
        newWidth = panelRect.right - e.clientX;
      }

      const closeThreshold = minWidth;
      
      if (newWidth < closeThreshold) {
        setIsClosed(true);
        onOpenChange?.(false);
      } else if (newWidth > maxWidth) {
        setWidth(maxWidth);
        if (isClosed) {
          setIsClosed(false);
          onOpenChange?.(true);
        }
      } else {
        setWidth(clampWidth(newWidth));
        if (isClosed && newWidth >= closeThreshold) {
          setIsClosed(false);
          onOpenChange?.(true);
        }
      }
    };

    const handlePointerUp = () => {
      setWidth((currentWidth) => {
        persistWidth(currentWidth);
        return currentWidth;
      });
      setIsResizing(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [clampWidth, isResizing, position, minWidth, maxWidth, isClosed, onOpenChange, persistWidth]);

  // Handle close/open toggle
  const handleToggle = () => {
    const nextClosed = !isClosed;
    setIsClosed(nextClosed);
    onOpenChange?.(!nextClosed);
    if (nextClosed) {
      onClose?.();
    }
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = position === 'left' ? 1 : -1;
    const step = event.shiftKey ? 50 : 10;
    let nextWidth: number | null = null;

    switch (event.key) {
      case 'ArrowLeft':
        nextWidth = width - (step * direction);
        break;
      case 'ArrowRight':
        nextWidth = width + (step * direction);
        break;
      case 'Home':
        nextWidth = minWidth;
        break;
      case 'End':
        nextWidth = maxWidth;
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        handleToggle();
        return;
      default:
        return;
    }

    event.preventDefault();
    if (isClosed) {
      setIsClosed(false);
      onOpenChange?.(true);
    }
    const clampedWidth = clampWidth(nextWidth);
    setWidth(clampedWidth);
    persistWidth(clampedWidth);
  };

  // Watch for external isOpen changes
  const prevIsOpenRef = useRef(isOpen);
  useEffect(() => {
    if (prevIsOpenRef.current !== isOpen) {
      prevIsOpenRef.current = isOpen;
       
      setIsClosed(!isOpen);
    }
  }, [isOpen]);

  useEffect(() => {
    setWidth((currentWidth) => {
      const nextWidth = clampWidth(currentWidth);
      return nextWidth;
    });
  }, [clampWidth]);

  const displayWidth = isClosed ? (resizable ? 20 : 0) : width;
  const toggleLabel = `${isClosed ? 'Open' : 'Close'} ${position} panel`;
  const ToggleIcon = position === 'left'
    ? (isClosed ? ChevronRight : ChevronLeft)
    : (isClosed ? ChevronLeft : ChevronRight);

  return (
    <div
      ref={panelRef}
      className={`group/panel relative min-w-0 max-w-full bg-card transition-all duration-200 ${className}`}
      style={{
        width: `${displayWidth}px`,
        overflow: 'hidden',
      }}
    >
      {/* Panel Content */}
      <div className="h-full min-w-0 max-w-full overflow-hidden" style={{ width: isClosed ? 0 : '100%' }}>
        {!isClosed && children}
      </div>

      {resizable && (
        <>
          {/* Resize Handle */}
          <div
            ref={handleRef}
            role="separator"
            aria-label={`Resize ${position} panel`}
            aria-orientation="vertical"
            aria-valuemin={minWidth}
            aria-valuemax={maxWidth}
            aria-valuenow={isClosed ? minWidth : Math.round(width)}
            aria-valuetext={isClosed ? 'Panel collapsed' : `${Math.round(width)} pixels`}
            tabIndex={0}
            onPointerDown={handlePointerDown}
            onKeyDown={handleResizeKeyDown}
            className={`absolute top-0 h-full touch-none bg-border hover:bg-primary/50 cursor-col-resize transition-colors flex items-center justify-center group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${stackOnMobile ? 'max-md:hidden' : ''} ${
              position === 'left' ? 'right-0' : 'left-0'
            } ${isResizing ? 'bg-primary/70' : ''}`}
            style={{ width: isClosed ? '20px' : '4px' }} // Wider handle when closed
          />

          <button
            type="button"
            onClick={handleToggle}
            className={`absolute top-1/2 z-10 -translate-y-1/2 rounded-full transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              position === 'left' ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2'
            } ${
              isClosed
                ? 'bg-primary p-2 text-primary-foreground shadow-lg'
                : 'bg-card p-1 text-primary opacity-40 shadow-sm hover:bg-accent hover:opacity-100 group-hover/panel:opacity-100'
            } ${stackOnMobile ? 'max-md:hidden' : ''}`}
            title={toggleLabel}
            aria-label={toggleLabel}
          >
            <ToggleIcon className={isClosed ? 'h-5 w-5' : 'h-4 w-4'} />
          </button>
        </>
      )}
    </div>
  );
}
