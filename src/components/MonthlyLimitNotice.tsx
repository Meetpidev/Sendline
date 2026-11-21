import { AlertTriangle, ShieldCheck } from 'lucide-react';
import type { MonthlyAccountUsage } from '../types';

interface MonthlyLimitNoticeProps {
  usage: MonthlyAccountUsage | null;
  compact?: boolean;
}

function formatMonthLabel(monthKey?: string): string {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
    return new Date().toLocaleDateString(undefined, {
      month: 'short',
      year: 'numeric',
    });
  }
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
  });
}

export function MonthlyLimitNotice({
  usage,
  compact = false,
}: MonthlyLimitNoticeProps) {
  const sentThisMonth = usage?.sentThisMonth ?? 0;
  const sentToday = usage?.sentToday ?? 0;
  const monthlyLimit = usage?.recommendedMonthlyLimit ?? 6000;
  const newAccountMonthlyLimit = usage?.newAccountMonthlyLimit ?? 1500;
  const dailyLimit = usage?.recommendedDailyLimit ?? 200;
  const officialApiStarterDaily = usage?.officialApiStarterDaily ?? 250;
  const broadcastListCap = usage?.freeAppBroadcastListCap ?? 256;

  const pct =
    monthlyLimit > 0
      ? Math.min(100, Math.round((sentThisMonth / monthlyLimit) * 100))
      : 0;
  const isWarning = pct >= 75 && pct < 95;
  const isDanger = pct >= 95;

  const barColor = isDanger
    ? 'bg-red-600'
    : isWarning
      ? 'bg-amber-500'
      : 'bg-emerald-600';

  const remaining = Math.max(0, monthlyLimit - sentThisMonth);
  const monthLabel = formatMonthLabel(usage?.monthKey);

  return (
    <section
      aria-label="Monthly WhatsApp account sending limit"
      className="bg-white border border-slate-200 rounded-lg px-5 py-4 space-y-3"
    >
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          {isDanger || isWarning ? (
            <AlertTriangle
              className={`h-4 w-4 shrink-0 mt-0.5 ${
                isDanger ? 'text-red-600' : 'text-amber-600'
              }`}
            />
          ) : (
            <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-emerald-700" />
          )}
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">
              Monthly Account Limit: up to{' '}
              <span className="font-mono tabular-nums text-emerald-800">
                {monthlyLimit.toLocaleString()}
              </span>{' '}
              messages / month per WhatsApp account
            </div>
            <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
              Safe anti-ban limit for an established linked account (90+ days old) is{' '}
              <strong className="font-semibold text-slate-800 tabular-nums">
                ~{monthlyLimit.toLocaleString()}/month
              </strong>{' '}
              (<span className="tabular-nums">~{dailyLimit}/day</span>). New accounts
              (&lt;30 days) should stay under{' '}
              <strong className="font-semibold text-slate-800 tabular-nums">
                {newAccountMonthlyLimit.toLocaleString()}/month
              </strong>{' '}
              (<span className="tabular-nums">~50/day</span>).
            </p>
          </div>
        </div>

        <div className="flex items-baseline md:flex-col md:items-end justify-between gap-1 shrink-0 tabular-nums">
          <div className="font-mono text-sm font-semibold text-slate-900">
            <span
              className={
                isDanger
                  ? 'text-red-700'
                  : isWarning
                    ? 'text-amber-700'
                    : 'text-emerald-700'
              }
            >
              {sentThisMonth.toLocaleString()}
            </span>{' '}
            / {monthlyLimit.toLocaleString()}{' '}
            <span className="font-sans text-xs font-normal text-slate-500">
              ({monthLabel})
            </span>
          </div>
          <div className="font-mono text-[11px] text-slate-500">
            {sentToday.toLocaleString()} / {dailyLimit} today ·{' '}
            {remaining.toLocaleString()} left this month
          </div>
        </div>
      </div>

      {/* Progress Track */}
      <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
        <div
          className={`h-full transition-all duration-200 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>

  
    </section>
  );
}
