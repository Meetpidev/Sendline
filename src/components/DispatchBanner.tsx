import { Loader2, Pause, Play, Square } from 'lucide-react';
import type { ServerDispatchJobState } from '../types';
import { formatDisplayPhone } from '../utils/whatsapp';

interface DispatchBannerProps {
  job: ServerDispatchJobState;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

export function DispatchBanner({
  job,
  onPause,
  onResume,
  onStop,
}: DispatchBannerProps) {
  if (job.status === 'idle') return null;

  const progressPct =
    job.totalCount > 0
      ? Math.min(100, Math.round((job.processedCount / job.totalCount) * 100))
      : 0;

  return (
    <div className="bg-white border-b border-slate-200 px-6 py-3.5">
      <div className="max-w-[1440px] mx-auto flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        {/* Progress & Current Recipient */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5 text-sm font-semibold text-slate-900">
            {job.status === 'running' && (
              <Loader2 className="h-4 w-4 animate-spin text-emerald-700 shrink-0" />
            )}
            <span>
              {job.status === 'running' && 'Sending Directly in Background'}
              {job.status === 'paused' && 'Direct Sending Paused'}
              {job.status === 'completed' && 'Direct Broadcast Completed'}
            </span>
            <span className="text-slate-300" aria-hidden="true">
              ·
            </span>
            <span className="font-mono tabular-nums text-emerald-700">
              {job.processedCount} / {job.totalCount} ({progressPct}%)
            </span>
            <span className="text-slate-300" aria-hidden="true">
              ·
            </span>
            <span className="text-xs font-normal text-slate-600 tabular-nums">
              {job.sentCount} sent
              {job.failedCount > 0 ? ` / ${job.failedCount} failed` : ''}
            </span>
            {job.status === 'running' && job.nextSendInSeconds > 0 && (
              <>
                <span className="text-slate-300" aria-hidden="true">
                  ·
                </span>
                <span className="font-mono tabular-nums text-xs font-normal text-slate-500">
                  Next in {job.nextSendInSeconds}s
                </span>
              </>
            )}
          </div>

          {job.currentPhone && job.status === 'running' && (
            <div className="mt-1 text-xs text-slate-600">
              Current target:{' '}
              <span className="font-mono tabular-nums font-medium text-slate-900">
                {formatDisplayPhone(job.currentPhone)}
              </span>
            </div>
          )}

          {/* Linear Progress Track */}
          <div className="mt-2 h-1.5 w-full max-w-md bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-600 transition-transform duration-200 origin-left"
              style={{ transform: `scaleX(${progressPct / 100})` }}
            />
          </div>
        </div>

        {/* Runner Controls */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {job.status === 'running' && (
            <button
              type="button"
              onClick={onPause}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Pause className="h-3.5 w-3.5" />
              Pause
            </button>
          )}

          {job.status === 'paused' && (
            <button
              type="button"
              onClick={onResume}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Play className="h-3.5 w-3.5" />
              Resume
            </button>
          )}

          <button
            type="button"
            onClick={onStop}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Square className="h-3 w-3" />
            {job.status === 'completed' ? 'Dismiss' : 'Stop'}
          </button>
        </div>
      </div>
    </div>
  );
}
