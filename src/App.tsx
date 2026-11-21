import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, Send } from 'lucide-react';
import { api, ApiError, getAuthToken } from './api/client';
import { AuthView } from './components/AuthView';
import { CampaignsView } from './components/CampaignsView';
import { ComposerView } from './components/ComposerView';
import { ContactsView } from './components/ContactsView';
import { DispatchBanner } from './components/DispatchBanner';
import { PollsView } from './components/PollsView';
import { RecipientMediaView } from './components/RecipientMediaView';
import {
  MobileMenuButton,
  Sidebar,
  type WorkspaceTab,
} from './components/Sidebar';
import { TrackerView } from './components/TrackerView';
import { WhatsAppConnectModal } from './components/WhatsAppConnectModal';
import type {
  AuthUser,
  Campaign,
  CampaignSummary,
  MonthlyAccountUsage,
  RealtimeEvent,
  ServerDispatchJobState,
  WhatsAppSessionState,
} from './types';

const TAB_TITLES: Record<WorkspaceTab, string> = {
  composer: 'Composer & Dispatch',
  polls: 'Polls & Results',
  contacts: 'Contacts & Excel',
  tracker: 'Delivery Tracker',
  campaigns: 'Campaigns',
};

const INITIAL_WA_SESSION: WhatsAppSessionState = {
  status: 'disconnected',
  qrDataUrl: null,
  pairingCode: null,
  accountName: null,
  accountPhone: null,
  lastError: null,
};

const INITIAL_JOB: ServerDispatchJobState = {
  campaignId: null,
  status: 'idle',
  currentRecipientId: null,
  currentPhone: null,
  processedCount: 0,
  totalCount: 0,
  sentCount: 0,
  failedCount: 0,
  nextSendInSeconds: 0,
};

export default function App() {
  const viewMatch = window.location.pathname.match(/^\/view\/([^/]+)\/([^/]+)/);
  if (viewMatch) {
    return (
      <RecipientMediaView
        campaignId={decodeURIComponent(viewMatch[1])}
        recipientId={decodeURIComponent(viewMatch[2])}
      />
    );
  }

  return <AuthenticatedShell />;
}

function AuthenticatedShell() {
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [databaseConfigured, setDatabaseConfigured] = useState(true);
  const [databaseReady, setDatabaseReady] = useState(true);
  const [databaseError, setDatabaseError] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  const checkSession = useCallback(async () => {
    try {
      const res = await api.getMe();
      setDatabaseConfigured(res.databaseConfigured);
      setDatabaseReady(res.databaseReady);
      setDatabaseError(res.databaseError);
      setUser(res.user);
    } catch (err) {
      setDatabaseError(
        err instanceof Error ? err.message : 'Unable to reach server'
      );
      setUser(null);
    } finally {
      setCheckingAuth(false);
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
        <div className="text-sm text-slate-500 font-medium">
          Loading Sendline workspace...
        </div>
      </div>
    );
  }

  if (!databaseConfigured || !databaseReady || !user) {
    return (
      <AuthView
        databaseConfigured={databaseConfigured}
        databaseReady={databaseReady}
        databaseError={databaseError}
        onAuthenticated={(authedUser) => {
          setDatabaseConfigured(true);
          setDatabaseReady(true);
          setDatabaseError(null);
          setUser(authedUser);
        }}
        onRetryConnection={checkSession}
      />
    );
  }

  return (
    <DashboardWorkspace
      key={user.id}
      user={user}
      onSignedOut={() => setUser(null)}
    />
  );
}

function DashboardWorkspace({
  user,
  onSignedOut,
}: {
  user: AuthUser;
  onSignedOut: () => void;
}) {
  const origin = window.location.origin;

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('composer');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [activeCampaign, setActiveCampaign] = useState<Campaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [whatsapp, setWhatsapp] = useState<WhatsAppSessionState>(INITIAL_WA_SESSION);
  const [usage, setUsage] = useState<MonthlyAccountUsage | null>(null);
  const [waModalOpen, setWaModalOpen] = useState(false);
  const [dispatchJob, setDispatchJob] = useState<ServerDispatchJobState>(INITIAL_JOB);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [recentPulseIds, setRecentPulseIds] = useState<Record<string, number>>({});

  const activeCampaignRef = useRef<Campaign | null>(null);
  activeCampaignRef.current = activeCampaign;
  const saveDebounceRef = useRef<number | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
    }, 3600);
  }, []);

  const flashRecipientRow = useCallback((recipientId: string) => {
    setRecentPulseIds((prev) => ({ ...prev, [recipientId]: Date.now() }));
    window.setTimeout(() => {
      setRecentPulseIds((prev) => {
        const next = { ...prev };
        delete next[recipientId];
        return next;
      });
    }, 2400);
  }, []);

  const loadWorkspace = useCallback(
    async (preferredId?: string) => {
      try {
        const [{ campaigns: list }, waRes] = await Promise.all([
          api.listCampaigns(),
          api.getWhatsAppStatus(),
        ]);
        setCampaigns(list);
        setWhatsapp(waRes.whatsapp);
        setUsage(waRes.usage);
        setDispatchJob(waRes.dispatchJob);

        const targetId =
          preferredId || activeCampaignRef.current?.id || list[0]?.id;
        if (targetId) {
          const { campaign } = await api.getCampaign(targetId);
          setActiveCampaign(campaign);
        }
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          onSignedOut();
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load workspace');
      } finally {
        setLoading(false);
      }
    },
    [onSignedOut]
  );

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  // Authenticated Server-Sent Events stream using fetch ReadableStream
  // (sends Authorization: Bearer + HttpOnly cookie securely without exposing tokens in URLs)
  useEffect(() => {
    const controller = new AbortController();
    let reconnectTimer: number | null = null;
    let disposed = false;

    const handleRealtimePayload = (rawJson: string) => {
      try {
        const event = JSON.parse(rawJson) as RealtimeEvent;
        const current = activeCampaignRef.current;

        if (event.type === 'connected') {
          if (event.whatsapp) setWhatsapp(event.whatsapp);
          if (event.usage) setUsage(event.usage);
          if (event.dispatchJob) setDispatchJob(event.dispatchJob);
          return;
        }

        if (event.type === 'usage_updated' && event.usage) {
          setUsage(event.usage);
          return;
        }

        if (event.type === 'whatsapp_status' && event.whatsapp) {
          if (event.usage) setUsage(event.usage);
          setWhatsapp((prev) => {
            if (prev.status !== 'connected' && event.whatsapp?.status === 'connected') {
              notify('WhatsApp linked — you can now send directly without redirecting');
            }
            return event.whatsapp!;
          });
          return;
        }

        if (event.type === 'dispatch_job' && event.dispatchJob) {
          setDispatchJob(event.dispatchJob);
          return;
        }

        if (
          event.type === 'poll_vote_updated' &&
          event.poll &&
          current &&
          event.campaignId === current.id
        ) {
          setActiveCampaign((prev) => {
            if (!prev || prev.id !== event.campaignId) return prev;
            return {
              ...prev,
              poll: event.poll!,
              recipients: event.recipient
                ? prev.recipients.map((r) =>
                    r.id === event.recipient!.id ? event.recipient! : r
                  )
                : prev.recipients,
            };
          });
          if (event.recipientId) {
            flashRecipientRow(event.recipientId);
          }
          if (
            event.voterLabel &&
            event.selectedOptions &&
            event.selectedOptions.length > 0
          ) {
            notify(`${event.voterLabel} voted: ${event.selectedOptions.join(', ')}`);
          }
          void api.listCampaigns().then(({ campaigns: list }) => setCampaigns(list));
          return;
        }

        if (
          (event.type === 'recipient_updated' || event.type === 'recipient_opened') &&
          event.recipient &&
          current &&
          event.campaignId === current.id
        ) {
          const updatedRecipient = event.recipient;
          setActiveCampaign((prev) => {
            if (!prev || prev.id !== event.campaignId) return prev;
            return {
              ...prev,
              recipients: prev.recipients.map((r) =>
                r.id === updatedRecipient.id ? updatedRecipient : r
              ),
            };
          });
          flashRecipientRow(updatedRecipient.id);

          if (event.type === 'recipient_opened') {
            notify(
              `${updatedRecipient.name.trim() || `+${updatedRecipient.phone}`} opened the shared link`
            );
          }
          void api.listCampaigns().then(({ campaigns: list }) => setCampaigns(list));
        } else if (
          event.type === 'attachment_downloaded' &&
          current &&
          event.campaignId === current.id &&
          event.attachmentId
        ) {
          setActiveCampaign((prev) => {
            if (!prev || prev.id !== event.campaignId) return prev;
            return {
              ...prev,
              attachments: prev.attachments.map((att) =>
                att.id === event.attachmentId
                  ? {
                      ...att,
                      downloadCount: event.downloadCount ?? att.downloadCount + 1,
                    }
                  : att
              ),
            };
          });
        } else if (
          event.type === 'recipients_bulk_updated' ||
          event.type === 'campaign_updated'
        ) {
          void api.listCampaigns().then(({ campaigns: list }) => setCampaigns(list));
          if (current && event.campaignId === current.id) {
            void api
              .getCampaign(current.id)
              .then(({ campaign }) => setActiveCampaign(campaign));
          }
        }
      } catch {
        // ignore malformed chunk
      }
    };

    const connectStream = async () => {
      if (disposed) return;
      try {
        const headers: Record<string, string> = {
          Accept: 'text/event-stream',
          'X-Requested-With': 'Sendline',
        };
        const token = getAuthToken();
        if (token) headers.Authorization = `Bearer ${token}`;

        const res = await fetch('/api/events', {
          method: 'GET',
          credentials: 'same-origin',
          headers,
          signal: controller.signal,
        });

        if (res.status === 401) {
          onSignedOut();
          return;
        }
        if (!res.ok || !res.body) {
          throw new Error(`SSE stream failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!disposed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() || '';
          for (const chunk of chunks) {
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                handleRealtimePayload(line.slice(6));
              }
            }
          }
        }
      } catch {
        // retry silently unless aborted
      }

      if (!disposed && !controller.signal.aborted) {
        reconnectTimer = window.setTimeout(() => {
          void connectStream();
        }, 2500);
      }
    };

    void connectStream();

    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      controller.abort();
    };
  }, [flashRecipientRow, notify, onSignedOut]);

  const handleUpdateCampaign = useCallback(
    (
      patch: Partial<
        Pick<
          Campaign,
          'name' | 'message' | 'defaultCountryCode' | 'settings' | 'poll'
        >
      >
    ) => {
      setActiveCampaign((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          ...patch,
          settings: patch.settings
            ? { ...prev.settings, ...patch.settings }
            : prev.settings,
          poll: patch.poll ? { ...prev.poll, ...patch.poll } : prev.poll,
        };
      });

      const currentId = activeCampaignRef.current?.id;
      if (!currentId) return;

      if (saveDebounceRef.current) window.clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = window.setTimeout(() => {
        void api.updateCampaign(currentId, patch).catch(() => {
          // retry on next edit
        });
      }, 300);
    },
    []
  );

  const handleSendDirectSingle = useCallback(
    async (recipientId: string) => {
      const current = activeCampaignRef.current;
      if (!current) return;

      if (whatsapp.status !== 'connected') {
        setWaModalOpen(true);
        notify('Link your WhatsApp once to send directly without redirecting');
        return;
      }

      try {
        await api.sendRecipientDirect(current.id, recipientId, origin);
        notify('Message sent directly via WhatsApp');
      } catch (err) {
        if (err instanceof ApiError && err.needsWhatsAppAuth) {
          setWaModalOpen(true);
        }
        notify(err instanceof Error ? err.message : 'Failed to send message');
      }
    },
    [notify, origin, whatsapp.status]
  );

  const handleStartDirectBatch = useCallback(async () => {
    const current = activeCampaignRef.current;
    if (!current) return;

    const queued = current.recipients.filter((r) => r.status === 'queued');
    if (queued.length === 0) {
      notify('No queued numbers left. Reset statuses or upload more numbers.');
      return;
    }

    if (whatsapp.status !== 'connected') {
      setWaModalOpen(true);
      notify(
        'Scan the QR code once to send directly to all numbers without redirecting'
      );
      return;
    }

    try {
      const { dispatchJob: job } = await api.startDirectDispatch(current.id, origin);
      setDispatchJob(job);
      setActiveTab('tracker');
      notify(`Direct sending started for ${queued.length.toLocaleString()} numbers`);
    } catch (err) {
      if (err instanceof ApiError && err.needsWhatsAppAuth) {
        setWaModalOpen(true);
      }
      notify(err instanceof Error ? err.message : 'Could not start batch send');
    }
  }, [notify, origin, whatsapp.status]);

  const handleSelectCampaign = useCallback(
    async (id: string) => {
      try {
        const { campaign } = await api.getCampaign(id);
        setActiveCampaign(campaign);
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Failed to load campaign');
      }
    },
    [notify]
  );

  const handleLogout = useCallback(async () => {
    await api.logout();
    onSignedOut();
  }, [onSignedOut]);

  const queuedCount =
    activeCampaign?.recipients.filter((r) => r.status === 'queued').length || 0;
  const isCurrentJobRunning =
    dispatchJob.status === 'running' &&
    dispatchJob.campaignId === activeCampaign?.id;
  const isCurrentJobPaused =
    dispatchJob.status === 'paused' &&
    dispatchJob.campaignId === activeCampaign?.id;

  return (
    <div className="min-h-screen flex bg-[#F8FAFC] text-slate-900">
      <Sidebar
        user={user}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        activeCampaign={activeCampaign}
        campaigns={campaigns}
        whatsapp={whatsapp}
        usage={usage}
        onSelectCampaign={(id) => void handleSelectCampaign(id)}
        onOpenWhatsAppModal={() => setWaModalOpen(true)}
        onLogout={() => void handleLogout()}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar Contract: Breadcrumb on Left, Single Primary CTA on Right */}
        <header className="sticky top-0 z-30 h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-8 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <MobileMenuButton onClick={() => setMobileNavOpen(true)} />
            <nav
              aria-label="Breadcrumb"
              className="flex items-center gap-2 text-sm min-w-0"
            >
              <button
                type="button"
                onClick={() => setActiveTab('campaigns')}
                className="text-slate-500 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 hidden sm:inline"
              >
                Campaigns
              </button>
              <span
                className="text-slate-300 hidden sm:inline"
                aria-hidden="true"
              >
                /
              </span>
              <span className="font-medium text-slate-700 truncate max-w-[160px] md:max-w-[260px]">
                {activeCampaign?.name || 'Loading...'}
              </span>
              <span className="text-slate-300" aria-hidden="true">
                /
              </span>
              <span className="font-semibold text-slate-900 whitespace-nowrap shrink-0">
                {TAB_TITLES[activeTab]}
              </span>
            </nav>
          </div>

          <div className="flex items-center shrink-0">
            {isCurrentJobRunning && activeCampaign ? (
              <button
                type="button"
                onClick={() => void api.pauseDirectDispatch(activeCampaign.id)}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                <Pause className="h-3.5 w-3.5" />
                Pause Sending
              </button>
            ) : isCurrentJobPaused && activeCampaign ? (
              <button
                type="button"
                onClick={() => void api.resumeDirectDispatch(activeCampaign.id)}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                <Play className="h-3.5 w-3.5" />
                Resume Sending
              </button>
            ) : (
              <button
                type="button"
                disabled={!activeCampaign || queuedCount === 0}
                onClick={() => void handleStartDirectBatch()}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap shrink-0"
              >
                <Send className="h-3.5 w-3.5" />
                Send to All ({queuedCount.toLocaleString()})
              </button>
            )}
          </div>
        </header>

        {/* Server-Side Zero-Redirect Dispatch Progress Banner */}
        {activeCampaign && dispatchJob.campaignId === activeCampaign.id && (
          <DispatchBanner
            job={dispatchJob}
            onPause={() => void api.pauseDirectDispatch(activeCampaign.id)}
            onResume={() => void api.resumeDirectDispatch(activeCampaign.id)}
            onStop={() => void api.stopDirectDispatch(activeCampaign.id)}
          />
        )}

        {/* Main Content Viewport */}
        <main className="flex-1 p-6 max-w-[1440px] w-full mx-auto">
          {loading ? (
            <div className="space-y-6">
              <div className="h-24 bg-white border border-slate-200 rounded-lg animate-pulse" />
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-7 h-96 bg-white border border-slate-200 rounded-lg animate-pulse" />
                <div className="lg:col-span-5 h-96 bg-white border border-slate-200 rounded-lg animate-pulse" />
              </div>
            </div>
          ) : error || !activeCampaign ? (
            <div className="bg-white border border-slate-200 rounded-lg p-10 text-center space-y-3">
              <h1 className="font-display text-lg font-semibold text-slate-900">
                Could not load workspace
              </h1>
              <p className="text-sm text-slate-500">
                {error || 'No campaign available.'}
              </p>
              <button
                type="button"
                onClick={() => void loadWorkspace()}
                className="px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md"
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              {activeTab === 'composer' && (
                <ComposerView
                  campaign={activeCampaign}
                  origin={origin}
                  whatsapp={whatsapp}
                  usage={usage}
                  isDispatching={isCurrentJobRunning}
                  onUpdateCampaign={handleUpdateCampaign}
                  onUploadAttachments={async (files) => {
                    const res = await api.uploadAttachments(
                      activeCampaign.id,
                      files
                    );
                    setActiveCampaign(res.campaign);
                  }}
                  onDeleteAttachment={async (attId) => {
                    const res = await api.deleteAttachment(
                      activeCampaign.id,
                      attId
                    );
                    setActiveCampaign((prev) =>
                      prev ? { ...prev, attachments: res.attachments } : prev
                    );
                    notify('Attachment removed');
                  }}
                  onStartBatchDispatch={() => void handleStartDirectBatch()}
                  onOpenWhatsAppModal={() => setWaModalOpen(true)}
                  onNavigateToContacts={() => setActiveTab('contacts')}
                  onNavigateToTracker={() => setActiveTab('tracker')}
                  onNavigateToPolls={() => setActiveTab('polls')}
                  onNotify={notify}
                />
              )}

              {activeTab === 'polls' && (
                <PollsView
                  campaign={activeCampaign}
                  isDispatching={isCurrentJobRunning}
                  onUpdatePoll={(nextPoll) =>
                    handleUpdateCampaign({ poll: nextPoll })
                  }
                  onResetVotes={async () => {
                    const res = await api.resetPollVotes(activeCampaign.id);
                    setActiveCampaign(res.campaign);
                    notify('Cleared poll votes');
                  }}
                  onStartBatchDispatch={() => void handleStartDirectBatch()}
                  onNotify={notify}
                />
              )}

              {activeTab === 'contacts' && (
                <ContactsView
                  campaign={activeCampaign}
                  origin={origin}
                  onUpdateCountryCode={(cc) =>
                    handleUpdateCampaign({ defaultCountryCode: cc })
                  }
                  onImportContacts={async (contacts, replaceExisting) => {
                    const res = await api.importRecipients(
                      activeCampaign.id,
                      contacts,
                      replaceExisting
                    );
                    setActiveCampaign(res.campaign);
                    return {
                      added: res.added,
                      duplicates: res.duplicates,
                      invalid: res.invalid,
                    };
                  }}
                  onDeleteRecipient={async (recipientId) => {
                    await api.deleteRecipient(activeCampaign.id, recipientId);
                    setActiveCampaign((prev) =>
                      prev
                        ? {
                            ...prev,
                            recipients: prev.recipients.filter(
                              (r) => r.id !== recipientId
                            ),
                          }
                        : prev
                    );
                    notify('Number removed');
                  }}
                  onClearAllRecipients={async () => {
                    await api.clearRecipients(activeCampaign.id);
                    setActiveCampaign((prev) =>
                      prev ? { ...prev, recipients: [] } : prev
                    );
                    notify('Cleared all numbers from campaign');
                  }}
                  onLaunchSingle={(id) => void handleSendDirectSingle(id)}
                  onNotify={notify}
                />
              )}

              {activeTab === 'tracker' && (
                <TrackerView
                  campaign={activeCampaign}
                  origin={origin}
                  usage={usage}
                  recentPulseIds={recentPulseIds}
                  onSendDirectSingle={(id) => void handleSendDirectSingle(id)}
                  onBulkStatus={async (payload) => {
                    const res = await api.bulkUpdateStatus(
                      activeCampaign.id,
                      payload
                    );
                    setActiveCampaign(res.campaign);
                    notify(
                      `Updated ${res.updatedCount.toLocaleString()} numbers to ${payload.toStatus}`
                    );
                  }}
                  onStartBatchDispatch={() => void handleStartDirectBatch()}
                  onNavigateToPolls={() => setActiveTab('polls')}
                  onNotify={notify}
                />
              )}

              {activeTab === 'campaigns' && (
                <CampaignsView
                  campaigns={campaigns}
                  activeCampaignId={activeCampaign.id}
                  onSelectCampaign={(id) => {
                    void handleSelectCampaign(id);
                    setActiveTab('composer');
                  }}
                  onCreateCampaign={async (name) => {
                    const res = await api.createCampaign({
                      name,
                      defaultCountryCode: activeCampaign.defaultCountryCode,
                    });
                    setActiveCampaign(res.campaign);
                    const { campaigns: list } = await api.listCampaigns();
                    setCampaigns(list);
                    setActiveTab('composer');
                    notify(`Created campaign "${res.campaign.name}"`);
                  }}
                  onDuplicateCampaign={async (id) => {
                    const res = await api.duplicateCampaign(id);
                    setActiveCampaign(res.campaign);
                    const { campaigns: list } = await api.listCampaigns();
                    setCampaigns(list);
                    notify(`Duplicated as "${res.campaign.name}"`);
                  }}
                  onDeleteCampaign={async (id) => {
                    const res = await api.deleteCampaign(id);
                    setCampaigns(res.campaigns);
                    if (id === activeCampaign.id && res.campaigns[0]) {
                      await handleSelectCampaign(res.campaigns[0].id);
                    }
                    notify('Campaign deleted');
                  }}
                />
              )}
            </>
          )}
        </main>
      </div>

      {/* WhatsApp Linked-Device QR & Phone Pairing Modal */}
      <WhatsAppConnectModal
        open={waModalOpen}
        session={whatsapp}
        onClose={() => setWaModalOpen(false)}
        onConnectQr={async () => {
          const { whatsapp: next } = await api.connectWhatsApp();
          setWhatsapp(next);
        }}
        onPairPhone={async (phone) => {
          const { whatsapp: next } = await api.pairWhatsAppWithPhone(phone);
          setWhatsapp(next);
        }}
        onDisconnect={async () => {
          const { whatsapp: next } = await api.disconnectWhatsApp();
          setWhatsapp(next);
          notify('WhatsApp device disconnected');
        }}
      />

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 max-w-sm bg-slate-900 text-white text-xs font-medium px-4 py-3 rounded-md shadow-lg"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
