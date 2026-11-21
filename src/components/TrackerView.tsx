import { useMemo, useState } from 'react';
import {
  BarChart3,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Download,
  Eye,
  Loader2,
  RotateCcw,
  Search,
  Send,
  SkipForward,
  XCircle,
} from 'lucide-react';
import type {
  Campaign,
  DeliveryStatus,
  MonthlyAccountUsage,
  Recipient,
} from '../types';
import {
  buildWaMeUrl,
  downloadTextFile,
  formatClockTime,
  formatDisplayPhone,
  generateDeliveryReportCsv,
  renderPersonalizedMessage,
} from '../utils/whatsapp';
import { MonthlyLimitNotice } from './MonthlyLimitNotice';

interface TrackerViewProps {
  campaign: Campaign;
  origin: string;
  usage: MonthlyAccountUsage | null;
  recentPulseIds: Record<string, number>;
  onSendDirectSingle: (recipientId: string) => void;
  onBulkStatus: (payload: {
    fromStatuses?: DeliveryStatus[];
    toStatus: DeliveryStatus;
  }) => Promise<void>;
  onStartBatchDispatch: () => void;
  onNavigateToPolls: () => void;
  onNotify: (msg: string) => void;
}

type StatusFilter = 'all' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

const PAGE_SIZE = 50;

function renderStatusCell(r: Recipient) {
  switch (r.status) {
    case 'sending':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 whitespace-nowrap">
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
          Sending...
        </span>
      );
    case 'read':
    case 'opened':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-700 whitespace-nowrap">
          <CheckCheck className="h-3.5 w-3.5 shrink-0 text-sky-600" />
          Read
        </span>
      );
    case 'delivered':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 whitespace-nowrap">
          <CheckCheck className="h-3.5 w-3.5 shrink-0" />
          Delivered
        </span>
      );
    case 'sent':
    case 'dispatched':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 whitespace-nowrap">
          <Check className="h-3.5 w-3.5 shrink-0" />
          Sent
        </span>
      );
    case 'failed':
      return (
        <span
          title={r.failedReason || 'Delivery failed'}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 whitespace-nowrap"
        >
          <XCircle className="h-3.5 w-3.5 shrink-0" />
          Failed
        </span>
      );
    case 'skipped':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 whitespace-nowrap">
          <SkipForward className="h-3.5 w-3.5 shrink-0" />
          Skipped
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 whitespace-nowrap">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          Queued
        </span>
      );
  }
}

export function TrackerView({
  campaign,
  origin,
  usage,
  recentPulseIds,
  onSendDirectSingle,
  onBulkStatus,
  onStartBatchDispatch,
  onNavigateToPolls,
  onNotify,
}: TrackerViewProps) {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const activePollVotes = useMemo(() => {
    return Object.values(campaign.poll?.votes || {}).filter(
      (v) => v.selectedOptions.length > 0
    );
  }, [campaign.poll?.votes]);

  const pollBreakdown = useMemo(() => {
    const cleanOptions = (campaign.poll?.options || [])
      .map((o) => o.trim())
      .filter(Boolean);
    const map = new Map<string, number>();
    for (const opt of cleanOptions) {
      map.set(opt, 0);
    }
    for (const vote of activePollVotes) {
      for (const chosen of vote.selectedOptions) {
        map.set(chosen, (map.get(chosen) || 0) + 1);
      }
    }
    const items = Array.from(map.entries()).map(([label, count]) => ({
      label,
      count,
      voterPct:
        activePollVotes.length > 0
          ? Math.round((count / activePollVotes.length) * 100)
          : 0,
    }));
    const maxCount = Math.max(0, ...items.map((i) => i.count));
    return { items, maxCount };
  }, [campaign.poll?.options, activePollVotes]);

  const showPollResults =
    Boolean(campaign.poll?.enabled) ||
    activePollVotes.length > 0 ||
    Boolean(campaign.poll?.question?.trim());

  const counts = useMemo(() => {
    const summary = {
      queued: 0,
      sending: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
    };
    for (const r of campaign.recipients) {
      if (r.status === 'queued') summary.queued++;
      else if (r.status === 'sending') summary.sending++;
      else if (r.status === 'sent' || r.status === 'dispatched') summary.sent++;
      else if (r.status === 'delivered') summary.delivered++;
      else if (r.status === 'read' || r.status === 'opened') summary.read++;
      else if (r.status === 'failed' || r.status === 'skipped') summary.failed++;
    }
    return summary;
  }, [campaign.recipients]);

  const total = campaign.recipients.length;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return campaign.recipients.filter((r) => {
      if (filter === 'queued' && r.status !== 'queued') return false;
      if (
        filter === 'sent' &&
        !['sent', 'dispatched', 'sending'].includes(r.status)
      )
        return false;
      if (filter === 'delivered' && r.status !== 'delivered') return false;
      if (filter === 'read' && !['read', 'opened'].includes(r.status))
        return false;
      if (filter === 'failed' && !['failed', 'skipped'].includes(r.status))
        return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        r.phone.includes(q) ||
        (r.failedReason || '').toLowerCase().includes(q)
      );
    });
  }, [campaign.recipients, filter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE
  );

  function handleExportCsv() {
    const csv = generateDeliveryReportCsv(campaign, origin);
    const slug = campaign.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    downloadTextFile(`${slug || 'campaign'}-delivery-report.csv`, csv);
    onNotify('Exported delivery tracking report CSV');
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      onNotify('Copied wa.me link');
    } catch {
      onNotify('Clipboard access blocked');
    }
  }

  const filterTabs: Array<{ id: StatusFilter; label: string; count: number }> = [
    { id: 'all', label: 'All', count: total },
    { id: 'queued', label: 'Queued', count: counts.queued },
    { id: 'sent', label: 'Sent', count: counts.sent + counts.sending },
    { id: 'delivered', label: 'Delivered', count: counts.delivered },
    { id: 'read', label: 'Read', count: counts.read },
    { id: 'failed', label: 'Failed', count: counts.failed },
  ];

  return (
    <div className="space-y-6">
      {/* Real-Time Delivery Funnel Overview */}
      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Real-Time Delivery Tracker
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Live WhatsApp server, device delivery, and read receipts update automatically for every number.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {counts.failed > 0 && (
              <button
                type="button"
                onClick={() =>
                  void onBulkStatus({
                    fromStatuses: ['failed', 'skipped'],
                    toStatus: 'queued',
                  })
                }
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Re-Queue Failed ({counts.failed})
              </button>
            )}
            <button
              type="button"
              disabled={total === 0}
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
          </div>
        </div>

        {/* Stacked Progress Bar */}
        <div className="space-y-2.5">
          <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden flex">
            {counts.read > 0 && (
              <div
                style={{ width: `${pct(counts.read)}%` }}
                className="bg-sky-600 h-full transition-all duration-200"
                title={`Read: ${counts.read}`}
              />
            )}
            {counts.delivered > 0 && (
              <div
                style={{ width: `${pct(counts.delivered)}%` }}
                className="bg-emerald-600 h-full transition-all duration-200"
                title={`Delivered: ${counts.delivered}`}
              />
            )}
            {counts.sent + counts.sending > 0 && (
              <div
                style={{ width: `${pct(counts.sent + counts.sending)}%` }}
                className="bg-blue-500 h-full transition-all duration-200"
                title={`Sent: ${counts.sent + counts.sending}`}
              />
            )}
            {counts.failed > 0 && (
              <div
                style={{ width: `${pct(counts.failed)}%` }}
                className="bg-red-500 h-full transition-all duration-200"
                title={`Failed: ${counts.failed}`}
              />
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-600 tabular-nums">
            <span>
              <strong className="font-semibold text-sky-700">{counts.read}</strong> Read
            </span>
            <span>
              <strong className="font-semibold text-emerald-700">
                {counts.delivered}
              </strong>{' '}
              Delivered
            </span>
            <span>
              <strong className="font-semibold text-blue-700">
                {counts.sent + counts.sending}
              </strong>{' '}
              Sent
            </span>
            <span>
              <strong className="font-semibold text-slate-900">
                {counts.queued}
              </strong>{' '}
              Queued
            </span>
            <span>
              <strong className="font-semibold text-red-700">
                {counts.failed}
              </strong>{' '}
              Failed
            </span>
          </div>
        </div>
      </section>

      {/* Monthly WhatsApp Account Limit Notice */}
      <MonthlyLimitNotice usage={usage} compact />

      {/* Live Poll Results Panel */}
      {showPollResults && (
        <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-emerald-700 shrink-0" />
                <h2 className="text-sm font-semibold text-slate-900">
                  Live Poll Results
                </h2>
                <span className="font-mono text-xs text-slate-500 tabular-nums">
                  · {activePollVotes.length.toLocaleString()}{' '}
                  {activePollVotes.length === 1 ? 'voter' : 'voters'}
                </span>
              </div>
              <p className="text-xs text-slate-600 mt-1 truncate">
                {campaign.poll.question.trim() || 'Campaign Poll'}
              </p>
            </div>
            <button
              type="button"
              onClick={onNavigateToPolls}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              Manage Poll &amp; Export
            </button>
          </div>

          {pollBreakdown.items.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
              {pollBreakdown.items.map((item) => {
                const isLeader =
                  pollBreakdown.maxCount > 0 &&
                  item.count === pollBreakdown.maxCount;
                return (
                  <div key={item.label} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span
                        className={`truncate ${
                          isLeader
                            ? 'font-semibold text-slate-900'
                            : 'font-medium text-slate-700'
                        }`}
                      >
                        {item.label}
                      </span>
                      <span className="font-mono tabular-nums text-slate-600 shrink-0">
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
                    <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
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
          ) : (
            <p className="text-xs text-slate-500">
              Add poll options in the Polls &amp; Results tab to see live breakdowns here.
            </p>
          )}

          {activePollVotes.length === 0 && (
            <div className="text-xs text-slate-500 pt-2 border-t border-slate-100">
              Waiting for recipients to tap an option on WhatsApp — votes decrypt and appear here live.
            </div>
          )}
        </section>
      )}

      {/* Filter Toolbar & High-Density Recipient Status Table */}
      <section className="bg-white border border-slate-200 rounded-lg">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-md w-fit">
            {filterTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setFilter(tab.id);
                  setPage(1);
                }}
                className={`px-2.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                  filter === tab.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label} ({tab.count})
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative">
              <Search className="h-4 w-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Filter by number or name..."
                className="h-9 w-56 rounded-md border border-slate-200 bg-slate-50 pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-emerald-600 focus:outline-none"
              />
            </div>

            {total > 0 && counts.queued < total && (
              <button
                type="button"
                onClick={() => void onBulkStatus({ toStatus: 'queued' })}
                className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                Reset All to Queued
              </button>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="px-6 py-14 text-center space-y-2">
            <div className="text-sm font-medium text-slate-900">
              {total === 0
                ? 'No numbers to track yet'
                : 'No recipients match this status filter'}
            </div>
            {total === 0 ? (
              <p className="text-xs text-slate-500">
                Upload an Excel or CSV file of phone numbers, link WhatsApp, and click Send to All.
              </p>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setFilter('all');
                  setSearch('');
                }}
                className="text-xs font-medium text-emerald-700 hover:underline"
              >
                Show all numbers
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2.5 px-6 font-medium">Recipient</th>
                    <th className="py-2.5 px-4 font-medium">Phone</th>
                    <th className="py-2.5 px-4 font-medium">Delivery Status</th>
                    {showPollResults && (
                      <th className="py-2.5 px-4 font-medium">Poll Vote</th>
                    )}
                    <th className="py-2.5 px-4 font-medium">Sent</th>
                    <th className="py-2.5 px-4 font-medium">Delivered / Read</th>
                    <th className="py-2.5 px-6 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {pageItems.map((r) => {
                    const waUrl = buildWaMeUrl(
                      r.phone,
                      renderPersonalizedMessage(campaign, r, origin)
                    );
                    const isRecentlyUpdated = Boolean(recentPulseIds[r.id]);
                    const recipientVote = campaign.poll?.votes?.[r.id];

                    return (
                      <tr
                        key={r.id}
                        className={`h-11 transition-colors ${
                          isRecentlyUpdated
                            ? 'bg-emerald-50/70'
                            : 'hover:bg-slate-50/80'
                        }`}
                      >
                        <td className="py-2 px-6 whitespace-nowrap">
                          <div className="font-medium text-slate-900">
                            {r.name.trim() || formatDisplayPhone(r.phone)}
                          </div>
                          {r.failedReason && (
                            <div className="text-[11px] text-red-600 truncate max-w-[220px]">
                              {r.failedReason}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-4 font-mono text-xs text-slate-700 tabular-nums whitespace-nowrap">
                          {formatDisplayPhone(r.phone)}
                        </td>
                        <td className="py-2 px-4 whitespace-nowrap">
                          {renderStatusCell(r)}
                        </td>
                        {showPollResults && (
                          <td className="py-2 px-4 text-xs whitespace-nowrap max-w-[220px] truncate">
                            {recipientVote && recipientVote.selectedOptions.length > 0 ? (
                              <span className="font-medium text-emerald-800">
                                {recipientVote.selectedOptions.join(' · ')}
                              </span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                        )}
                        <td className="py-2 px-4 font-mono text-xs text-slate-500 tabular-nums whitespace-nowrap">
                          {formatClockTime(r.sentAt || r.dispatchedAt)}
                        </td>
                        <td className="py-2 px-4 font-mono text-xs text-slate-500 tabular-nums whitespace-nowrap">
                          {r.readAt ? (
                            <span className="inline-flex items-center gap-1 text-sky-700">
                              <Eye className="h-3 w-3" />
                              Read {formatClockTime(r.readAt)}
                            </span>
                          ) : r.deliveredAt ? (
                            `Delivered ${formatClockTime(r.deliveredAt)}`
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-2 px-6 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={r.status === 'sending'}
                              onClick={() => onSendDirectSingle(r.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-50 rounded transition-colors disabled:opacity-50 whitespace-nowrap"
                            >
                              <Send className="h-3.5 w-3.5" />
                              {r.status === 'sending'
                                ? 'Sending...'
                                : r.status === 'queued' || r.status === 'failed'
                                  ? 'Send'
                                  : 'Resend'}
                            </button>

                            <button
                              type="button"
                              onClick={() => void copyUrl(waUrl)}
                              title="Copy wa.me link"
                              className="p-1.5 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="px-6 py-3 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600">
                <span className="tabular-nums">
                  Showing {(safePage - 1) * PAGE_SIZE + 1}–
                  {Math.min(safePage * PAGE_SIZE, filtered.length)} of{' '}
                  {filtered.length.toLocaleString()} recipients
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={safePage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40"
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="px-2.5 font-mono tabular-nums">
                    {safePage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40"
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {counts.queued > 0 && (
          <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-slate-600 tabular-nums">
              {counts.queued.toLocaleString()} numbers queued for direct background delivery.
            </span>
            <button
              type="button"
              onClick={onStartBatchDispatch}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Send className="h-3.5 w-3.5" />
              Send to All Queued ({counts.queued})
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
