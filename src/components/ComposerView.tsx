import { useRef, useState } from 'react';
import {
  Bold,
  Check,
  Code,
  Copy,
  Download,
  File as FileIcon,
  FileText,
  Italic,
  Link2,
  Paperclip,
  Send,
  Strikethrough,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import type {
  Campaign,
  CampaignPoll,
  DispatchSettings,
  MonthlyAccountUsage,
  WhatsAppSessionState,
} from '../types';
import {
  buildWaMeUrl,
  formatDisplayPhone,
  formatFileSize,
  renderPersonalizedMessage,
} from '../utils/whatsapp';
import { MonthlyLimitNotice } from './MonthlyLimitNotice';
import { PollBuilderSection } from './PollBuilderSection';

interface ComposerViewProps {
  campaign: Campaign;
  origin: string;
  whatsapp: WhatsAppSessionState;
  usage: MonthlyAccountUsage | null;
  isDispatching: boolean;
  onUpdateCampaign: (
    patch: Partial<
      Pick<Campaign, 'name' | 'message' | 'defaultCountryCode' | 'settings' | 'poll'>
    >
  ) => void;
  onUploadAttachments: (files: File[]) => Promise<void>;
  onDeleteAttachment: (attachmentId: string) => Promise<void>;
  onStartBatchDispatch: () => void;
  onOpenWhatsAppModal: () => void;
  onNavigateToContacts: () => void;
  onNavigateToTracker: () => void;
  onNavigateToPolls: () => void;
  onNotify: (msg: string) => void;
}

export function ComposerView({
  campaign,
  origin,
  whatsapp,
  usage,
  isDispatching,
  onUpdateCampaign,
  onUploadAttachments,
  onDeleteAttachment,
  onStartBatchDispatch,
  onOpenWhatsAppModal,
  onNavigateToContacts,
  onNavigateToTracker,
  onNavigateToPolls,
  onNotify,
}: ComposerViewProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [previewRecipientId, setPreviewRecipientId] = useState<string>(
    campaign.recipients[0]?.id || ''
  );
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Real-time KPI Metrics
  const total = campaign.recipients.length;
  const queuedCount = campaign.recipients.filter((r) => r.status === 'queued').length;
  const sentCount = campaign.recipients.filter((r) =>
    ['sent', 'delivered', 'read', 'opened', 'dispatched'].includes(r.status)
  ).length;
  const deliveredCount = campaign.recipients.filter((r) =>
    ['delivered', 'read', 'opened'].includes(r.status)
  ).length;
  const readCount = campaign.recipients.filter((r) =>
    ['read', 'opened'].includes(r.status)
  ).length;

  // Live poll vote aggregation for the preview bubble
  const activePollVotes = Object.values(campaign.poll?.votes || {}).filter(
    (v) => v.selectedOptions.length > 0
  );
  const pollOptionCounts = new Map<string, number>();
  for (const vote of activePollVotes) {
    for (const chosen of vote.selectedOptions) {
      pollOptionCounts.set(chosen, (pollOptionCounts.get(chosen) || 0) + 1);
    }
  }

  // Detect custom merge variables from loaded contacts
  const detectedVariables = Array.from(
    new Set([
      ...campaign.recipients.flatMap((r) => Object.keys(r.customFields || {})),
      ...(campaign.recipients.some((r) => r.name.trim()) ? ['name'] : []),
      'phone',
    ])
  ).slice(0, 8);

  const previewRecipient =
    campaign.recipients.find((r) => r.id === previewRecipientId) ||
    campaign.recipients[0] || {
      id: 'preview',
      name: '',
      phone: `${campaign.defaultCountryCode || '91'}9876543210`,
      customFields: {},
    };

  const renderedPreview = renderPersonalizedMessage(
    campaign,
    previewRecipient,
    origin
  );
  const previewWaUrl = buildWaMeUrl(previewRecipient.phone, renderedPreview);

  function wrapSelection(marker: string) {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const text = campaign.message;
    const selected = text.slice(start, end) || 'text';
    const next = `${text.slice(0, start)}${marker}${selected}${marker}${text.slice(end)}`;
    onUpdateCampaign({ message: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(
        start + marker.length,
        start + marker.length + selected.length
      );
    });
  }

  function insertVariable(varName: string) {
    const el = textareaRef.current;
    const token = `{{${varName}}}`;
    if (!el) {
      onUpdateCampaign({ message: `${campaign.message}${token}` });
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = `${campaign.message.slice(0, start)}${token}${campaign.message.slice(end)}`;
    onUpdateCampaign({ message: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function handleFilesChosen(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    try {
      await onUploadAttachments(list);
      onNotify(
        `Attached ${list.length} ${list.length === 1 ? 'file' : 'files'} — will be sent natively in WhatsApp`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'File upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function copyText(key: string, text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(key);
      onNotify(`Copied ${label}`);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      onNotify('Clipboard access blocked by browser');
    }
  }

  function updateSettings(patch: Partial<DispatchSettings>) {
    onUpdateCampaign({
      settings: {
        ...campaign.settings,
        ...patch,
      },
    });
  }

  return (
    <div className="space-y-6">
      {/* 4-Column Horizontal KPI Strip */}
      <section
        aria-label="Campaign delivery summary"
        className="bg-white border border-slate-200 rounded-lg grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 divide-x divide-slate-200"
      >
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Total Numbers</div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="font-display text-2xl font-bold tabular-nums text-slate-900">
              {total.toLocaleString()}
            </span>
            <span className="text-xs text-slate-500 tabular-nums">
              {queuedCount.toLocaleString()} queued
            </span>
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Sent</div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="font-display text-2xl font-bold tabular-nums text-blue-700">
              {sentCount.toLocaleString()}
            </span>
            <span className="text-xs text-slate-500 tabular-nums">
              {total > 0 ? `${Math.round((sentCount / total) * 100)}%` : '0%'}
            </span>
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Delivered</div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="font-display text-2xl font-bold tabular-nums text-emerald-700">
              {deliveredCount.toLocaleString()}
            </span>
            <span className="text-xs text-slate-500 tabular-nums">
              {total > 0 ? `${Math.round((deliveredCount / total) * 100)}%` : '0%'}
            </span>
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Read / Opened</div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="font-display text-2xl font-bold tabular-nums text-teal-700">
              {readCount.toLocaleString()}
            </span>
            <button
              type="button"
              onClick={onNavigateToTracker}
              className="text-xs font-medium text-emerald-700 hover:text-emerald-800 hover:underline whitespace-nowrap shrink-0"
            >
              View tracker
            </button>
          </div>
        </div>
      </section>

      {/* Monthly WhatsApp Account Limit Notice */}
      <MonthlyLimitNotice usage={usage} />

      {/* Main 2-Column Split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Message Composer & File Attachments */}
        <div className="lg:col-span-7 space-y-6">
          <section className="bg-white border border-slate-200 rounded-lg">
            <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <label htmlFor="campaign-name-input" className="sr-only">
                  Campaign Name
                </label>
                <input
                  id="campaign-name-input"
                  type="text"
                  value={campaign.name}
                  onChange={(e) => onUpdateCampaign({ name: e.target.value })}
                  placeholder="Untitled Campaign"
                  className="w-full font-display text-base font-semibold text-slate-900 bg-transparent border-0 p-0 focus:outline-none focus:ring-0 placeholder:text-slate-400"
                />
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500 shrink-0 tabular-nums">
                <span>{campaign.message.length.toLocaleString()} chars</span>
              </div>
            </div>

            {/* Formatting & Variable Toolbar */}
            <div className="px-6 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => wrapSelection('*')}
                  title="Bold (*text*)"
                  className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 rounded transition-colors"
                >
                  <Bold className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => wrapSelection('_')}
                  title="Italic (_text_)"
                  className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 rounded transition-colors"
                >
                  <Italic className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => wrapSelection('~')}
                  title="Strikethrough (~text~)"
                  className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 rounded transition-colors"
                >
                  <Strikethrough className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => wrapSelection('```')}
                  title="Monospace (```text```)"
                  className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 rounded transition-colors"
                >
                  <Code className="h-4 w-4" />
                </button>
              </div>

              {detectedVariables.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-slate-500 mr-1">Optional field:</span>
                  {detectedVariables.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => insertVariable(v)}
                      className="px-2 py-1 text-xs font-mono text-slate-700 bg-white border border-slate-200 hover:border-emerald-600 hover:text-emerald-800 rounded transition-colors whitespace-nowrap shrink-0"
                    >
                      {`{{${v}}}`}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="p-6">
              <label htmlFor="message-body" className="sr-only">
                WhatsApp Message Body
              </label>
              <textarea
                ref={textareaRef}
                id="message-body"
                rows={7}
                value={campaign.message}
                onChange={(e) => onUpdateCampaign({ message: e.target.value })}
                placeholder="Write your WhatsApp message here. When attached with PDFs or images, this text is sent as the caption."
                className="w-full resize-y rounded-md border border-slate-200 bg-white p-3.5 text-sm leading-relaxed text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/15"
              />
            </div>

            {/* Native File Attachments Section */}
            <div className="px-6 py-5 border-t border-slate-200 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    Attachments (PDF, Images, Videos &amp; Documents)
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Sent natively inside WhatsApp as real photos, PDF documents, or media files.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  {uploading ? 'Uploading...' : 'Add Files'}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.zip,video/*,audio/*"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) {
                      void handleFilesChosen(e.target.files);
                      e.target.value = '';
                    }
                  }}
                />
              </div>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  if (e.dataTransfer.files?.length) {
                    void handleFilesChosen(e.dataTransfer.files);
                  }
                }}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                className={`cursor-pointer rounded-md border border-dashed px-4 py-6 text-center transition-colors ${
                  isDragging
                    ? 'border-emerald-600 bg-emerald-50/50'
                    : 'border-slate-300 bg-slate-50/60 hover:border-slate-400 hover:bg-slate-50'
                }`}
              >
                <Upload className="h-5 w-5 text-slate-400 mx-auto mb-2" />
                <div className="text-sm font-medium text-slate-700">
                  {uploading
                    ? 'Uploading attachments...'
                    : 'Drop PDFs, images, videos, or documents here'}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  Up to 25 MB per file · Delivered directly inside each WhatsApp chat
                </div>
              </div>

              {campaign.attachments.length > 0 && (
                <div className="divide-y divide-slate-200 border-t border-b border-slate-200">
                  {campaign.attachments.map((att) => {
                    const isImage = att.mimeType.startsWith('image/');
                    const isPdf = att.mimeType === 'application/pdf';
                    const fileUrl = `/api/files/${encodeURIComponent(att.id)}/${encodeURIComponent(att.originalName)}`;
                    return (
                      <div
                        key={att.id}
                        className="py-3 flex items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {isImage ? (
                            <img
                              src={fileUrl}
                              alt={att.originalName}
                              referrerPolicy="no-referrer"
                              className="h-10 w-10 rounded object-cover border border-slate-200 shrink-0 bg-slate-100"
                            />
                          ) : (
                            <div className="h-10 w-10 rounded bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-500 shrink-0">
                              {isPdf ? (
                                <FileText className="h-5 w-5 text-red-600" />
                              ) : (
                                <FileIcon className="h-5 w-5" />
                              )}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-slate-900 truncate">
                              {att.originalName}
                            </div>
                            <div className="text-xs text-slate-500 flex items-center gap-2 tabular-nums">
                              <span>{formatFileSize(att.size)}</span>
                              <span aria-hidden="true">·</span>
                              <span>
                                {isPdf
                                  ? 'PDF Document'
                                  : isImage
                                    ? 'Image'
                                    : att.mimeType.split('/')[1]?.toUpperCase() || 'File'}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <a
                            href={`${fileUrl}?download=1`}
                            download={att.originalName}
                            title="Download file"
                            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded transition-colors"
                          >
                            <Download className="h-4 w-4" />
                          </a>
                          <button
                            type="button"
                            onClick={() => void onDeleteAttachment(att.id)}
                            title="Remove attachment"
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {campaign.attachments.length > 0 && (
                <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={campaign.settings.includeMediaLink}
                    onChange={(e) =>
                      updateSettings({ includeMediaLink: e.target.checked })
                    }
                    className="h-4 w-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                  />
                  <span>Also append backup web download link to message text</span>
                </label>
              )}
            </div>

            {/* Native WhatsApp Poll Builder Section */}
            <div className="px-6 py-5 border-t border-slate-200">
              <PollBuilderSection
                poll={campaign.poll}
                onChangePoll={(nextPoll: CampaignPoll) =>
                  onUpdateCampaign({ poll: nextPoll })
                }
                onViewResults={onNavigateToPolls}
              />
            </div>
          </section>
        </div>

        {/* Right Column: Live Preview & Direct Zero-Redirect Sending Panel */}
        <div className="lg:col-span-5 space-y-6">
          <section className="bg-white border border-slate-200 rounded-lg">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-900">
                Message Preview
              </h2>
              {campaign.recipients.length > 0 && (
                <select
                  aria-label="Preview recipient"
                  value={previewRecipient.id}
                  onChange={(e) => setPreviewRecipientId(e.target.value)}
                  className="max-w-[190px] h-8 rounded border border-slate-200 bg-slate-50 px-2 text-xs text-slate-700 focus:border-emerald-600 focus:outline-none truncate"
                >
                  {campaign.recipients.slice(0, 100).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name.trim() ? `${r.name} (+${r.phone})` : `+${r.phone}`}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* WhatsApp Bubble Preview (including native attachment previews) */}
            <div className="p-5 bg-[#EFEAE2]">
              <div className="text-[11px] font-mono text-slate-600 mb-2 flex items-center justify-between">
                <span>
                  To:{' '}
                  {previewRecipient.name.trim() ||
                    formatDisplayPhone(previewRecipient.phone)}
                </span>
                <span className="tabular-nums">
                  {formatDisplayPhone(previewRecipient.phone)}
                </span>
              </div>

              <div className="ml-auto max-w-[92%] rounded-lg rounded-tr-none bg-[#D9FDD3] p-2.5 shadow-xs space-y-2">
                {campaign.attachments.map((att) => {
                  const fileUrl = `/api/files/${encodeURIComponent(att.id)}/${encodeURIComponent(att.originalName)}`;
                  if (att.mimeType.startsWith('image/')) {
                    return (
                      <img
                        key={att.id}
                        src={fileUrl}
                        alt={att.originalName}
                        referrerPolicy="no-referrer"
                        className="w-full max-h-48 object-cover rounded border border-emerald-200/60"
                      />
                    );
                  }
                  return (
                    <div
                      key={att.id}
                      className="flex items-center gap-2.5 px-3 py-2 rounded bg-white/80 text-xs text-slate-800"
                    >
                      <FileText className="h-4 w-4 text-red-600 shrink-0" />
                      <div className="min-w-0">
                        <div className="font-medium truncate">{att.originalName}</div>
                        <div className="text-[11px] text-slate-500 tabular-nums">
                          {formatFileSize(att.size)}
                        </div>
                      </div>
                    </div>
                  );
                })}

                <div className="px-1 text-sm text-slate-900 leading-relaxed whitespace-pre-wrap break-words">
                  {renderedPreview || (
                    <span className="text-slate-500 italic">
                      Your WhatsApp message will appear here...
                    </span>
                  )}
                </div>

                <div className="px-1 text-right text-[11px] font-mono text-slate-500 tabular-nums">
                  {new Date().toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>

              {/* Native WhatsApp Poll Bubble Preview with Live Vote Results */}
              {(campaign.poll?.enabled || activePollVotes.length > 0) && (
                <div className="mt-2.5 ml-auto max-w-[92%] rounded-lg rounded-tr-none bg-[#D9FDD3] p-3 shadow-xs space-y-2.5">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">
                      {campaign.poll.question.trim() || 'Poll question preview...'}
                    </div>
                    <div className="text-[11px] text-slate-600 mt-0.5 flex items-center justify-between gap-2">
                      <span>
                        {campaign.poll.selectableCount === 1
                          ? 'Select one'
                          : campaign.poll.selectableCount === 0
                            ? 'Select one or more'
                            : `Select up to ${campaign.poll.selectableCount}`}
                      </span>
                      <span className="font-mono tabular-nums text-emerald-900 font-medium">
                        {activePollVotes.length.toLocaleString()}{' '}
                        {activePollVotes.length === 1 ? 'vote' : 'votes'}
                      </span>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {campaign.poll.options
                      .map((o) => o.trim())
                      .filter(Boolean)
                      .map((opt, idx) => {
                        const voteCount = pollOptionCounts.get(opt) || 0;
                        const votePct =
                          activePollVotes.length > 0
                            ? Math.round((voteCount / activePollVotes.length) * 100)
                            : 0;
                        return (
                          <div key={idx} className="space-y-1">
                            <div className="flex items-center justify-between gap-2 text-xs text-slate-900">
                              <span className="flex items-center gap-2 min-w-0">
                                <span
                                  className={`h-3.5 w-3.5 rounded-full border shrink-0 flex items-center justify-center ${
                                    voteCount > 0
                                      ? 'border-emerald-700 bg-emerald-700 text-white'
                                      : 'border-emerald-700/60'
                                  }`}
                                >
                                  {voteCount > 0 && <Check className="h-2.5 w-2.5" />}
                                </span>
                                <span className="truncate font-medium">{opt}</span>
                              </span>
                              <span className="font-mono text-[11px] text-slate-700 tabular-nums shrink-0">
                                {voteCount}
                                {activePollVotes.length > 0 ? ` (${votePct}%)` : ''}
                              </span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-emerald-900/10 overflow-hidden">
                              <div
                                className="h-full bg-emerald-700 transition-all duration-200"
                                style={{ width: `${votePct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                  </div>
                  <button
                    type="button"
                    onClick={onNavigateToPolls}
                    className="w-full pt-1.5 border-t border-emerald-900/10 text-center text-xs font-semibold text-emerald-800 hover:text-emerald-950 hover:underline transition-colors"
                  >
                    {activePollVotes.length > 0
                      ? `View live poll results (${activePollVotes.length})`
                      : 'View poll results'}
                  </button>
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between gap-2 text-xs">
              <span className="text-slate-500 font-mono truncate">
                wa.me/{previewRecipient.phone}
              </span>
              <button
                type="button"
                onClick={() => void copyText('preview-wa', previewWaUrl, 'wa.me link')}
                className="inline-flex items-center gap-1 font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap shrink-0"
              >
                {copiedId === 'preview-wa' ? (
                  <Check className="h-3.5 w-3.5 text-emerald-700" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                Copy wa.me Link
              </button>
            </div>
          </section>

          {/* Direct One-Click Sending Panel (Zero Redirects) */}
          <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Direct One-Click Send (No Redirects)
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Sends messages, PDFs, and images directly from this page in the background without opening WhatsApp Web.
                </p>
              </div>
            </div>

            {/* Linked WhatsApp Account Row */}
            <div className="py-3 border-t border-b border-slate-200 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-700">
                  WhatsApp Sender Account
                </div>
                <div className="text-xs text-slate-500 mt-0.5 truncate">
                  {whatsapp.status === 'connected' ? (
                    <span className="text-emerald-700 font-medium font-mono tabular-nums">
                      Linked ({formatDisplayPhone(whatsapp.accountPhone || '')})
                    </span>
                  ) : (
                    <span>Not linked yet — scan QR once to send directly</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={onOpenWhatsAppModal}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap shrink-0"
              >
                <Link2 className="h-3.5 w-3.5" />
                {whatsapp.status === 'connected' ? 'Manage' : 'Link WhatsApp'}
              </button>
            </div>

            {/* Safe Sending Delay */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <label
                  htmlFor="interval-select"
                  className="block text-xs font-medium text-slate-700"
                >
                  Delay Between Numbers
                </label>
                <span className="text-xs text-slate-500">
                  Pacing between each direct send for account safety
                </span>
              </div>
              <select
                id="interval-select"
                value={campaign.settings.intervalSeconds}
                onChange={(e) =>
                  updateSettings({ intervalSeconds: Number(e.target.value) })
                }
                className="h-9 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-mono tabular-nums text-slate-900 focus:border-emerald-600 focus:outline-none"
              >
                <option value={2}>2 seconds</option>
                <option value={3}>3 seconds</option>
                <option value={5}>5 seconds</option>
                <option value={8}>8 seconds</option>
                <option value={12}>12 seconds</option>
              </select>
            </div>

            <div className="pt-2 border-t border-slate-200 flex flex-col gap-2.5">
              {total === 0 ? (
                <button
                  type="button"
                  onClick={onNavigateToContacts}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap"
                >
                  <Users className="h-4 w-4" />
                  Upload Excel / CSV Numbers to Begin
                </button>
              ) : (
                <button
                  type="button"
                  disabled={queuedCount === 0 || isDispatching}
                  onClick={onStartBatchDispatch}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  <Send className="h-4 w-4" />
                  {isDispatching
                    ? 'Sending in Background...'
                    : queuedCount > 0
                      ? `Send to All Queued (${queuedCount.toLocaleString()})`
                      : 'All Numbers Processed'}
                </button>
              )}

              {total > 0 && queuedCount === 0 && (
                <button
                  type="button"
                  onClick={onNavigateToTracker}
                  className="w-full text-center text-xs font-medium text-emerald-700 hover:text-emerald-800 hover:underline py-1"
                >
                  Open Delivery Tracker to view receipts or re-queue
                </button>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
