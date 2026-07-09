import type { AppConfig } from './config.js';
import { chatComplete, chatStream, type ChatMessage } from './llm.js';
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
  'name components, dates, files and root causes. Answer in the language of the question. ' +
  'In a follow-up, you may also rely on the earlier turns of this conversation; the ' +
  'context blocks below are freshly retrieved for the newest question, so its [n] ' +
  'citations refer to those blocks.';

/** One prior exchange, replayed so a follow-up keeps its context. */
export interface AskTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Older turns are dropped rather than blowing the model's context window. */
const MAX_HISTORY_TURNS = 12;

const NO_MATCH =
  'No indexed content matched this question. Try a broader query or trigger a reindex.';

export function buildAskPrompt(question: string, hits: SearchHit[], bodies: Map<number, string>): string {
  // A follow-up may retrieve nothing; say so plainly rather than handing the
  // model an empty "Context blocks:" header it might try to fill in.
  if (!hits.length) {
    return `No new context was retrieved for this question; rely on the conversation above.\n\nQuestion: ${question}`;
  }
  const blocks = hits
    .map((h, i) => {
      const body = (bodies.get(h.entryId) ?? h.snippet).slice(0, 1500);
      const date = h.occurredAt ? ` (${h.occurredAt.slice(0, 10)})` : '';
      return `[${i + 1}] ${h.projectSlug} / ${h.sourceType}${h.component ? ` / ${h.component}` : ''}${date}\n${h.title}\n${body}`;
    })
    .join('\n\n---\n\n');
  return `Context blocks:\n\n${blocks}\n\nQuestion: ${question}`;
}

/** Events emitted by the streaming Ask pipeline, in order. */
export type AskEvent =
  | { type: 'sources'; sources: AskSource[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; model: string; degraded: boolean }
  | { type: 'error'; message: string };

interface Prepared {
  sources: AskSource[];
  messages: ChatMessage[] | null;
}

export class AskService {
  constructor(
    private searchService: SearchService,
    private catalog: Catalog,
    private llmConfig: AppConfig['llm'],
  ) {}

  /** Shared retrieval: both ask() and askStream() build their prompt here. */
  private async prepare(
    question: string,
    filters: SearchFilters,
    k: number,
    history: AskTurn[] = [],
  ): Promise<Prepared> {
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

    // A follow-up like "why?" carries no search signal and retrieves nothing —
    // but the conversation above it holds the answer. Only a *first* question
    // with no hits is a genuine dead end.
    if (!hits.length && !history.length) return { sources: [], messages: null };

    const rows = await this.catalog.getEntries(hits.map((h) => h.entryId));
    const bodies = new Map<number, string>(
      [...rows.entries()].map(([id, row]) => [id, String(row.body)]),
    );
    // Prior turns come *before* the fresh context, so the model reads
    // "conversation so far" then "here is what I found for the newest
    // question" — the [n] citations always refer to the block below them.
    const recent = history.slice(-MAX_HISTORY_TURNS);
    return {
      sources,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...recent.map((t) => ({ role: t.role, content: t.content }) as ChatMessage),
        { role: 'user', content: buildAskPrompt(question, hits, bodies) },
      ],
    };
  }

  async ask(
    question: string,
    filters: SearchFilters = {},
    k = 12,
    history: AskTurn[] = [],
  ): Promise<AskResult> {
    const { sources, messages } = await this.prepare(question, filters, k, history);
    if (!messages) {
      return { answer: NO_MATCH, sources: [], model: this.llmConfig.model, degraded: false };
    }
    try {
      const answer = await chatComplete(this.llmConfig, messages);
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

  /**
   * Streaming variant. Sources are emitted first so the UI can render
   * citations before any prose arrives, then answer deltas, then `done`.
   */
  async *askStream(
    question: string,
    filters: SearchFilters = {},
    k = 12,
    history: AskTurn[] = [],
  ): AsyncGenerator<AskEvent, void, unknown> {
    let prepared: Prepared;
    try {
      prepared = await this.prepare(question, filters, k, history);
    } catch (e) {
      yield { type: 'error', message: (e as Error).message };
      return;
    }

    yield { type: 'sources', sources: prepared.sources };

    if (!prepared.messages) {
      yield { type: 'delta', text: NO_MATCH };
      yield { type: 'done', model: this.llmConfig.model, degraded: false };
      return;
    }

    try {
      for await (const delta of chatStream(this.llmConfig, prepared.messages)) {
        yield { type: 'delta', text: delta };
      }
      yield { type: 'done', model: this.llmConfig.model, degraded: false };
    } catch (e) {
      yield {
        type: 'delta',
        text:
          `\n\n_LLM unavailable (${(e as Error).message.slice(0, 200)}). ` +
          'The sources above are the most relevant indexed results._',
      };
      yield { type: 'done', model: this.llmConfig.model, degraded: true };
    }
  }
}
