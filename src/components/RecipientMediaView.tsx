import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  ExternalLink,
  File as FileIcon,
  FileText,
} from 'lucide-react';
import type { AttachmentItem } from '../types';
import { formatFileSize, formatShortDateTime } from '../utils/whatsapp';

interface PublicViewPayload {
  campaignName: string;
  messageTemplate: string;
  attachments: AttachmentItem[];
  recipient: {
    id: string;
    name: string;
    phone: string;
    customFields: Record<string, string>;
    openedAt: string | null;
    openCount: number;
  };
}

interface RecipientMediaViewProps {
  campaignId: string;
  recipientId: string;
}

export function RecipientMediaView({
  campaignId,
  recipientId,
}: RecipientMediaViewProps) {
  const [data, setData] = useState<PublicViewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(
      `/api/public/view/${encodeURIComponent(campaignId)}/${encodeURIComponent(recipientId)}`
    )
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || 'Shared message link not found');
        }
        return (await res.json()) as PublicViewPayload;
      })
      .then((payload) => {
        if (active) {
          setData(payload);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Unable to load attachments');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [campaignId, recipientId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
        <div className="w-full max-w-2xl bg-white border border-slate-200 rounded-lg p-8 space-y-4">
          <div className="h-5 w-48 bg-slate-100 rounded animate-pulse" />
          <div className="h-24 w-full bg-slate-100 rounded animate-pulse" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-lg p-8 text-center space-y-3">
          <h1 className="font-display text-lg font-bold text-slate-900">
            Link Unavailable
          </h1>
          <p className="text-sm text-slate-600">{error || 'Record not found'}</p>
          <a
            href="/"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 hover:underline pt-2"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Return to Sendline Dashboard
          </a>
        </div>
      </div>
    );
  }

  const vars: Record<string, string> = {
    name: data.recipient.name || 'there',
    phone: data.recipient.phone || '',
    ...(data.recipient.customFields || {}),
  };
  const personalizedBody = (data.messageTemplate || '').replace(
    /\{\{\s*([a-zA-Z0-9_\- ]+)\s*\}\}/g,
    (_, rawKey: string) => {
      const key = rawKey.trim().toLowerCase();
      for (const [k, v] of Object.entries(vars)) {
        if (k.toLowerCase() === key) return v ?? '';
      }
      return '';
    }
  );

  return (
    <div className="min-h-screen bg-[#F8FAFC] py-10 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900">
            Sendline
          </span>
          <a
            href="/"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Dashboard
          </a>
        </div>

        <article className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <header className="px-6 py-5 border-b border-slate-200 space-y-1.5">
            <h1 className="font-display text-xl font-bold text-slate-900">
              {data.campaignName}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>
                Prepared for {data.recipient.name.trim() || `+${data.recipient.phone}`}
              </span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 text-teal-700 font-medium">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Read receipt recorded {formatShortDateTime(data.recipient.openedAt)}
              </span>
            </div>
          </header>

          {personalizedBody && (
            <div className="px-6 py-6 text-sm leading-relaxed text-slate-800 whitespace-pre-wrap border-b border-slate-200">
              {personalizedBody}
            </div>
          )}

          <div className="p-6 space-y-5">
            <h2 className="text-sm font-semibold text-slate-900">
              Attached Files ({data.attachments.length})
            </h2>

            {data.attachments.length === 0 ? (
              <p className="text-xs text-slate-500">
                No downloadable files were attached to this message.
              </p>
            ) : (
              <div className="space-y-4">
                {data.attachments.map((att) => {
                  const fileUrl = `/api/files/${encodeURIComponent(att.id)}/${encodeURIComponent(att.originalName)}`;
                  const isImage = att.mimeType.startsWith('image/');
                  const isPdf = att.mimeType === 'application/pdf';
                  const isVideo = att.mimeType.startsWith('video/');

                  return (
                    <div
                      key={att.id}
                      className="border border-slate-200 rounded-md overflow-hidden"
                    >
                      {isImage && (
                        <div className="bg-slate-50 border-b border-slate-200 flex items-center justify-center p-4">
                          <img
                            src={fileUrl}
                            alt={att.originalName}
                            referrerPolicy="no-referrer"
                            className="max-h-[420px] w-auto object-contain rounded"
                          />
                        </div>
                      )}

                      {isVideo && (
                        <div className="bg-slate-900 border-b border-slate-200">
                          <video
                            src={fileUrl}
                            controls
                            className="w-full max-h-[420px]"
                          />
                        </div>
                      )}

                      {isPdf && (
                        <div className="bg-slate-50 border-b border-slate-200">
                          <iframe
                            src={fileUrl}
                            title={att.originalName}
                            className="w-full h-[460px] border-0"
                          />
                        </div>
                      )}

                      <div className="px-4 py-3 flex items-center justify-between gap-3 bg-white">
                        <div className="flex items-center gap-3 min-w-0">
                          {isPdf ? (
                            <FileText className="h-5 w-5 text-red-600 shrink-0" />
                          ) : (
                            <FileIcon className="h-5 w-5 text-slate-500 shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-slate-900 truncate">
                              {att.originalName}
                            </div>
                            <div className="text-xs text-slate-500 tabular-nums">
                              {formatFileSize(att.size)} · {att.mimeType}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <a
                            href={fileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Open
                          </a>
                          <a
                            href={`${fileUrl}?download=1`}
                            download={att.originalName}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md whitespace-nowrap"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Download
                          </a>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </article>
      </div>
    </div>
  );
}
