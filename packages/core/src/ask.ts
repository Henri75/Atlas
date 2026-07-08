import type { AppConfig } from './config.js';
import { chatComplete } from './llm.js';
import type { SearchService } from './search.js';
import type { Catalog } from './catalog.js';
import type { AskResult, AskSource, SearchFilters, SearchHit } from './types.js';

/**
 * Ask mode: retrieve → synthesize with citations. The LLM sees numbered
 * context blocks and must cite [n]; sources map back to entries.
 */

const SYSTEM_PROMPT =
  'You are KDBScope, an assistant that answers questions about what happened across ' +
  "the user's software projects, using ONLY the provided context blocks (kdb logs, " +
  'Claude Code sessions, git commits, docs). Cite sources inline as [n] after each ' +
  'claim. If the context is insufficient, say exactly what is missing. Be concrete: ' +
  'name components, dates, files and root causes. Answer in the language of the question.';

export function buildAskPrompt(question: string, hits: SearchHit[], bodies: Map<number, string>): string {
  const blocks = hits
    .map((h, i) => {
      const body = (bodies.get(h.entryId) ?? h.snippet).slice(0, 1500);
      const date = h.occurredAt ? ` (${h.occurredAt.slice(0, 10)})` : '';
      return `[${i + 1}] ${h.projectSlug} / ${h.sourceType}${h.component ? ` / ${h.component}` : ''}${date}\n${h.title}\n${body}`;
    })
    .join('\n\n---\n\n');
  return `Context blocks:\n\n${blocks}\n\nQuestion: ${question}`;
}

export class AskService {
  constructor(
    private searchService: SearchService,
    private catalog: Catalog,
    private llmConfig: AppConfig['llm'],
  ) {}

  async ask(question: string, filters: SearchFilters = {}, k = 12): Promise<AskResult> {
    const { hits } = await this.searchService.search(question, filters, k);
    const sources: AskSource[] = hits.map((h, i) => ({
      n: i + 1,
      entryId: h.entryId,
      title: h.title,
      projectSlug: h.projectSlug,
      sourceType: h.sourceType,
      sourcePath: h.sourcePath,
      occurredAt: h.occurredAt,
    }));

    if (!hits.length) {
      return {
        answer: 'No indexed content matched this question. Try a broader query or trigger a reindex.',
        sources: [],
        model: this.llmConfig.model,
        degraded: false,
      };
    }

    const rows = await this.catalog.getEntries(hits.map((h) => h.entryId));
    const bodies = new Map<number, string>(
      [...rows.entries()].map(([id, row]) => [id, String(row.body)]),
    );

    try {
      const answer = await chatComplete(this.llmConfig, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildAskPrompt(question, hits, bodies) },
      ]);
      return { answer, sources, model: this.llmConfig.model, degraded: false };
    } catch (e) {
      // LLM down: still useful — return the retrieved sources with an explanation.
      return {
        answer:
          `LLM unavailable (${(e as Error).message.slice(0, 200)}). ` +
          'Here are the most relevant indexed sources for your question instead.',
        sources,
        model: this.llmConfig.model,
        degraded: true,
      };
    }
  }
}
