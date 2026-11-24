import { gettingStarted } from './getting-started';
import { assistants } from './assistants';
import { sales } from './sales';
import { service } from './service';
import { marketing } from './marketing';
import { workspace } from './workspace';
export type { DocumentationArticle, DocumentationSection } from './types';

export const documentationArticles = [...gettingStarted, ...assistants, ...sales, ...service, ...marketing, ...workspace];
export const documentationGroups = ['Start here', 'Sales', 'Customer service', 'Marketing', 'Workspace'] as const;

export function searchDocumentation(query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return documentationArticles.filter(article => {
    const text = [article.title, article.summary, ...article.prerequisites, ...article.sections.flatMap(section => [section.title, section.body])].join(' ').toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}
