import crypto from 'node:crypto';
import { Boom } from '@hapi/boom';
import {
  Browsers,
  DisconnectReason,
  decryptPollVote,
  fetchLatestBaileysVersion,
  getKeyAuthor,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  normalizeMessageContent,
  type AnyMessageContent,
  type CacheStore,
  type proto,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import type { PollDispatchRecord, WhatsAppSessionState } from '../src/types';
import {
  clearPostgresAuthState,
  hasSavedPostgresAuth,
  usePostgresAuthState,
} from './pgAuthState.ts';

// libsignal-node writes directly to console.error/warn on transient Signal ratchet
// retries even when Baileys immediately catches and recovers via WhatsApp retry receipts.
const LIBSIGNAL_NOISE_PATTERNS = [
  'Failed to decrypt message with any known session',
  'Session error:Error: Bad MAC',
  'Session error: Error: Bad MAC',
  'Decrypted message with closed session',
  'Closing stale open session',
  'Closing open session in favor of incoming prekey bundle',
  'Removing old closed session',
];

let signalLogFilterInstalled = false;
function installSignalLogFilter(): void {
  if (signalLogFilterInstalled) return;
  signalLogFilterInstalled = true;

  const isLibsignalNoise = (args: unknown[]): boolean => {
    const first = typeof args[0] === 'string' ? args[0] : String(args[0] ?? '');
    return LIBSIGNAL_NOISE_PATTERNS.some((pattern) => first.includes(pattern));
  };

  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (isLibsignalNoise(args)) return;
    origError(...args);
  };

  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    if (isLibsignalNoise(args)) return;
    origWarn(...args);
  };
}

function createMemoryCacheStore(): CacheStore {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      map.set(key, value);
      if (map.size > 2000) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
    del(key: string): void {
      map.delete(key);
    },
    flushAll(): void {
      map.clear();
    },
  };
}

installSignalLogFilter();

export type ReceiptStatus = 'sent' | 'delivered' | 'read';

export interface SentPollMeta {
  pollMsgId: string;
  secretBase64: string;
  creatorJid: string;
  creatorLid?: string;
  targetJid: string;
  options: string[];
}

export interface PollPayloadInput {
  question: string;
  options: string[];
  selectableCount: number;
}

export interface AttachmentPayloadInput {
  originalName: string;
  mimeType: string;
  buffer: Buffer;
}

interface WhatsAppManagerOptions {
  userId: string;
  getPollRecord: (pollMsgId: string) => Promise<PollDispatchRecord | undefined>;
  onStatusChange: (state: WhatsAppSessionState) => void;
  onMessageReceipt: (messageId: string, status: ReceiptStatus) => void | Promise<void>;
  onPollVote: (pollMsgId: string, selectedOptions: string[]) => void | Promise<void>;
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeCandidateJid(raw?: string | null): string {
  if (!raw) return '';
  try {
    return jidNormalizedUser(raw);
  } catch {
    return raw.split(':')[0];
  }
}

export class WhatsAppManager {
  private userId: string;
  private getPollRecord: (
    pollMsgId: string
  ) => Promise<PollDispatchRecord | undefined>;
  private onStatusChange: (state: WhatsAppSessionState) => void;
  private onMessageReceipt: (
    messageId: string,
    status: ReceiptStatus
  ) => void | Promise<void>;
  private onPollVote: (
    pollMsgId: string,
    selectedOptions: string[]
  ) => void | Promise<void>;
  private sock: WASocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private manualDisconnect = false;
  private pendingPairingPhone: string | null = null;
  private pairingRequested = false;
  private msgRetryCounterCache: CacheStore = createMemoryCacheStore();
  private sentMessageCache = new Map<string, proto.IMessage>();

  private state: WhatsAppSessionState = {
    status: 'disconnected',
    qrDataUrl: null,
    pairingCode: null,
    accountName: null,
    accountPhone: null,
    lastError: null,
  };

  constructor(options: WhatsAppManagerOptions) {
    this.userId = options.userId;
    this.getPollRecord = options.getPollRecord;
    this.onStatusChange = options.onStatusChange;
    this.onMessageReceipt = options.onMessageReceipt;
    this.onPollVote = options.onPollVote;
  }

  public getState(): WhatsAppSessionState {
    return { ...this.state };
  }

  public isConnected(): boolean {
    return this.state.status === 'connected' && this.sock !== null;
  }

  public async hasSavedCredentials(): Promise<boolean> {
    try {
      return await hasSavedPostgresAuth(this.userId);
    } catch {
      return false;
    }
  }

  private updateState(patch: Partial<WhatsAppSessionState>): void {
    this.state = { ...this.state, ...patch };
    this.onStatusChange(this.getState());
  }

  public async autoRestoreIfLinked(): Promise<void> {
    if (this.sock || this.state.status === 'connecting') return;
    if (await this.hasSavedCredentials()) {
      await this.connect();
    }
  }

  private rememberSentMessage(
    msgId?: string | null,
    message?: proto.IMessage | null
  ): void {
    if (!msgId || !message) return;
    this.sentMessageCache.set(msgId, message);
    if (this.sentMessageCache.size > 1000) {
      const oldest = this.sentMessageCache.keys().next().value;
      if (oldest) this.sentMessageCache.delete(oldest);
    }
  }

  private matchSelectedOptionHashes(
    selectedHashes: Uint8Array[],
    options: string[]
  ): string[] {
    const optionHashMap = new Map<string, string>();
    for (const opt of options) {
      optionHashMap.set(sha256Hex(opt), opt);
    }
    const chosen: string[] = [];
    for (const hashBytes of selectedHashes) {
      const hex = Buffer.from(hashBytes).toString('hex');
      const matched = optionHashMap.get(hex);
      if (matched && !chosen.includes(matched)) {
        chosen.push(matched);
      }
    }
    return chosen;
  }

  public async connect(pairingPhone?: string): Promise<WhatsAppSessionState> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const cleanPairPhone = pairingPhone ? pairingPhone.replace(/\D/g, '') : null;
    if (cleanPairPhone) {
      if (this.sock) {
        this.manualDisconnect = true;
        try {
          this.sock.end(undefined);
        } catch {
          // ignore
        }
        this.sock = null;
      }
      await this.clearAuthState();
      this.pendingPairingPhone = cleanPairPhone;
      this.pairingRequested = false;
    } else {
      this.pendingPairingPhone = null;
      this.pairingRequested = false;
      if (
        this.sock &&
        (this.state.status === 'connected' || this.state.status === 'qr_ready')
      ) {
        return this.getState();
      }
    }

    this.manualDisconnect = false;
    this.updateState({
      status: 'connecting',
      qrDataUrl: null,
      pairingCode: null,
      lastError: null,
    });

    try {
      const { state: authState, saveCreds } = await usePostgresAuthState(
        this.userId
      );
      let version: [number, number, number] = [2, 3000, 1027934701];
      try {
        const fetched = await fetchLatestBaileysVersion();
        version = fetched.version;
      } catch {
        // Fallback to bundled version
      }

      const logger = pino({ level: 'silent' });
      const sock = makeWASocket({
        version,
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, logger),
        },
        logger,
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        msgRetryCounterCache: this.msgRetryCounterCache,
        shouldIgnoreJid: (jid) =>
          !jid ||
          Boolean(isJidBroadcast(jid)) ||
          Boolean(isJidNewsletter(jid)) ||
          Boolean(isJidGroup(jid)) ||
          jid === 'status@broadcast',
        getMessage: async (key) => {
          if (!key.id) return undefined;
          return this.sentMessageCache.get(key.id);
        },
      });

      this.sock = sock;

      sock.ev.on('creds.update', () => {
        void saveCreds().catch((err) => {
          console.error('Failed to persist WhatsApp creds to PostgreSQL:', err);
        });
      });

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          if (
            this.pendingPairingPhone &&
            !this.pairingRequested &&
            !authState.creds.registered
          ) {
            this.pairingRequested = true;
            try {
              const code = await sock.requestPairingCode(this.pendingPairingPhone);
              const formatted =
                code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
              this.updateState({
                status: 'qr_ready',
                qrDataUrl: null,
                pairingCode: formatted,
                lastError: null,
              });
            } catch (err) {
              this.updateState({
                status: 'disconnected',
                pairingCode: null,
                lastError:
                  err instanceof Error
                    ? `Pairing code failed: ${err.message}`
                    : 'Could not request pairing code',
              });
            }
          } else if (!this.pendingPairingPhone) {
            try {
              const qrDataUrl = await QRCode.toDataURL(qr, {
                width: 280,
                margin: 2,
                color: {
                  dark: '#0F172A',
                  light: '#FFFFFF',
                },
              });
              this.updateState({
                status: 'qr_ready',
                qrDataUrl,
                pairingCode: null,
                lastError: null,
              });
            } catch (err) {
              console.error('QR generation error:', err);
            }
          }
        }

        if (connection === 'open') {
          this.pendingPairingPhone = null;
          this.pairingRequested = false;
          const rawId = sock.user?.id || '';
          const phone = rawId.split(':')[0].split('@')[0] || null;
          this.updateState({
            status: 'connected',
            qrDataUrl: null,
            pairingCode: null,
            accountName: sock.user?.name || 'WhatsApp Linked Device',
            accountPhone: phone,
            lastError: null,
          });
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as Boom | undefined)?.output
            ?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          if (this.sock === sock) {
            this.sock = null;
          }

          if (this.manualDisconnect) {
            this.updateState({
              status: 'disconnected',
              qrDataUrl: null,
              pairingCode: null,
              accountName: null,
              accountPhone: null,
              lastError: null,
            });
            return;
          }

          if (loggedOut) {
            await this.clearAuthState();
            this.updateState({
              status: 'disconnected',
              qrDataUrl: null,
              pairingCode: null,
              accountName: null,
              accountPhone: null,
              lastError:
                'WhatsApp session was logged out from your phone. Scan QR to link again.',
            });
            return;
          }

          const shouldAutoReconnect =
            statusCode === DisconnectReason.restartRequired ||
            (await this.hasSavedCredentials());

          if (shouldAutoReconnect) {
            this.updateState({
              status: 'connecting',
              lastError: null,
            });
            this.reconnectTimer = setTimeout(() => {
              void this.connect();
            }, 1500);
          } else {
            this.updateState({
              status: 'disconnected',
              qrDataUrl: null,
              pairingCode: null,
              lastError:
                (lastDisconnect?.error as Error | undefined)?.message ||
                'Connection closed. Click Connect WhatsApp to try again.',
            });
          }
        }
      });

      // Real-time WhatsApp delivery & read receipts (+ fallback pollUpdates if emitted)
      sock.ev.on('messages.update', (updates) => {
        void (async () => {
          for (const item of updates) {
            const msgId = item.key?.id;
            const status = item.update?.status;
            if (msgId && typeof status === 'number') {
              if (status >= 4) {
                await this.onMessageReceipt(msgId, 'read');
              } else if (status === 3) {
                await this.onMessageReceipt(msgId, 'delivered');
              } else if (status === 2) {
                await this.onMessageReceipt(msgId, 'sent');
              }
            }

            const pollUpdates = item.update?.pollUpdates;
            if (msgId && Array.isArray(pollUpdates) && pollUpdates.length > 0) {
              const record = await this.getPollRecord(msgId);
              if (record) {
                const latest = pollUpdates[pollUpdates.length - 1];
                const hashes = latest?.vote?.selectedOptions || [];
                const chosen = this.matchSelectedOptionHashes(hashes, record.options);
                await this.onPollVote(msgId, chosen);
              }
            }
          }
        })().catch((err) => {
          console.error('Error handling messages.update:', err);
        });
      });

      // Real-time incoming encrypted WhatsApp Poll Votes
      sock.ev.on('messages.upsert', ({ messages }) => {
        void (async () => {
          const meId = normalizeCandidateJid(sock.user?.id);
          const meLid = normalizeCandidateJid(
            (sock.user as { lid?: string } | undefined)?.lid
          );

          for (const msg of messages) {
            const rawMsg = msg.message;
            const content = normalizeMessageContent(rawMsg);
            const pollUpdate =
              content?.pollUpdateMessage ||
              rawMsg?.pollUpdateMessage ||
              rawMsg?.deviceSentMessage?.message?.pollUpdateMessage;

            if (!pollUpdate?.vote || !pollUpdate.pollCreationMessageKey?.id) {
              continue;
            }

            const pollMsgId = pollUpdate.pollCreationMessageKey.id;
            const record = await this.getPollRecord(pollMsgId);
            if (!record) {
              continue;
            }

            const pollEncKey = Buffer.from(record.secretBase64, 'base64');

            const extKey = msg.key as {
              remoteJid?: string | null;
              participant?: string | null;
              remoteJidAlt?: string | null;
              participantAlt?: string | null;
            };
            const extCreationKey = pollUpdate.pollCreationMessageKey as {
              remoteJid?: string | null;
              participant?: string | null;
              remoteJidAlt?: string | null;
              participantAlt?: string | null;
            };

            const creatorCandidates = Array.from(
              new Set(
                [
                  record.creatorJid,
                  record.creatorLid,
                  meId,
                  meLid,
                  getKeyAuthor(pollUpdate.pollCreationMessageKey, meId),
                  extCreationKey.participant,
                  extCreationKey.participantAlt,
                  extCreationKey.remoteJid,
                  extCreationKey.remoteJidAlt,
                ]
                  .map((j) => normalizeCandidateJid(j))
                  .filter(Boolean)
              )
            );

            const voterCandidates = Array.from(
              new Set(
                [
                  getKeyAuthor(msg.key, meId),
                  extKey.participant,
                  extKey.participantAlt,
                  extKey.remoteJid,
                  extKey.remoteJidAlt,
                  record.targetJid,
                  meId,
                  meLid,
                  record.creatorJid,
                  record.creatorLid,
                ]
                  .map((j) => normalizeCandidateJid(j))
                  .filter(Boolean)
              )
            );

            let decryptedSelectedHashes: Uint8Array[] | null = null;
            outer: for (const pollCreatorJid of creatorCandidates) {
              for (const voterJid of voterCandidates) {
                try {
                  const decoded = decryptPollVote(pollUpdate.vote, {
                    pollEncKey,
                    pollCreatorJid,
                    pollMsgId,
                    voterJid,
                  });
                  decryptedSelectedHashes = decoded.selectedOptions || [];
                  break outer;
                } catch {
                  // Try next PN/LID pair
                }
              }
            }

            if (!decryptedSelectedHashes) {
              continue;
            }

            const chosenOptions = this.matchSelectedOptionHashes(
              decryptedSelectedHashes,
              record.options
            );
            await this.onPollVote(pollMsgId, chosenOptions);
          }
        })().catch((err) => {
          console.error('Error handling poll vote upsert:', err);
        });
      });

      return this.getState();
    } catch (err) {
      this.updateState({
        status: 'disconnected',
        qrDataUrl: null,
        pairingCode: null,
        lastError:
          err instanceof Error
            ? err.message
            : 'Failed to initialize WhatsApp connection',
      });
      return this.getState();
    }
  }

  private async clearAuthState(): Promise<void> {
    try {
      await clearPostgresAuthState(this.userId);
    } catch (err) {
      console.error('Failed to clear PostgreSQL WhatsApp auth state:', err);
    }
  }

  public async disconnect(): Promise<WhatsAppSessionState> {
    this.manualDisconnect = true;
    this.pendingPairingPhone = null;
    this.pairingRequested = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        try {
          this.sock.end(undefined);
        } catch {
          // ignore
        }
      }
      this.sock = null;
    }

    await this.clearAuthState();
    this.updateState({
      status: 'disconnected',
      qrDataUrl: null,
      pairingCode: null,
      accountName: null,
      accountPhone: null,
      lastError: null,
    });
    return this.getState();
  }

  public async sendMessage(params: {
    phoneDigits: string;
    text: string;
    attachments: AttachmentPayloadInput[];
    poll?: PollPayloadInput | null;
  }): Promise<{ jid: string; messageIds: string[]; sentPoll?: SentPollMeta }> {
    const sock = this.sock;
    if (!sock || this.state.status !== 'connected') {
      throw new Error(
        'WhatsApp is not connected. Scan the QR code in Link WhatsApp first.'
      );
    }

    const digits = params.phoneDigits.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      throw new Error('Invalid phone number format');
    }

    let targetJid = `${digits}@s.whatsapp.net`;
    try {
      const results = await sock.onWhatsApp(digits);
      const match = Array.isArray(results) ? results[0] : undefined;
      if (match && match.exists === false) {
        throw new Error('Number is not registered on WhatsApp');
      }
      if (match?.jid) {
        targetJid = match.jid;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('not registered')) {
        throw err;
      }
    }

    const sentIds: string[] = [];
    const trimmedText = (params.text || '').trim();
    const validAttachments = params.attachments.filter(
      (att) => att.buffer && att.buffer.length > 0
    );
    const hasValidPoll = Boolean(
      params.poll &&
        params.poll.question.trim() &&
        params.poll.options.filter((o) => o.trim()).length >= 2
    );

    if (!trimmedText && validAttachments.length === 0 && !hasValidPoll) {
      throw new Error(
        'Enter a message, attach a file, or enable a poll before sending'
      );
    }

    // 1. Send text & native attachments if present
    if (validAttachments.length === 0 && trimmedText) {
      const res = await sock.sendMessage(targetJid, { text: trimmedText });
      if (res?.key?.id) {
        sentIds.push(res.key.id);
        this.rememberSentMessage(res.key.id, res.message);
      }
    } else if (validAttachments.length > 0) {
      let textAlreadySentAsCaption = false;
      const firstAtt = validAttachments[0];
      const firstSupportsCaption = !firstAtt.mimeType.startsWith('audio/');

      if (trimmedText && !firstSupportsCaption) {
        const textRes = await sock.sendMessage(targetJid, { text: trimmedText });
        if (textRes?.key?.id) {
          sentIds.push(textRes.key.id);
          this.rememberSentMessage(textRes.key.id, textRes.message);
        }
        textAlreadySentAsCaption = true;
      }

      for (let i = 0; i < validAttachments.length; i++) {
        const att = validAttachments[i];
        const caption =
          !textAlreadySentAsCaption && i === 0 && trimmedText
            ? trimmedText
            : undefined;

        let payload: AnyMessageContent;
        if (att.mimeType.startsWith('image/')) {
          payload = { image: att.buffer, mimetype: att.mimeType, caption };
        } else if (att.mimeType.startsWith('video/')) {
          payload = { video: att.buffer, mimetype: att.mimeType, caption };
        } else if (att.mimeType.startsWith('audio/')) {
          payload = { audio: att.buffer, mimetype: att.mimeType, ptt: false };
        } else {
          payload = {
            document: att.buffer,
            mimetype: att.mimeType || 'application/octet-stream',
            fileName: att.originalName,
            caption,
          };
        }

        const res = await sock.sendMessage(targetJid, payload);
        if (res?.key?.id) {
          sentIds.push(res.key.id);
          this.rememberSentMessage(res.key.id, res.message);
        }
        if (caption) textAlreadySentAsCaption = true;

        if (i < validAttachments.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 450));
        }
      }
    }

    // 2. Send native WhatsApp Poll if enabled
    let sentPoll: SentPollMeta | undefined;
    if (hasValidPoll && params.poll) {
      if (sentIds.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
      const cleanOptions = params.poll.options
        .map((o) => o.trim())
        .filter(Boolean)
        .slice(0, 12);
      const selectableCount = Math.max(
        0,
        Math.min(params.poll.selectableCount, cleanOptions.length)
      );
      const messageSecret = crypto.randomBytes(32);

      const pollRes = await sock.sendMessage(targetJid, {
        poll: {
          name: params.poll.question.trim(),
          values: cleanOptions,
          selectableCount,
          messageSecret,
        },
      });

      const pollMsgId = pollRes?.key?.id;
      if (pollMsgId) {
        sentIds.push(pollMsgId);
        this.rememberSentMessage(pollMsgId, pollRes.message);
        const actualSecret =
          pollRes?.message?.messageContextInfo?.messageSecret || messageSecret;
        const meLid = normalizeCandidateJid(
          (sock.user as { lid?: string } | undefined)?.lid
        );
        sentPoll = {
          pollMsgId,
          secretBase64: Buffer.from(actualSecret).toString('base64'),
          creatorJid: normalizeCandidateJid(sock.user?.id),
          creatorLid: meLid || undefined,
          targetJid: normalizeCandidateJid(targetJid),
          options: cleanOptions,
        };
      }
    }

    return { jid: targetJid, messageIds: sentIds, sentPoll };
  }
}
