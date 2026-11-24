export interface DocumentationSection {
  id: string;
  title: string;
  body: string;
  diagram?: { id: string; title: string; description: string };
}

export interface DocumentationArticle {
  slug: string;
  title: string;
  group: 'Start here' | 'Sales' | 'Customer service' | 'Marketing' | 'Workspace';
  summary: string;
  prerequisites: string[];
  destinations: { label: string; href: string }[];
  sections: DocumentationSection[];
  /** Maintainer evidence only; never customer records or deployment details. */
  evidence: string[];
}
