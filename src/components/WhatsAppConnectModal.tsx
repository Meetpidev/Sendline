import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  LogOut,
  QrCode,
  RefreshCw,
  Smartphone,
  X,
} from 'lucide-react';
import type { WhatsAppSessionState } from '../types';
import { formatDisplayPhone } from '../utils/whatsapp';

interface WhatsAppConnectModalProps {
  open: boolean;
  session: WhatsAppSessionState;
  onClose: () => void;
  onConnectQr: () => Promise<void>;
  onPairPhone: (phone: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
}

export function WhatsAppConnectModal({
  open,
  session,
  onClose,
  onConnectQr,
  onPairPhone,
  onDisconnect,
}: WhatsAppConnectModalProps) {
  const [linkMode, setLinkMode] = useState<'qr' | 'phone'>('qr');
  const [phoneInput, setPhoneInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (open && session.status === 'disconnected' && linkMode === 'qr') {
      void onConnectQr();
    }
  }, [open, session.status, linkMode, onConnectQr]);

  if (!open) return null;

  async function handlePairSubmit(e: React.FormEvent) {
    e.preventDefault();
    const digits = phoneInput.replace(/\D/g, '');
    if (digits.length < 7) {
      setLocalError('Enter your WhatsApp phone number with country code (e.g. 919876543210)');
      return;
    }
    setLocalError(null);
    setBusy(true);
    try {
      await onPairPhone(digits);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Pairing request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wa-connect-title"
    >
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
          <h2
            id="wa-connect-title"
            className="font-display text-base font-semibold text-slate-900"
          >
            Link WhatsApp for Direct Sending
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="p-1.5 -mr-1.5 text-slate-400 hover:text-slate-900 rounded-md transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {session.status === 'connected' ? (
            <div className="space-y-5">
              <div className="p-4 rounded-md bg-emerald-50 border border-emerald-200 flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-emerald-700 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-emerald-950">
                    WhatsApp Linked &amp; Ready
                  </div>
                  <div className="text-xs text-emerald-800 mt-1 space-y-0.5">
                    <div>{session.accountName || 'Linked Account'}</div>
                    {session.accountPhone && (
                      <div className="font-mono tabular-nums font-medium">
                        {formatDisplayPhone(session.accountPhone)}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <p className="text-xs text-slate-600 leading-relaxed">
                Messages, PDFs, images, and videos now send directly in the background without opening or redirecting to WhatsApp Web. Delivery and read receipts update live in your Delivery Tracker.
              </p>

              <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onDisconnect();
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Disconnect Device
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-xs text-slate-600 leading-relaxed">
                Link your WhatsApp once so clicking <strong>Send</strong> dispatches text, PDFs, and images directly without redirecting to any external page.
              </p>

              {/* Mode Switcher */}
              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-md">
                <button
                  type="button"
                  onClick={() => {
                    setLinkMode('qr');
                    setLocalError(null);
                    void onConnectQr();
                  }}
                  className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    linkMode === 'qr'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <QrCode className="h-3.5 w-3.5" />
                  Scan QR Code
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLinkMode('phone');
                    setLocalError(null);
                  }}
                  className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    linkMode === 'phone'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Smartphone className="h-3.5 w-3.5" />
                  Link with Phone
                </button>
              </div>

              {(localError || session.lastError) && (
                <div className="p-3 rounded-md bg-red-50 border border-red-200 text-xs text-red-700">
                  {localError || session.lastError}
                </div>
              )}

              {linkMode === 'qr' ? (
                <div className="space-y-4">
                  <div className="flex flex-col items-center justify-center p-5 rounded-md border border-slate-200 bg-slate-50 min-h-[260px]">
                    {session.qrDataUrl ? (
                      <img
                        src={session.qrDataUrl}
                        alt="WhatsApp Linked Device QR Code"
                        referrerPolicy="no-referrer"
                        className="h-56 w-56 rounded border border-slate-200 bg-white p-1"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-2.5 text-slate-500">
                        <Loader2 className="h-6 w-6 animate-spin text-emerald-700" />
                        <span className="text-xs">
                          {session.status === 'connecting'
                            ? 'Generating live WhatsApp QR code...'
                            : 'Preparing session...'}
                        </span>
                      </div>
                    )}
                  </div>

                  <ol className="text-xs text-slate-600 space-y-1.5 list-decimal list-inside">
                    <li>Open WhatsApp on your phone.</li>
                    <li>
                      Tap <strong>Settings</strong> (or menu <strong>⋮</strong>) →{' '}
                      <strong>Linked Devices</strong> → <strong>Link a Device</strong>.
                    </li>
                    <li>Point your phone camera at this QR code.</li>
                  </ol>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200">
                    <button
                      type="button"
                      onClick={() => void onConnectQr()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap shrink-0"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Refresh QR
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <form onSubmit={(e) => void handlePairSubmit(e)} className="space-y-3">
                    <div>
                      <label
                        htmlFor="pair-phone-input"
                        className="block text-xs font-medium text-slate-700 mb-1"
                      >
                        Your WhatsApp Phone Number (with country code)
                      </label>
                      <input
                        id="pair-phone-input"
                        type="text"
                        required
                        value={phoneInput}
                        onChange={(e) => setPhoneInput(e.target.value)}
                        placeholder="919876543210"
                        className="w-full h-10 rounded-md border border-slate-200 px-3 font-mono text-sm text-slate-900 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/15"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={busy || !phoneInput.trim()}
                      className="w-full h-9 inline-flex items-center justify-center gap-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors disabled:opacity-50"
                    >
                      {busy ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Requesting Code...
                        </>
                      ) : (
                        'Generate 8-Digit Pairing Code'
                      )}
                    </button>
                  </form>

                  {session.pairingCode && (
                    <div className="p-4 rounded-md bg-slate-50 border border-slate-200 text-center space-y-2">
                      <div className="text-xs text-slate-500">
                        Enter this code in WhatsApp → Linked Devices → Link with phone number:
                      </div>
                      <div className="font-mono text-2xl font-bold tracking-[0.2em] text-slate-900 select-all">
                        {session.pairingCode}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
