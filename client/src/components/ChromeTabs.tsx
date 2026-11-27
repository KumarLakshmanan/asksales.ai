import { PanelRightClose, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useRef,
  useEffect,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";

export interface Tab {
  id: string;
  type: string;
  label: string;
  closeable?: boolean;
}

interface ChromeTabsProps {
  tabs: Tab[];
  activeTab: string;
  highlightedTabId?: string | null;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onAddTab?: () => void;
  onMinimize?: () => void;
  minimizeButtonRef?: Ref<HTMLButtonElement>;
}

export default function ChromeTabs({
  tabs,
  activeTab,
  highlightedTabId,
  onTabClick,
  onTabClose,
  onAddTab,
  onMinimize,
  minimizeButtonRef,
}: ChromeTabsProps) {
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [animatingTabId, setAnimatingTabId] = useState<string | null>(null);

  // Scroll active tab into view when it changes
  useEffect(() => {
    if (activeTabRef.current) {
      activeTabRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [activeTab]);

  // Trigger highlight animation when highlightedTabId changes
  useEffect(() => {
    if (highlightedTabId) {
      setAnimatingTabId(highlightedTabId);
      const timer = setTimeout(() => setAnimatingTabId(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [highlightedTabId]);

  const tabDomId = (tabId: string) =>
    `conversation-tab-${tabId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  const panelDomId = (tabId: string) =>
    `conversation-panel-${tabId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  const focusAndActivateTab = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;

    onTabClick(tab.id);
    requestAnimationFrame(() => tabRefs.current.get(tab.id)?.focus());
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (tabs.length === 0) return;

    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        focusAndActivateTab((index + 1) % tabs.length);
        break;
      case "ArrowLeft":
        event.preventDefault();
        focusAndActivateTab((index - 1 + tabs.length) % tabs.length);
        break;
      case "Home":
        event.preventDefault();
        focusAndActivateTab(0);
        break;
      case "End":
        event.preventDefault();
        focusAndActivateTab(tabs.length - 1);
        break;
      case "Delete":
      case "Backspace": {
        const tab = tabs[index];
        if (tab?.closeable === false) break;
        event.preventDefault();
        onTabClose(tab.id);
        const nextTab = tabs[index + 1] ?? tabs[index - 1];
        if (nextTab) {
          requestAnimationFrame(() => tabRefs.current.get(nextTab.id)?.focus());
        }
        break;
      }
    }
  };

  return (
    <div className="flex min-w-0 shrink-0 items-stretch border-b border-border bg-muted">
      <div
        role="tablist"
        aria-label="Conversation result views"
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-hide"
      >
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            role="presentation"
            className={`
              relative m-1 flex min-w-[112px] max-w-[200px] shrink-0 items-center gap-1 rounded-md border px-1 py-0.5
              transition-colors duration-150
              ${activeTab === tab.id
                ? "border-border bg-background text-foreground shadow-sm"
                : "border-transparent bg-muted text-muted-foreground hover:border-border/60 hover:bg-accent"
              }
              ${animatingTabId === tab.id ? "animate-tab-highlight" : ""}
            `}
          >
            <button
              ref={(node) => {
                if (node) {
                  tabRefs.current.set(tab.id, node);
                  if (activeTab === tab.id) activeTabRef.current = node;
                } else {
                  tabRefs.current.delete(tab.id);
                }
              }}
              id={tabDomId(tab.id)}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={panelDomId(tab.id)}
              tabIndex={activeTab === tab.id || (!activeTab && index === 0) ? 0 : -1}
              onClick={() => onTabClick(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              title={tab.label}
              className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
            >
              {tab.label}
            </button>
            {tab.closeable !== false && (
              <button
                type="button"
                aria-label={`Close ${tab.label} tab`}
                title={`Close ${tab.label} tab`}
                onClick={(e) => {
                  e.stopPropagation();
                  onTabClose(tab.id);
                }}
                className="shrink-0 rounded-md p-1 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      {(onAddTab || onMinimize) && (
        <div className="flex shrink-0 items-center gap-0.5 border-l border-border bg-muted px-1">
          {onAddTab && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onAddTab}
              aria-label="Add result view"
              title="Add result view"
              className="h-8 min-h-8 w-8 shrink-0 rounded-md p-0 hover:bg-accent"
            >
              <Plus className="w-4 h-4" />
            </Button>
          )}
          {onMinimize && (
            <Button
              ref={minimizeButtonRef}
              variant="ghost"
              size="sm"
              onClick={onMinimize}
              aria-label="Minimize result panel"
              aria-controls="conversation-result-panel"
              aria-expanded="true"
              title="Minimize result panel"
              className="h-8 min-h-8 w-8 shrink-0 rounded-md p-0 hover:bg-accent"
            >
              <PanelRightClose className="w-4 h-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
