import { useEffect, useState } from 'react';
import { api } from '../../api';
import { LATENCY_BUCKETS, type UsageInsights } from '../../types';
import { Empty, Eyebrow, Spinner } from '../../components/ui';
import { BarList, Histogram, Rate, StatTile } from '../../components/charts';
import { compact, exact, millis, plural, relativeTime } from '../../format';
import { summarizeQuery } from '../../describeQuery';

/**
 * Stats: whether Atlas is working, as opposed to how much it is called.
 *
 * The Overview tab answers volume, and volume is the number that looks fine
 * either way — a busy week of searches that all returned nothing charts exactly
 * like a busy week that answered everything. So this tab leads with the two rates
 * that can actually be bad (searches returning nothing, asks retrieving nothing
 * to cite) and puts the throughput figures underneath them.
 */
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function StatsTab({ days, nonce }: { days: number; nonce: number }) {
  const [data, setData] = useState<UsageInsights | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setData(null);
    api
      .usageInsights(days)
      .then((d) => live && (setData(d), setError('')))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [days, nonce]);

  if (error) return <Empty title="Cannot load insights." hint={error} />;
  if (!data) return <Spinner label="computing insights" />;

  const { ask, search } = data;
  const totalTokens = ask.promptTokens + ask.completionTokens;
  const nothing = ask.calls === 0 && search.calls === 0;

  if (nothing) {
    return (
      <Empty
        title="No searches or asks in this window."
        hint="Widen the range, or use Atlas from an agent or the UI and come back."
      />
    );
  }

  return (
    <div className="space-y-8">
      {/* The two rates worth leading with: both are invisible in a volume chart. */}
      <section>
        <Eyebrow>Did it work?</Eyebrow>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Rate
            label="Searches with no hits"
            value={search.zeroResult}
            of={search.calls}
            hint="retrieval found nothing at all"
            tone={search.zeroResult > 0 ? 'var(--color-report)' : 'var(--color-git)'}
          />
          <Rate
            label="Asks with no sources"
            value={ask.zeroSource}
            of={ask.calls}
            hint="answered with no evidence to cite"
            tone={ask.zeroSource > 0 ? 'var(--color-report)' : 'var(--color-git)'}
          />
          <Rate
            label="Asks abandoned"
            value={ask.aborted}
            of={ask.calls}
            hint="you gave up before the answer landed"
            tone={ask.aborted > 0 ? 'var(--color-kdb)' : 'var(--color-git)'}
          />
          <Rate
            label="Asks degraded or failed"
            value={ask.degraded + ask.failed}
            of={ask.calls}
            hint="LLM unreachable, or the stream broke"
            tone={ask.degraded + ask.failed > 0 ? 'var(--color-report)' : 'var(--color-git)'}
          />
        </div>
      </section>

      <section>
        <Eyebrow>Search</Eyebrow>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatTile label="Searches" value={compact(search.calls)} hint={`last ${data.days}d`} />
          <StatTile label="Median" value={millis(search.p50Ms)} hint="half are faster" />
          <StatTile label="p95" value={millis(search.p95Ms)} hint="the slow tail" />
          <StatTile
            label="Median hits"
            value={exact(search.medianResults)}
            hint="results per search"
          />
        </div>
      </section>

      <section>
        <Eyebrow>Ask</Eyebrow>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatTile label="Asks" value={compact(ask.calls)} hint={`last ${data.days}d`} />
          <StatTile label="Median" value={millis(ask.p50Ms)} hint="end to end" />
          <StatTile
            label="First token"
            value={millis(ask.avgTtftMs)}
            hint="average wait before prose"
          />
          <StatTile
            label="Tokens"
            value={compact(totalTokens)}
            hint={
              totalTokens > 0
                ? `${compact(ask.promptTokens)} in · ${compact(ask.completionTokens)} out`
                : 'none reported'
            }
          />
        </div>
      </section>

      <div className="grid md:grid-cols-2 gap-8">
        <section>
          <Eyebrow>Latency distribution</Eyebrow>
          {/* Reordered here: SQL groups by bucket and returns them arbitrarily,
              and a distribution with a shuffled x-axis is not a distribution. */}
          <Histogram
            buckets={LATENCY_BUCKETS.map((bucket) => ({
              bucket,
              calls: data.latency.find((l) => l.bucket === bucket)?.calls ?? 0,
            }))}
          />
        </section>

        <section>
          <Eyebrow>By weekday</Eyebrow>
          <BarList
            items={DOW.map((label, i) => ({
              key: label,
              calls: data.byDow.find((d) => d.dow === i + 1)?.calls ?? 0,
              color: 'var(--color-claude)',
            }))}
            emptyLabel="no calls in this window"
          />
        </section>
      </div>

      {data.models.length > 0 && (
        <section>
          <Eyebrow>Models that answered</Eyebrow>
          <BarList
            items={data.models.map((m) => ({
              key: m.model,
              calls: m.calls,
              color: 'var(--color-doc)',
              hint: `${exact(m.calls)} answers · ${exact(m.completionTokens)} completion tokens`,
            }))}
          />
          {/* A gateway can substitute the model it serves, so more than one name
              here is information, not a misconfiguration. */}
          {data.models.length > 1 && (
            <p className="mt-2 text-[11px] text-faint">
              More than one model served answers in this window — gateways substitute by routing
              policy, and this is the record of what actually ran.
            </p>
          )}
        </section>
      )}

      <section>
        <Eyebrow>Most repeated questions</Eyebrow>
        {data.topQueries.length === 0 ? (
          <p className="text-[12px] text-faint">nothing asked more than once</p>
        ) : (
          <div className="space-y-1">
            {data.topQueries.map((q) => (
              <div
                key={q.query}
                className="flex items-baseline gap-3 text-[12.5px] border-t border-line pt-1"
              >
                <span className="flex-1 min-w-0 truncate" title={q.query}>
                  {summarizeQuery(q.query) || <span className="text-faint">—</span>}
                </span>
                <span className="font-mono text-[10px] text-faint shrink-0">
                  {relativeTime(q.lastAt)}
                </span>
                <span className="font-mono text-[11px] shrink-0 w-8 text-right">
                  ×{q.calls}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-[11px] text-faint">
          A question asked repeatedly is either important or unanswered. Open it in Calls to see
          what came back each time.
        </p>
      </section>

      <p className="text-[11px] text-faint">
        Counts cover {plural(data.days, 'day')}. Search and ask only — navigation and polling are
        excluded here, since neither can succeed or fail in a way worth rating.
      </p>
    </div>
  );
}
