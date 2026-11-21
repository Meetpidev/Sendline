import { Plus, Trash2 } from 'lucide-react';
import type { CampaignPoll, PollType } from '../types';

interface PollBuilderSectionProps {
  poll: CampaignPoll;
  onChangePoll: (next: CampaignPoll) => void;
  onViewResults?: () => void;
}

const POLL_TYPES: Array<{ id: PollType; label: string }> = [
  { id: 'single_choice', label: 'Single Choice' },
  { id: 'multiple_choice', label: 'Multiple Choice' },
  { id: 'yes_no', label: 'Yes / No' },
  { id: 'rating', label: 'Rating (1–5)' },
];

export function PollBuilderSection({
  poll,
  onChangePoll,
  onViewResults,
}: PollBuilderSectionProps) {
  const voterCount = Object.values(poll.votes || {}).filter(
    (v) => v.selectedOptions.length > 0
  ).length;

  function patchPoll(patch: Partial<CampaignPoll>) {
    onChangePoll({
      ...poll,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  }

  function handleSelectType(nextType: PollType) {
    if (nextType === 'yes_no') {
      patchPoll({
        pollType: 'yes_no',
        options: ['Yes', 'No'],
        selectableCount: 1,
      });
    } else if (nextType === 'rating') {
      patchPoll({
        pollType: 'rating',
        options: [
          '5 - Excellent',
          '4 - Good',
          '3 - Average',
          '2 - Fair',
          '1 - Poor',
        ],
        selectableCount: 1,
      });
    } else if (nextType === 'multiple_choice') {
      const nextOpts =
        poll.options.length >= 2 ? poll.options : ['Option 1', 'Option 2'];
      patchPoll({
        pollType: 'multiple_choice',
        options: nextOpts,
        selectableCount: 0,
      });
    } else {
      const nextOpts =
        poll.options.length >= 2 ? poll.options : ['Option 1', 'Option 2'];
      patchPoll({
        pollType: 'single_choice',
        options: nextOpts,
        selectableCount: 1,
      });
    }
  }

  function updateOption(idx: number, value: string) {
    const next = [...poll.options];
    next[idx] = value;
    patchPoll({ options: next });
  }

  function addOption() {
    if (poll.options.length >= 12) return;
    patchPoll({
      options: [...poll.options, `Option ${poll.options.length + 1}`],
    });
  }

  function removeOption(idx: number) {
    if (poll.options.length <= 2) return;
    const next = poll.options.filter((_, i) => i !== idx);
    const nextSelectable =
      poll.selectableCount > next.length ? next.length : poll.selectableCount;
    patchPoll({ options: next, selectableCount: nextSelectable });
  }

  const nonEmptyOptions = poll.options.filter((o) => o.trim().length > 0);
  const needsDetails =
    poll.enabled && (!poll.question.trim() || nonEmptyOptions.length < 2);

  return (
    <div className="space-y-4">
      {/* Header + Primary "Send Poll to All Users" Checkbox */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            WhatsApp Poll
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Create any type of native WhatsApp poll and collect live recipient votes automatically.
          </p>
        </div>

        {onViewResults && (
          <button
            type="button"
            onClick={onViewResults}
            className="text-xs font-medium text-emerald-700 hover:text-emerald-800 hover:underline whitespace-nowrap shrink-0 tabular-nums"
          >
            View Poll Results ({voterCount})
          </button>
        )}
      </div>

      {/* Prominent Checkbox: Send this poll to all users */}
      <label className="flex items-start gap-2.5 p-3.5 rounded-md border border-slate-200 bg-slate-50/70 hover:bg-slate-50 cursor-pointer select-none transition-colors">
        <input
          type="checkbox"
          checked={poll.enabled}
          onChange={(e) => patchPoll({ enabled: e.target.checked })}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
        />
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-900">
            Send this poll to all users
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            When checked, clicking Send or Send to All sends this native WhatsApp poll to every recipient in the campaign.
          </div>
        </div>
      </label>

      {/* Poll Type Selector */}
      <div className="space-y-2">
        <span className="block text-xs font-medium text-slate-700">
          Poll Type
        </span>
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-md w-fit">
          {POLL_TYPES.map((type) => (
            <button
              key={type.id}
              type="button"
              onClick={() => handleSelectType(type.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                poll.pollType === type.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {type.label}
            </button>
          ))}
        </div>
      </div>

      {/* Poll Question Input */}
      <div>
        <label
          htmlFor="poll-question-input"
          className="block text-xs font-medium text-slate-700 mb-1.5"
        >
          Poll Question
        </label>
        <input
          id="poll-question-input"
          type="text"
          value={poll.question}
          onChange={(e) => patchPoll({ question: e.target.value })}
          placeholder="e.g. Which delivery slot works best for you?"
          className="w-full h-10 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/15"
        />
      </div>

      {/* Poll Options List */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-slate-700">
            Options ({poll.options.length}/12)
          </span>
          {poll.options.length < 12 && (
            <button
              type="button"
              onClick={addOption}
              className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:text-emerald-800 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Option
            </button>
          )}
        </div>

        <div className="space-y-2">
          {poll.options.map((opt, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <span className="w-6 text-right font-mono text-xs tabular-nums text-slate-400 shrink-0">
                {idx + 1}.
              </span>
              <input
                type="text"
                value={opt}
                onChange={(e) => updateOption(idx, e.target.value)}
                placeholder={`Option ${idx + 1}`}
                className="flex-1 h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/15"
              />
              <button
                type="button"
                disabled={poll.options.length <= 2}
                onClick={() => removeOption(idx)}
                title="Remove option"
                className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-30"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Multiple Choice Selection Limit */}
      {poll.pollType === 'multiple_choice' && (
        <div className="flex items-center justify-between gap-4 pt-1">
          <div>
            <label
              htmlFor="poll-max-select"
              className="block text-xs font-medium text-slate-700"
            >
              Selection Limit
            </label>
            <span className="text-xs text-slate-500">
              How many options each recipient can choose
            </span>
          </div>
          <select
            id="poll-max-select"
            value={poll.selectableCount}
            onChange={(e) =>
              patchPoll({ selectableCount: Number(e.target.value) })
            }
            className="h-9 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-mono text-slate-900 focus:border-emerald-600 focus:outline-none"
          >
            <option value={0}>Any number (Unlimited)</option>
            {Array.from(
              { length: Math.max(0, poll.options.length - 1) },
              (_, i) => i + 2
            ).map((n) => (
              <option key={n} value={n}>
                Up to {n} options
              </option>
            ))}
          </select>
        </div>
      )}

      {needsDetails && (
        <p className="text-xs text-amber-700">
          Enter a poll question and at least 2 options so this poll can be sent.
        </p>
      )}
    </div>
  );
}
