"use client";

import {useId} from 'react';
import {Button} from '@/components/ui/button';
import {Callout} from '@/components/ui/callout';
import {useWidgets} from './WidgetContext';

export function WidgetHistoryNotice() {
  const {loadError,isLoading,retryLoadWidgets}=useWidgets();
  const descriptionId=useId();
  if (!loadError) return null;
  return <Callout tone="danger" className="mx-4 mt-3 w-auto" actions={
    <Button variant="outline" size="sm" loading={isLoading} loadingText="Loading reviews…" aria-describedby={descriptionId} onClick={()=>void retryLoadWidgets()}>
      Retry reviews
    </Button>
  }>
    <p id={descriptionId}>{loadError}</p>
  </Callout>;
}
