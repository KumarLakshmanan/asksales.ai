/** A saved text template (blog, DM) as returned by the templates API. */
export interface SavedTextTemplate {
  id: number;
  userId?: number | null;
  name: string;
  type: string;
  content: string;
  description?: string;
  category?: string;
  tags?: string[];
  isPredefined?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A saved content asset as listed on the saved-template pages. */
export interface SavedContentAsset {
  id: number;
  type: string;
  title: string;
  content: string;
  channel: string;
  imageUrl?: string;
  imageUrls?: string[];
  status?: string;
  prompt?: string;
  createdAt: string;
}
