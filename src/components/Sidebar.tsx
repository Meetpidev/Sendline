import {
  Activity,
  BarChart3,
  FolderKanban,
  Link2,
  LogOut,
  Menu,
  MessageSquareText,
  Users,
  X,
} from 'lucide-react';
import type {
  AuthUser,
  Campaign,
  CampaignSummary,
  MonthlyAccountUsage,
  WhatsAppSessionState,
} from '../types';
import { formatDisplayPhone } from '../utils/whatsapp';

export type WorkspaceTab = 'composer' | 'polls' | 'contacts' | 'tracker' | 'campaigns';

interface SidebarProps {
  user: AuthUser;
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  activeCampaign: Campaign | null;
  campaigns: CampaignSummary[];
  whatsapp: WhatsAppSessionState;
  usage: MonthlyAccountUsage | null;
  onSelectCampaign: (id: string) => void;
  onOpenWhatsAppModal: () => void;
  onLogout: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: Array<{
  id: WorkspaceTab;
  label: string;
  icon: typeof MessageSquareText;
}> = [
  { id: 'composer', label: 'Composer & Dispatch', icon: MessageSquareText },
  { id: 'polls', label: 'Polls & Results', icon: BarChart3 },
  { id: 'contacts', label: 'Contacts & Excel', icon: Users },
  { id: 'tracker', label: 'Delivery Tracker', icon: Activity },
  { id: 'campaigns', label: 'Campaigns', icon: FolderKanban },
];

export function Sidebar({
  user,
  activeTab,
  onSelectTab,
  activeCampaign,
  campaigns,
  whatsapp,
  usage,
  onSelectCampaign,
  onOpenWhatsAppModal,
  onLogout,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const counts = activeCampaign
    ? activeCampaign.recipients.reduce(
        (acc, r) => {
          acc[r.status] = (acc[r.status] || 0) + 1;
          return acc;
        },
        {
          queued: 0,
          sending: 0,
          sent: 0,
          delivered: 0,
          read: 0,
          opened: 0,
          dispatched: 0,
          failed: 0,
          skipped: 0,
        }
      )
    : null;

  const sentTotal = counts
    ? counts.sent + counts.delivered + counts.read + counts.opened
    : 0;

  const content = (
    <div className="flex h-full flex-col bg-white border-r border-slate-200">
      {/* Brand Zone: Single clean wordmark */}
      <div className="flex h-16 items-center justify-between px-6 border-b border-slate-200 shrink-0">
        <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
          Sendline
        </span>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation"
          className="lg:hidden p-2 -mr-2 text-slate-500 hover:text-slate-900 rounded-md"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Active Campaign Selector */}
      <div className="px-4 py-4 border-b border-slate-200">
        <label
          htmlFor="sidebar-campaign-select"
          className="block text-xs font-medium text-slate-500 mb-1.5"
        >
          Active Campaign
        </label>
        <select
          id="sidebar-campaign-select"
          value={activeCampaign?.id || ''}
          onChange={(e) => onSelectCampaign(e.target.value)}
          className="w-full h-9 rounded-md border border-slate-200 bg-slate-50 px-2.5 text-sm font-medium text-slate-900 focus:border-emerald-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-600/15 truncate"
        >
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Primary Workspace Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="Primary">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          let countLabel: string | null = null;
          if (item.id === 'contacts' && activeCampaign) {
            countLabel = String(activeCampaign.recipients.length);
          } else if (item.id === 'polls' && activeCampaign) {
            const voters = Object.values(activeCampaign.poll?.votes || {}).filter(
              (v) => v.selectedOptions.length > 0
            ).length;
            countLabel = activeCampaign.poll?.enabled ? `${voters} votes` : String(voters);
          } else if (item.id === 'tracker' && counts) {
            countLabel = `${sentTotal}/${activeCampaign?.recipients.length || 0}`;
          } else if (item.id === 'campaigns') {
            countLabel = String(campaigns.length);
          }

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onSelectTab(item.id);
                onCloseMobile();
              }}
              className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                isActive
                  ? 'bg-emerald-50 text-emerald-900'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <Icon
                  className={`h-4 w-4 shrink-0 ${
                    isActive ? 'text-emerald-700' : 'text-slate-400'
                  }`}
                />
                <span className="truncate">{item.label}</span>
              </span>
              {countLabel && (
                <span className="font-mono text-xs tabular-nums text-slate-500 shrink-0">
                  {countLabel}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* WhatsApp Direct Link Control */}
      <div className="px-4 py-3.5 border-t border-slate-200">
        <button
          type="button"
          onClick={() => {
            onOpenWhatsAppModal();
            onCloseMobile();
          }}
          className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-md border text-left transition-colors ${
            whatsapp.status === 'connected'
              ? 'bg-emerald-50/70 border-emerald-200 hover:bg-emerald-50 text-emerald-950'
              : 'bg-slate-50 border-slate-200 hover:bg-slate-100 text-slate-900'
          }`}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-semibold">
              <Link2
                className={`h-3.5 w-3.5 shrink-0 ${
                  whatsapp.status === 'connected'
                    ? 'text-emerald-700'
                    : 'text-slate-500'
                }`}
              />
              <span className="truncate">
                {whatsapp.status === 'connected'
                  ? 'WhatsApp Linked'
                  : whatsapp.status === 'connecting'
                    ? 'Connecting...'
                    : 'Link WhatsApp'}
              </span>
            </div>
            <div className="text-[11px] font-mono tabular-nums text-slate-500 truncate mt-0.5">
              {whatsapp.status === 'connected' && whatsapp.accountPhone
                ? formatDisplayPhone(whatsapp.accountPhone)
                : 'Scan QR for direct sending'}
            </div>
          </div>
        </button>
      </div>

      {/* Quiet Queue Breakdown Footer */}
      {activeCampaign && counts && (
        <div className="px-5 py-4 border-t border-slate-200 text-xs text-slate-600 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Queued</span>
            <span className="font-mono tabular-nums font-medium text-slate-900">
              {counts.queued}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Delivered / Read</span>
            <span className="font-mono tabular-nums font-medium text-emerald-700">
              {counts.delivered + counts.read + counts.opened}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Failed</span>
            <span className="font-mono tabular-nums font-medium text-red-700">
              {counts.failed}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Attachments</span>
            <span className="font-mono tabular-nums font-medium text-slate-900">
              {activeCampaign.attachments.length}
            </span>
          </div>
          <div className="pt-2 mt-1 border-t border-slate-100 flex items-center justify-between">
            <span className="text-slate-500">Monthly Limit</span>
            <span className="font-mono tabular-nums font-medium text-slate-900">
              {(usage?.sentThisMonth ?? 0).toLocaleString()} /{' '}
              {(usage?.recommendedMonthlyLimit ?? 6000).toLocaleString()}
            </span>
          </div>
        </div>
      )}

      {/* Private Account Footer */}
      <div className="px-4 py-3 border-t border-slate-200 flex items-center justify-between gap-2 bg-slate-50/70">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-900 truncate">
            {user.name}
          </div>
          <div className="text-[11px] text-slate-500 truncate">{user.email}</div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          title="Sign out"
          aria-label="Sign out"
          className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-200/70 rounded-md transition-colors shrink-0"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block w-64 shrink-0 h-screen sticky top-0">
        {content}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/30"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative w-72 max-w-[85vw] h-full z-10 shadow-xl">
            {content}
          </aside>
        </div>
      )}
    </>
  );
}

export function MobileMenuButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open navigation menu"
      className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md"
    >
      <Menu className="h-5 w-5" />
    </button>
  );
}
