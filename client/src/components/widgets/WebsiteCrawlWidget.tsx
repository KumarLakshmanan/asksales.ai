"use client";

/**
 * WebsiteCrawlWidget
 * Interactive widget for website crawling/extraction.
 */

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WidgetProps } from "./types";

const AUTO_DETECT_VALUE = "__auto_detect__";

export function WebsiteCrawlWidget({ widget, onFormChange }: WidgetProps) {
  const [form, setForm] = useState({
    url: (widget.formValues.url as string) || '',
    extract_focus: (widget.formValues.extract_focus as string) || '',
  });

  useEffect(() => {
    onFormChange(form);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  const updateField = (field: string, value: unknown) => {
    setForm(f => ({ ...f, [field]: value }));
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Website URL *</Label>
        <Input
          value={form.url}
          onChange={(e) => updateField('url', e.target.value)}
          placeholder="https://example.com"
          className="h-9 text-xs"
          type="url"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs font-medium">Extract Focus</Label>
        <Select
          value={form.extract_focus || AUTO_DETECT_VALUE}
          onValueChange={(value) => updateField('extract_focus', value === AUTO_DETECT_VALUE ? '' : value)}
        >
          <SelectTrigger className="h-9 text-xs">
            <SelectValue placeholder="Auto-detect" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_DETECT_VALUE}>Auto-detect (all pages)</SelectItem>
            <SelectItem value="products_and_services">Products & Services</SelectItem>
            <SelectItem value="target_audience">Target Audience</SelectItem>
            <SelectItem value="company_overview">Company Overview</SelectItem>
            <SelectItem value="contact_information">Contact Information</SelectItem>
            <SelectItem value="case_studies">Case Studies</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
