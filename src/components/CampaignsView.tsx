import { useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import type { CampaignSummary } from '../types';
import { formatShortDateTime } from '../utils/whatsapp';

interface CampaignsViewProps {
  campaigns: CampaignSummary[];
  activeCampaignId: string;
  onSelectCampaign: (id: string) => void;
  onCreateCampaign: (name: string) => Promise<void>;
  onDuplicateCampaign: (id: string) => Promise<void>;
  onDeleteCampaign: (id: string) => Promise<void>;
}

export function CampaignsView({
  campaigns,
  activeCampaignId,
  onSelectCampaign,
  onCreateCampaign,
  onDuplicateCampaign,
  onDeleteCampaign,
}: CampaignsViewProps) {
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      await onCreateCampaign(trimmed);
      setNewName('');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Create New Campaign Row */}
      <section className="bg-white border border-slate-200 rounded-lg p-6">
        <h2 className="text-sm font-semibold text-slate-900">
          Create New Broadcast Campaign
        </h2>
        <p className="text-xs text-slate-500 mt-0.5 mb-4">
          Each campaign maintains its own message template, uploaded PDF/image attachments, contact list, and delivery log.
        </p>
        <form onSubmit={(e) => void handleCreate(e)} className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. November Invoice Reminders or Festival Offer Brochure"
            className="flex-1 h-10 rounded-md border border-slate-200 px-3.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/15"
          />
          <button
            type="submit"
            disabled={creating || !newName.trim()}
            className="inline-flex items-center justify-center gap-1.5 h-10 px-4 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4" />
            {creating ? 'Creating...' : 'Create Campaign'}
          </button>
        </form>
      </section>

      {/* Campaigns Table */}
      <section className="bg-white border border-slate-200 rounded-lg">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-900">
            Saved Campaigns ({campaigns.length})
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                <th className="py-2.5 px-6 font-medium">Campaign Name</th>
                <th className="py-2.5 px-4 font-medium text-right">Recipients</th>
                <th className="py-2.5 px-4 font-medium text-right">Sent / Opened</th>
                <th className="py-2.5 px-4 font-medium text-right">Files</th>
                <th className="py-2.5 px-4 font-medium">Last Updated</th>
                <th className="py-2.5 px-6 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {campaigns.map((c) => {
                const isActive = c.id === activeCampaignId;
                const sentTotal =
                  (c.counts.sent || 0) +
                  (c.counts.delivered || 0) +
                  (c.counts.read || 0) +
                  (c.counts.opened || 0);
                const readTotal = (c.counts.read || 0) + (c.counts.opened || 0);
                return (
                  <tr
                    key={c.id}
                    className={`h-12 transition-colors ${
                      isActive ? 'bg-emerald-50/40' : 'hover:bg-slate-50'
                    }`}
                  >
                    <td className="py-2 px-6">
                      <button
                        type="button"
                        onClick={() => onSelectCampaign(c.id)}
                        className="text-left font-medium text-slate-900 hover:text-emerald-800 transition-colors"
                      >
                        {c.name}
                      </button>
                      {isActive && (
                        <span className="ml-2 text-xs text-emerald-700 font-medium">
                          · Active
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-4 text-right font-mono text-xs tabular-nums text-slate-700">
                      {c.totalRecipients.toLocaleString()}
                    </td>
                    <td className="py-2 px-4 text-right font-mono text-xs tabular-nums text-emerald-700">
                      {sentTotal.toLocaleString()} / {readTotal.toLocaleString()}
                    </td>
                    <td className="py-2 px-4 text-right font-mono text-xs tabular-nums text-slate-600">
                      {c.attachmentCount}
                    </td>
                    <td className="py-2 px-4 font-mono text-xs tabular-nums text-slate-500 whitespace-nowrap">
                      {formatShortDateTime(c.updatedAt)}
                    </td>
                    <td className="py-2 px-6 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        {!isActive && (
                          <button
                            type="button"
                            onClick={() => onSelectCampaign(c.id)}
                            className="px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-50 rounded transition-colors whitespace-nowrap"
                          >
                            Open
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void onDuplicateCampaign(c.id)}
                          title="Duplicate campaign"
                          className="p-1.5 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={campaigns.length <= 1}
                          onClick={() => void onDeleteCampaign(c.id)}
                          title="Delete campaign"
                          className="p-1.5 text-slate-400 hover:text-red-700 hover:bg-red-50 rounded transition-colors disabled:opacity-30"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
