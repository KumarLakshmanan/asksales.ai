"use client";
import { Button } from '@/components/ui/button';
import { ContentTabType, tabConfig, getTabIcon } from './types';
import styles from './content-tab-bar.module.css';

interface ContentTabBarProps {
  activeTab: ContentTabType;
  onTabChange: (tab: ContentTabType) => void;
  contentCounts: Record<string, number>;
  className?: string;
}

export default function ContentTabBar({ activeTab, onTabChange, contentCounts, className }: ContentTabBarProps) {
  return (
    <div role="group" aria-label="Content types" className={`${styles.tabs} ${className ?? ''}`}>
      {tabConfig.map((tab) => {
        const isActive = activeTab === tab.id;
        const count = contentCounts[tab.id];

        return (
          <Button
            key={tab.id}
            aria-pressed={isActive}
            variant="ghost"
            size="sm"
            className={styles.tab}
            onClick={() => onTabChange(tab.id)}
          >
            <span aria-hidden="true" className={`${styles.icon} ${tab.color} ${tab.darkColor}`}>{getTabIcon(tab)}</span>
            <span className={styles.label}>{tab.label}</span>
            {Number.isFinite(count) && count >= 0 && (
              <span className={styles.count} aria-label={`${count} items`}>
                {count.toLocaleString()}
              </span>
            )}
          </Button>
        );
      })}
    </div>
  );
}
