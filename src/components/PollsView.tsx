import { useMemo, useState } from 'react';
import { Download, RotateCcw, Search, Send } from 'lucide-react';
import type { Campaign, CampaignPoll } from '../types';
import {
  downloadTextFile,
  formatClockTime,
  formatDisplayPhone,
} from '../utils/whatsapp';
import { PollBuilderSection } from './PollBuilderSection';

interface PollsViewProps {
  campaign: Campaign;
  isDispatching: boolean;
  onUpdatePoll: (next: CampaignPoll) => void;
  onResetVotes: () => Promise<void>;
  onStartBatchDispatch: () => void;
  onNotify: (msg: string) => void;
}

export function PollsView({
  campaign,
  isDispatching,
  onUpdatePoll,
  onResetVotes,
  onStartBatchDispatch,
  onNotify,
}: PollsViewProps) {
  const [search, setSearch] = useState('');
  const [optionFilter, setOptionFilter] = useState('all');
  const [confirmReset, setConfirmReset] = useState(false);

  const poll = campaign.poll;
  const queuedCount = campaign.recipients.filter((r) => r.status === 'queued').length;
  const sentTotal = campaign.recipients.filter((r) =>
    ['sent', 'delivered', 'read', 'opened', 'dispatched'].includes(r.status)
  ).length;

  const activeVotes = useMemo(() => {
    return Object.values(poll.votes || {})
      .filter((v) => v.selectedOptions.length > 0)
      .sort(
        (a, b) =>
          new Date(b.votedAt).getTime() - new Date(a.votedAt).getTime()
      );
  }, [poll.votes]);

  // Aggregate counts per option (preserving configured options + any historical option labels)
  const optionBreakdown = useMemo(() => {
    const cleanOptions = poll.options.map((o) => o.trim()).filter(Boolean);
    const counts = new Map<string, number>();
    for (const opt of cleanOptions) {
      counts.set(opt, 0);
    }
    let totalSelections = 0;
    for (const vote of activeVotes) {
      for (const chosen of vote.selectedOptions) {
        counts.set(chosen, (counts.get(chosen) || 0) + 1);
        totalSelections += 1;
      }
    }

    const items = Array.from(counts.entries()).map(([label, count]) => ({
      label,
      count,
      voterPct:
        activeVotes.length > 0
          ? Math.round((count / activeVotes.length) * 100)
          : 0,
    }));

    const maxCount = Math.max(0, ...items.map((i) => i.count));
    return { items, maxCount, totalSelections };
  }, [poll.options, activeVotes]);

  const leadingOption = useMemo(() => {
    if (optionBreakdown.maxCount === 0) return null;
    return optionBreakdown.items.find(
      (i) => i.count === optionBreakdown.maxCount
    );
  }, [optionBreakdown]);

  const filteredVotes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activeVotes.filter((v) => {
      if (optionFilter !== 'all' && !v.selectedOptions.includes(optionFilter)) {
        return false;
      }
      if (!q) return true;
      return (
        v.phone.includes(q) ||
        v.name.toLowerCase().includes(q) ||
        v.selectedOptions.some((o) => o.toLowerCase().includes(q))
      );
    });
  }, [activeVotes, optionFilter, search]);

  function exportPollResultsCsv() {
    const escape = (val: string) =>
      /[",\n\r]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val;
    const lines = ['Phone,Name,Selected Options,Voted At'];
    for (const v of activeVotes) {
      lines.push(
        [
          v.phone,
          v.name,
          v.selectedOptions.join(' | '),
          v.votedAt,
        ]
          .map(escape)
          .join(',')
      );
    }
    const slug = (poll.question || campaign.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    downloadTextFile(`${slug || 'poll'}-results.csv`, lines.join('\r\n'));
    onNotify('Exported poll results CSV');
  }

  const responseRate =
    sentTotal > 0 ? Math.round((activeVotes.length / sentTotal) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* 4-Column Horizontal Poll KPI Strip */}
      <section
        aria-label="Poll metrics"
        className="bg-white border border-slate-200 rounded-lg grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 divide-x divide-slate-200"
      >
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Total Voters</div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="font-display text-2xl font-bold tabular-nums text-slate-900">
              {activeVotes.length.toLocaleString()}
            </span>
            <span className="text-xs text-slate-500 tabular-nums">
              {responseRate}% of sent
            </span>
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Total Selections</div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="font-display text-2xl font-bold tabular-nums text-emerald-700">
              {optionBreakdown.totalSelections.toLocaleString()}
            </span>
            <span className="text-xs text-slate-500">
              {poll.selectableCount === 1 ? 'Single choice' : 'Multi-select'}
            </span>
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Leading Option</div>
          <div className="mt-1.5 min-w-0">
            <div className="font-display text-lg font-bold text-slate-900 truncate">
              {leadingOption ? leadingOption.label : '—'}
            </div>
            <div className="text-xs text-slate-500 tabular-nums">
              {leadingOption
                ? `${leadingOption.count} votes (${leadingOption.voterPct}%)`
                : 'Awaiting votes'}
            </div>
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Broadcast Status</div>
          <div className="mt-1.5">
            <div
              className={`font-display text-base font-bold ${
                poll.enabled ? 'text-emerald-700' : 'text-slate-500'
              }`}
            >
              {poll.enabled ? 'Enabled for Send' : 'Not Checked'}
            </div>
            <div className="text-xs text-slate-500 tabular-nums">
              {queuedCount.toLocaleString()} recipients queued
            </div>
          </div>
        </div>
      </section>

      {/* 2-Column Split: Poll Builder (Left 6) | Live Results Breakdown (Right 6) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Poll Builder */}
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
          <PollBuilderSection poll={poll} onChangePoll={onUpdatePoll} />

          <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-slate-500">
              {poll.enabled
                ? 'Checked — will be sent to all queued numbers.'
                : 'Check "Send this poll to all users" above to include it in your broadcast.'}
            </span>
            <button
              type="button"
              disabled={!poll.enabled || queuedCount === 0 || isDispatching}
              onClick={onStartBatchDispatch}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
            >
              <Send className="h-3.5 w-3.5" />
              {isDispatching
                ? 'Sending...'
                : `Send to All Queued (${queuedCount.toLocaleString()})`}
            </button>
          </div>
        </section>

        {/* Right: Live Poll Results Chart */}
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-lg">
          <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Live Poll Results
              </h2>
              <p className="text-xs text-slate-500 mt-0.5 truncate max-w-sm">
                {poll.question.trim() || 'Add a poll question to preview results'}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {activeVotes.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={exportPollResultsCsv}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export CSV
                  </button>
                  {confirmReset ? (
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={async () => {
                          await onResetVotes();
                          setConfirmReset(false);
                        }}
                        className="px-2.5 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-md whitespace-nowrap"
                      >
                        Confirm Reset
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmReset(false)}
                        className="px-2 py-1.5 text-xs text-slate-600 hover:text-slate-900"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmReset(true)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-red-700 hover:bg-red-50 border border-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Reset
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="p-6 space-y-4">
            {optionBreakdown.items.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">
                Add at least two poll options on the left to track results here.
              </p>
            ) : (
              <div className="space-y-4">
                {optionBreakdown.items.map((item) => {
                  const isLeader =
                    optionBreakdown.maxCount > 0 &&
                    item.count === optionBreakdown.maxCount;
                  return (
                    <div key={item.label} className="space-y-1.5">
                      <div className="flex items-baseline justify-between gap-4 text-sm">
                        <span
                          className={`truncate ${
                            isLeader
                              ? 'font-semibold text-slate-900'
                              : 'font-medium text-slate-700'
                          }`}
                        >
                          {item.label}
                        </span>
                        <span className="font-mono text-xs tabular-nums text-slate-600 shrink-0">
                          <strong
                            className={
                              isLeader ? 'text-emerald-700' : 'text-slate-900'
                            }
                          >
                            {item.count.toLocaleString()}
                          </strong>{' '}
                          · {item.voterPct}%
                        </span>
                      </div>
                      <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className={`h-full transition-all duration-200 ${
                            isLeader ? 'bg-emerald-600' : 'bg-slate-400'
                          }`}
                          style={{ width: `${item.voterPct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {activeVotes.length === 0 && (
              <div className="pt-4 border-t border-slate-200 text-xs text-slate-500">
                Votes appear here in real time the instant recipients tap an option on WhatsApp.
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Individual Voter Responses Ledger */}
      <section className="bg-white border border-slate-200 rounded-lg">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Recipient Votes ({activeVotes.length.toLocaleString()})
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Every decrypted WhatsApp poll vote logged per recipient with timestamp.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              aria-label="Filter by option"
              value={optionFilter}
              onChange={(e) => setOptionFilter(e.target.value)}
              className="h-9 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-700 focus:border-emerald-600 focus:outline-none max-w-[200px]"
            >
              <option value="all">All options</option>
              {optionBreakdown.items.map((opt) => (
                <option key={opt.label} value={opt.label}>
                  {opt.label} ({opt.count})
                </option>
              ))}
            </select>

            <div className="relative">
              <Search className="h-4 w-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search voter or option..."
                className="h-9 w-52 rounded-md border border-slate-200 bg-slate-50 pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-emerald-600 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {filteredVotes.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <div className="text-sm font-medium text-slate-900">
              {activeVotes.length === 0
                ? 'No poll votes recorded yet'
                : 'No votes match your filter'}
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {activeVotes.length === 0
                ? 'Check "Send this poll to all users", dispatch your campaign, and votes will stream in live.'
                : 'Try clearing the search query or selecting All options.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                  <th className="py-2.5 px-6 font-medium">Recipient</th>
                  <th className="py-2.5 px-4 font-medium">Phone</th>
                  <th className="py-2.5 px-4 font-medium">Selected Option(s)</th>
                  <th className="py-2.5 px-6 font-medium text-right">Voted At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filteredVotes.map((v) => (
                  <tr
                    key={v.recipientId}
                    className="h-11 hover:bg-slate-50/80 transition-colors"
                  >
                    <td className="py-2 px-6 font-medium text-slate-900 whitespace-nowrap">
                      {v.name.trim() || formatDisplayPhone(v.phone)}
                    </td>
                    <td className="py-2 px-4 font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap">
                      {formatDisplayPhone(v.phone)}
                    </td>
                    <td className="py-2 px-4 text-xs font-medium text-emerald-800">
                      {v.selectedOptions.join(' · ')}
                    </td>
                    <td className="py-2 px-6 text-right font-mono text-xs text-slate-500 tabular-nums whitespace-nowrap">
                      {formatClockTime(v.votedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
