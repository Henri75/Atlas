import { buildBacklogJudgePrompt, parseJudgeVerdict } from './backlog.js';
import type { JudgeVerdict } from './backlog.js';
import { chatComplete } from './llm.js';
import type { AppConfig } from './config.js';
import type { SearchService } from './search.js';
import type { SearchHit } from './types.js';

/**
 * Evidence gathering + optional LLM judgment for one backlog item. The two
 * halves are deliberately separable: MCP agents take the evidence and judge
 * themselves (they can read the code); the CLI asks Atlas to judge because a
 * human is on the other end.
 */
export class BacklogReviewService {
  constructor(
    private searchService: SearchService,
    private llmConfig: AppConfig['llm'],
    private g2pClientId?: string,
  ) {}

  /** Scoped hybrid search over everything except the backlog itself. */
  async evidence(projectSlug: string, itemText: string, k = 8): Promise<SearchHit[]> {
    const result = await this.searchService.search(
      itemText.slice(0, 300),
      {
        project: projectSlug,
        sourceTypes: ['kdb_changelog', 'kdb_component', 'kdb_session', 'git_commit', 'doc'],
      },
      k,
    );
    return result.hits;
  }

  /**
   * Judge one item from its evidence. Throws on LLM unavailability (including
   * EmptyCompletionError) — the caller returns the evidence with an explicit
   * error rather than a fabricated verdict (ask answer-trust ADR).
   */
  async judge(
    item: { line: number; text: string; date?: string },
    hits: SearchHit[],
  ): Promise<JudgeVerdict & { model: string }> {
    const prompt = buildBacklogJudgePrompt(item, hits);
    const raw = await chatComplete(this.llmConfig, [{ role: 'user', content: prompt }], {
      clientId: this.g2pClientId,
    });
    const verdict = parseJudgeVerdict(raw, new Set(hits.map((h) => h.entryId)));
    return { ...verdict, model: this.llmConfig.model };
  }
}
