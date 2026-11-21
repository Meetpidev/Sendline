import 'dotenv/config';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import multer from 'multer';
import {
  clearSessionCookie,
  createSession,
  hashPassword,
  requireAuth,
  resolveAuthFromRequest,
  revokeSession,
  setSessionCookie,
  verifyPassword,
  type AuthenticatedRequest,
} from './server/auth.ts';
import { getDatabaseStatus, initDatabase, query } from './server/db.ts';
import { listUsersWithSavedWhatsAppAuth } from './server/pgAuthState.ts';
import {
  addAttachmentsToCampaign,
  bulkUpdateRecipientsStatus,
  clearRecipients,
  createCampaign,
  createId,
  createStarterCampaignForUser,
  deleteAttachmentFromCampaign,
  deleteCampaign,
  deleteRecipient,
  duplicateCampaign,
  findRecipientByMessageId,
  getAttachmentFileById,
  getCampaignAttachmentsWithBuffers,
  getCampaignById,
  getNextQueuedRecipient,
  getPollDispatchRecord,
  getPublicRecipientView,
  getRecipientById,
  getUserAccountUsage,
  importRecipients,
  incrementAttachmentDownloadCount,
  incrementUserAccountUsage,
  indexWhatsAppMessageIds,
  listCampaignSummaries,
  recordPollVoteInDb,
  resetCampaignPollVotes,
  savePollDispatchRecord,
  saveRecipientState,
  updateCampaign,
} from './server/store.ts';
import {
  WhatsAppManager,
  type ReceiptStatus,
} from './server/whatsappManager.ts';
import type {
  Campaign,
  DeliveryStatus,
  RealtimeEvent,
  Recipient,
  ServerDispatchJobState,
} from './src/types';

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

function resolveAppOrigin(req: Request, bodyOrigin?: string): string {
  const configured = (process.env.APP_URL || '').trim();
  if (configured && configured !== 'MY_APP_URL') {
    const withProto = /^https?:\/\//i.test(configured)
      ? configured
      : `https://${configured}`;
    return withProto.replace(/\/+$/, '');
  }
  if (bodyOrigin && /^https?:\/\//i.test(bodyOrigin.trim())) {
    return bodyOrigin.trim().replace(/\/+$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

// --- Per-User Real-Time SSE Channels (Strict Multi-Tenant Isolation) ---
const userSseClients = new Map<string, Set<Response>>();

function broadcastToUser(
  userId: string,
  event: Omit<RealtimeEvent, 'timestamp'>
): void {
  const clients = userSseClients.get(userId);
  if (!clients || clients.size === 0) return;

  const payload: RealtimeEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  const serialized = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(serialized);
    } catch {
      clients.delete(res);
    }
  }
}

// --- Per-User Dispatch Job Runtime ---
interface UserDispatchRuntime {
  job: ServerDispatchJobState;
  timer: NodeJS.Timeout | null;
  countdownTimer: NodeJS.Timeout | null;
  origin: string;
  sendingLock: boolean;
}

const userDispatchRuntimes = new Map<string, UserDispatchRuntime>();

function createIdleJob(): ServerDispatchJobState {
  return {
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
}

function getDispatchRuntime(userId: string): UserDispatchRuntime {
  let rt = userDispatchRuntimes.get(userId);
  if (!rt) {
    rt = {
      job: createIdleJob(),
      timer: null,
      countdownTimer: null,
      origin: '',
      sendingLock: false,
    };
    userDispatchRuntimes.set(userId, rt);
  }
  return rt;
}

function clearDispatchTimers(rt: UserDispatchRuntime): void {
  if (rt.timer) {
    clearTimeout(rt.timer);
    rt.timer = null;
  }
  if (rt.countdownTimer) {
    clearInterval(rt.countdownTimer);
    rt.countdownTimer = null;
  }
}

function broadcastDispatchJob(userId: string): void {
  const rt = getDispatchRuntime(userId);
  broadcastToUser(userId, {
    type: 'dispatch_job',
    campaignId: rt.job.campaignId || undefined,
    dispatchJob: { ...rt.job },
  });
}

// --- Message Formatting & Receipt Ranking ---
function renderMessageTextForServer(
  campaign: Campaign,
  recipient: Recipient,
  origin: string
): string {
  const vars: Record<string, string> = {
    name: recipient.name?.trim() || '',
    phone: recipient.phone || '',
    ...(recipient.customFields || {}),
  };

  let rendered = (campaign.message || '').replace(
    /\{\{\s*([a-zA-Z0-9_\- ]+)\s*\}\}/g,
    (_, rawKey: string) => {
      const key = rawKey.trim().toLowerCase();
      for (const [k, v] of Object.entries(vars)) {
        if (k.toLowerCase() === key) {
          return v ?? '';
        }
      }
      return '';
    }
  );

  rendered = rendered
    .replace(/\*\*\s*/g, '')
    .replace(/__\s*/g, '')
    .replace(/~~\s*/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,!?])/g, '$1')
    .trim();

  const hasAttachments = campaign.attachments.length > 0;
  const shouldAppendLink =
    (hasAttachments && campaign.settings.includeMediaLink) ||
    (!hasAttachments && campaign.settings.includeTrackingLinkWhenNoMedia);

  if (shouldAppendLink && origin) {
    const cleanOrigin = origin.replace(/\/+$/, '');
    const viewUrl = `${cleanOrigin}/view/${encodeURIComponent(campaign.id)}/${encodeURIComponent(recipient.id)}`;
    const label = hasAttachments
      ? campaign.attachments.length === 1
        ? `Web download (${campaign.attachments[0].originalName}):`
        : `Web downloads (${campaign.attachments.length} files):`
      : 'View full notice:';
    rendered = rendered
      ? `${rendered}\n\n${label}\n${viewUrl}`
      : `${label}\n${viewUrl}`;
  }

  return rendered;
}

const STATUS_RANK: Record<DeliveryStatus, number> = {
  queued: 0,
  sending: 1,
  dispatched: 2,
  sent: 3,
  delivered: 4,
  read: 5,
  opened: 6,
  failed: -1,
  skipped: -1,
};

async function handleWhatsAppReceipt(
  userId: string,
  messageId: string,
  receipt: ReceiptStatus
): Promise<void> {
  const found = await findRecipientByMessageId(userId, messageId);
  if (!found) return;
  const { campaignId, recipient } = found;

  const now = new Date().toISOString();
  if (receipt === 'sent') {
    recipient.sentAt = recipient.sentAt || now;
  } else if (receipt === 'delivered') {
    recipient.sentAt = recipient.sentAt || now;
    recipient.deliveredAt = recipient.deliveredAt || now;
  } else if (receipt === 'read') {
    recipient.sentAt = recipient.sentAt || now;
    recipient.deliveredAt = recipient.deliveredAt || now;
    recipient.readAt = recipient.readAt || now;
  }

  if (STATUS_RANK[receipt] > STATUS_RANK[recipient.status]) {
    recipient.status = receipt;
  }
  recipient.updatedAt = now;
  await saveRecipientState(userId, campaignId, recipient);

  broadcastToUser(userId, {
    type: 'recipient_updated',
    campaignId,
    recipientId: recipient.id,
    recipient,
  });
}

async function handleIncomingPollVote(
  userId: string,
  pollMsgId: string,
  selectedOptions: string[]
): Promise<void> {
  const record = await getPollDispatchRecord(userId, pollMsgId);
  if (!record) return;

  const recipient = await getRecipientById(
    userId,
    record.campaignId,
    record.recipientId
  );
  if (!recipient) return;

  const now = new Date().toISOString();
  const updatedPoll = await recordPollVoteInDb(
    userId,
    record.campaignId,
    recipient,
    selectedOptions,
    now
  );
  if (!updatedPoll) return;

  recipient.sentAt = recipient.sentAt || now;
  recipient.deliveredAt = recipient.deliveredAt || now;
  recipient.readAt = recipient.readAt || now;
  if (STATUS_RANK.read > STATUS_RANK[recipient.status]) {
    recipient.status = 'read';
  }
  recipient.updatedAt = now;
  await saveRecipientState(userId, record.campaignId, recipient);

  broadcastToUser(userId, {
    type: 'poll_vote_updated',
    campaignId: record.campaignId,
    recipientId: recipient.id,
    recipient,
    poll: updatedPoll,
    voterLabel: recipient.name.trim() || `+${recipient.phone}`,
    selectedOptions,
  });
}

// --- Per-User WhatsApp Linked-Device Managers ---
const userWhatsAppManagers = new Map<string, WhatsAppManager>();

function getWhatsAppManagerForUser(userId: string): WhatsAppManager {
  let manager = userWhatsAppManagers.get(userId);
  if (!manager) {
    manager = new WhatsAppManager({
      userId,
      getPollRecord: (pollMsgId) => getPollDispatchRecord(userId, pollMsgId),
      onStatusChange: (session) => {
        void getUserAccountUsage(userId, session.accountPhone)
          .then((usage) => {
            broadcastToUser(userId, {
              type: 'whatsapp_status',
              whatsapp: session,
              usage,
            });
          })
          .catch(() => {
            broadcastToUser(userId, {
              type: 'whatsapp_status',
              whatsapp: session,
            });
          });
      },
      onMessageReceipt: (msgId, receipt) =>
        handleWhatsAppReceipt(userId, msgId, receipt),
      onPollVote: (pollMsgId, chosen) =>
        handleIncomingPollVote(userId, pollMsgId, chosen),
    });
    userWhatsAppManagers.set(userId, manager);
  }
  return manager;
}

async function sendSingleRecipientDirectly(
  userId: string,
  campaign: Campaign,
  recipient: Recipient,
  origin: string
): Promise<Recipient> {
  const waManager = getWhatsAppManagerForUser(userId);
  const now = new Date().toISOString();
  recipient.status = 'sending';
  recipient.failedReason = null;
  recipient.updatedAt = now;
  await saveRecipientState(userId, campaign.id, recipient);

  broadcastToUser(userId, {
    type: 'recipient_updated',
    campaignId: campaign.id,
    recipientId: recipient.id,
    recipient,
  });

  try {
    const text = renderMessageTextForServer(campaign, recipient, origin);
    const activePoll =
      campaign.poll?.enabled &&
      campaign.poll.question.trim() &&
      campaign.poll.options.filter((o) => o.trim()).length >= 2
        ? {
            question: campaign.poll.question.trim(),
            options: campaign.poll.options
              .map((o) => o.trim())
              .filter(Boolean)
              .slice(0, 12),
            selectableCount: campaign.poll.selectableCount,
          }
        : null;

    const attachmentPayloads =
      campaign.attachments.length > 0
        ? await getCampaignAttachmentsWithBuffers(userId, campaign.id)
        : [];

    const { messageIds, sentPoll } = await waManager.sendMessage({
      phoneDigits: recipient.phone,
      text,
      attachments: attachmentPayloads,
      poll: activePoll,
    });

    const sentTime = new Date().toISOString();
    recipient.status = 'sent';
    recipient.dispatchedAt = sentTime;
    recipient.sentAt = sentTime;
    recipient.failedReason = null;
    recipient.whatsappMessageIds = [
      ...(recipient.whatsappMessageIds || []),
      ...messageIds,
    ];
    recipient.updatedAt = sentTime;

    await saveRecipientState(userId, campaign.id, recipient);
    await indexWhatsAppMessageIds(userId, campaign.id, recipient.id, messageIds);

    if (sentPoll) {
      await savePollDispatchRecord(userId, {
        pollMsgId: sentPoll.pollMsgId,
        campaignId: campaign.id,
        recipientId: recipient.id,
        secretBase64: sentPoll.secretBase64,
        creatorJid: sentPoll.creatorJid,
        creatorLid: sentPoll.creatorLid,
        targetJid: sentPoll.targetJid,
        options: sentPoll.options,
      });
    }

    const updatedUsage = await incrementUserAccountUsage(
      userId,
      waManager.getState().accountPhone,
      1
    );

    broadcastToUser(userId, {
      type: 'recipient_updated',
      campaignId: campaign.id,
      recipientId: recipient.id,
      recipient,
    });
    broadcastToUser(userId, {
      type: 'usage_updated',
      usage: updatedUsage,
    });
    return recipient;
  } catch (err) {
    const failTime = new Date().toISOString();
    recipient.status = 'failed';
    recipient.failedReason =
      err instanceof Error ? err.message : 'Failed to send message';
    recipient.updatedAt = failTime;
    await saveRecipientState(userId, campaign.id, recipient);

    broadcastToUser(userId, {
      type: 'recipient_updated',
      campaignId: campaign.id,
      recipientId: recipient.id,
      recipient,
    });
    throw err;
  }
}

async function runNextDispatchStep(userId: string): Promise<void> {
  const rt = getDispatchRuntime(userId);
  if (rt.job.status !== 'running' || !rt.job.campaignId) return;
  if (rt.sendingLock) return;

  const campaign = await getCampaignById(userId, rt.job.campaignId);
  if (!campaign) {
    clearDispatchTimers(rt);
    rt.job = createIdleJob();
    broadcastDispatchJob(userId);
    return;
  }

  const waManager = getWhatsAppManagerForUser(userId);
  if (!waManager.isConnected()) {
    clearDispatchTimers(rt);
    rt.job = { ...rt.job, status: 'paused', nextSendInSeconds: 0 };
    broadcastDispatchJob(userId);
    return;
  }

  const nextRecipient = await getNextQueuedRecipient(userId, campaign.id);
  if (!nextRecipient) {
    clearDispatchTimers(rt);
    rt.job = {
      ...rt.job,
      status: 'completed',
      currentRecipientId: null,
      currentPhone: null,
      nextSendInSeconds: 0,
    };
    broadcastDispatchJob(userId);
    return;
  }

  rt.sendingLock = true;
  rt.job = {
    ...rt.job,
    currentRecipientId: nextRecipient.id,
    currentPhone: nextRecipient.phone,
    nextSendInSeconds: 0,
  };
  broadcastDispatchJob(userId);

  try {
    await sendSingleRecipientDirectly(userId, campaign, nextRecipient, rt.origin);
    rt.job.sentCount += 1;
  } catch {
    rt.job.failedCount += 1;
  } finally {
    rt.job.processedCount += 1;
    rt.sendingLock = false;
  }

  if (rt.job.status !== 'running') {
    broadcastDispatchJob(userId);
    return;
  }

  const upcoming = await getNextQueuedRecipient(userId, campaign.id);
  if (!upcoming) {
    clearDispatchTimers(rt);
    rt.job = {
      ...rt.job,
      status: 'completed',
      currentRecipientId: null,
      currentPhone: null,
      nextSendInSeconds: 0,
    };
    broadcastDispatchJob(userId);
    return;
  }

  const delaySeconds = Math.max(1, Number(campaign.settings.intervalSeconds) || 3);
  rt.job.nextSendInSeconds = delaySeconds;
  broadcastDispatchJob(userId);

  clearDispatchTimers(rt);
  rt.countdownTimer = setInterval(() => {
    if (rt.job.status !== 'running') {
      clearDispatchTimers(rt);
      return;
    }
    if (rt.job.nextSendInSeconds > 1) {
      rt.job.nextSendInSeconds -= 1;
      broadcastDispatchJob(userId);
    }
  }, 1000);

  rt.timer = setTimeout(() => {
    clearDispatchTimers(rt);
    void runNextDispatchStep(userId);
  }, delaySeconds * 1000);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 12,
  },
});

function sanitizeFilenameForHeader(name: string): string {
  return encodeURIComponent(name.replace(/[\r\n"]/g, '_'));
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '20mb' }));

  const dbOk = await initDatabase();
  if (dbOk) {
    // Restore linked WhatsApp sessions stored in PostgreSQL on server boot
    void listUsersWithSavedWhatsAppAuth()
      .then((userIds) => {
        for (const uid of userIds) {
          void getWhatsAppManagerForUser(uid).autoRestoreIfLinked();
        }
      })
      .catch((err) => {
        console.error('Failed to auto-restore WhatsApp sessions:', err);
      });
  }

  // --- Health & Auth Routes ---
  app.get('/api/health', async (_req: Request, res: Response) => {
    let db = getDatabaseStatus();
    if (db.configured && !db.ready) {
      await initDatabase();
      db = getDatabaseStatus();
    }
    res.json({
      ok: true,
      databaseConfigured: db.configured,
      databaseReady: db.ready,
      databaseError: db.error,
    });
  });

  app.get('/api/auth/me', async (req: Request, res: Response) => {
    let db = getDatabaseStatus();
    if (db.configured && !db.ready) {
      await initDatabase();
      db = getDatabaseStatus();
    }
    if (!db.configured || !db.ready) {
      res.json({
        databaseConfigured: db.configured,
        databaseReady: db.ready,
        databaseError: db.error,
        user: null,
      });
      return;
    }

    try {
      const resolved = await resolveAuthFromRequest(req);
      if (resolved) {
        void getWhatsAppManagerForUser(resolved.user.id).autoRestoreIfLinked();
      }
      res.json({
        databaseConfigured: true,
        databaseReady: true,
        databaseError: null,
        user: resolved?.user ?? null,
      });
    } catch (err) {
      console.error('Auth me error:', err);
      res.status(500).json({ error: 'Failed to check session' });
    }
  });

  app.post('/api/auth/register', async (req: Request, res: Response) => {
    const db = getDatabaseStatus();
    if (!db.configured || !db.ready) {
      res.status(503).json({
        error: db.configured
          ? `Database unavailable: ${db.error || 'connection failed'}`
          : 'Database is not configured. Add DATABASE_URL in Settings -> Secrets.',
      });
      return;
    }

    const { name, email, password } = req.body as {
      name?: string;
      email?: string;
      password?: string;
    };

    const cleanName = (name || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();
    const rawPassword = typeof password === 'string' ? password : '';

    if (!cleanName || cleanName.length < 2 || cleanName.length > 80) {
      res.status(400).json({ error: 'Enter your name (2–80 characters).' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      res.status(400).json({ error: 'Enter a valid email address.' });
      return;
    }
    if (rawPassword.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters.' });
      return;
    }

    try {
      const existing = await query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1`,
        [cleanEmail]
      );
      if (existing.rows.length > 0) {
        res.status(409).json({
          error: 'An account with this email already exists. Sign in instead.',
        });
        return;
      }

      const userId = createId('usr');
      const passwordHash = hashPassword(rawPassword);
      const createdAt = new Date().toISOString();

      await query(
        `INSERT INTO users (id, email, name, password_hash, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, cleanEmail, cleanName, passwordHash, createdAt]
      );

      // Provision a clean, private starter campaign for this new user
      await createStarterCampaignForUser(userId);

      const token = await createSession(userId);
      setSessionCookie(req, res, token);

      res.status(201).json({
        token,
        user: {
          id: userId,
          email: cleanEmail,
          name: cleanName,
          createdAt,
        },
      });
    } catch (err) {
      console.error('Register error:', err);
      res.status(500).json({ error: 'Could not create account' });
    }
  });

  app.post('/api/auth/login', async (req: Request, res: Response) => {
    const db = getDatabaseStatus();
    if (!db.configured || !db.ready) {
      res.status(503).json({
        error: db.configured
          ? `Database unavailable: ${db.error || 'connection failed'}`
          : 'Database is not configured. Add DATABASE_URL in Settings -> Secrets.',
      });
      return;
    }

    const { email, password } = req.body as {
      email?: string;
      password?: string;
    };

    const cleanEmail = (email || '').trim().toLowerCase();
    const rawPassword = typeof password === 'string' ? password : '';

    if (!cleanEmail || !rawPassword) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    try {
      const result = await query<{
        id: string;
        email: string;
        name: string;
        password_hash: string;
        created_at: Date | string;
      }>(
        `SELECT id, email, name, password_hash, created_at FROM users WHERE email = $1`,
        [cleanEmail]
      );

      if (
        result.rows.length === 0 ||
        !verifyPassword(rawPassword, result.rows[0].password_hash)
      ) {
        res.status(401).json({ error: 'Invalid email or password.' });
        return;
      }

      const row = result.rows[0];
      const token = await createSession(row.id);
      setSessionCookie(req, res, token);

      // Ensure user's linked WhatsApp session reconnects if previously paired
      void getWhatsAppManagerForUser(row.id).autoRestoreIfLinked();

      res.json({
        token,
        user: {
          id: row.id,
          email: row.email,
          name: row.name,
          createdAt:
            row.created_at instanceof Date
              ? row.created_at.toISOString()
              : String(row.created_at),
        },
      });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ error: 'Sign in failed' });
    }
  });

  app.post('/api/auth/logout', async (req: Request, res: Response) => {
    try {
      const resolved = await resolveAuthFromRequest(req);
      if (resolved) {
        await revokeSession(resolved.tokenHash);
      }
    } catch {
      // ignore
    }
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  // --- Authenticated Real-Time SSE Stream (Scoped Strictly to req.user.id) ---
  app.get('/api/events', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user!.id;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let clients = userSseClients.get(userId);
    if (!clients) {
      clients = new Set<Response>();
      userSseClients.set(userId, clients);
    }
    clients.add(res);

    const waManager = getWhatsAppManagerForUser(userId);
    const waState = waManager.getState();
    const usage = await getUserAccountUsage(userId, waState.accountPhone);
    const rt = getDispatchRuntime(userId);

    const hello: RealtimeEvent = {
      type: 'connected',
      whatsapp: waState,
      usage,
      dispatchJob: { ...rt.job },
      timestamp: new Date().toISOString(),
    };
    res.write(`data: ${JSON.stringify(hello)}\n\n`);

    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
        clients?.delete(res);
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      clients?.delete(res);
    });
  });

  // --- WhatsApp Direct Linked-Device Routes (Per-User Isolated) ---
  app.get(
    '/api/whatsapp/status',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const waManager = getWhatsAppManagerForUser(userId);
      void waManager.autoRestoreIfLinked();
      const waState = waManager.getState();
      const usage = await getUserAccountUsage(userId, waState.accountPhone);
      const rt = getDispatchRuntime(userId);

      res.json({
        whatsapp: waState,
        usage,
        dispatchJob: { ...rt.job },
      });
    }
  );

  app.post(
    '/api/whatsapp/connect',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const session = await getWhatsAppManagerForUser(userId).connect();
      res.json({ whatsapp: session });
    }
  );

  app.post(
    '/api/whatsapp/pair',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const { phone } = req.body as { phone?: string };
      const clean = (phone || '').replace(/\D/g, '');
      if (clean.length < 7 || clean.length > 15) {
        res.status(400).json({
          error:
            'Enter your WhatsApp number with country code (e.g. 919876543210)',
        });
        return;
      }
      const session = await getWhatsAppManagerForUser(userId).connect(clean);
      res.json({ whatsapp: session });
    }
  );

  app.post(
    '/api/whatsapp/disconnect',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const rt = getDispatchRuntime(userId);
      clearDispatchTimers(rt);
      rt.job = createIdleJob();
      broadcastDispatchJob(userId);

      const session = await getWhatsAppManagerForUser(userId).disconnect();
      res.json({ whatsapp: session });
    }
  );

  // --- Direct Zero-Redirect Sending Routes ---
  app.post(
    '/api/campaigns/:id/recipients/:recipientId/send',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const campaign = await getCampaignById(userId, req.params.id);
      if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }
      const recipient = campaign.recipients.find(
        (r) => r.id === req.params.recipientId
      );
      if (!recipient) {
        res.status(404).json({ error: 'Recipient not found' });
        return;
      }

      const waManager = getWhatsAppManagerForUser(userId);
      if (!waManager.isConnected()) {
        res.status(409).json({
          error:
            'WhatsApp is not linked yet. Connect your WhatsApp account via QR code or pairing code to send directly.',
          needsWhatsAppAuth: true,
        });
        return;
      }

      const origin = resolveAppOrigin(
        req,
        (req.body as { origin?: string })?.origin
      );
      try {
        const updated = await sendSingleRecipientDirectly(
          userId,
          campaign,
          recipient,
          origin
        );
        res.json({ recipient: updated });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Failed to send message',
          recipient,
        });
      }
    }
  );

  app.post(
    '/api/campaigns/:id/dispatch/start',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const campaign = await getCampaignById(userId, req.params.id);
      if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }

      const waManager = getWhatsAppManagerForUser(userId);
      if (!waManager.isConnected()) {
        res.status(409).json({
          error:
            'Connect your WhatsApp account first to send messages directly without redirecting.',
          needsWhatsAppAuth: true,
        });
        return;
      }

      const queued = campaign.recipients.filter((r) => r.status === 'queued');
      if (queued.length === 0) {
        res.status(400).json({ error: 'No queued numbers left in this campaign' });
        return;
      }

      const hasPoll = Boolean(
        campaign.poll?.enabled &&
          campaign.poll.question.trim() &&
          campaign.poll.options.filter((o) => o.trim()).length >= 2
      );
      if (
        !campaign.message.trim() &&
        campaign.attachments.length === 0 &&
        !hasPoll
      ) {
        res.status(400).json({
          error:
            'Write a message, attach a file, or check Send Poll with a valid question & options.',
        });
        return;
      }

      const rt = getDispatchRuntime(userId);
      clearDispatchTimers(rt);
      rt.origin = resolveAppOrigin(
        req,
        (req.body as { origin?: string })?.origin
      );

      rt.job = {
        campaignId: campaign.id,
        status: 'running',
        currentRecipientId: queued[0].id,
        currentPhone: queued[0].phone,
        processedCount: 0,
        totalCount: queued.length,
        sentCount: 0,
        failedCount: 0,
        nextSendInSeconds: 0,
      };
      broadcastDispatchJob(userId);
      void runNextDispatchStep(userId);

      res.json({ dispatchJob: { ...rt.job } });
    }
  );

  app.post(
    '/api/campaigns/:id/dispatch/pause',
    requireAuth,
    (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const rt = getDispatchRuntime(userId);
      clearDispatchTimers(rt);
      if (rt.job.status === 'running') {
        rt.job = { ...rt.job, status: 'paused', nextSendInSeconds: 0 };
        broadcastDispatchJob(userId);
      }
      res.json({ dispatchJob: { ...rt.job } });
    }
  );

  app.post(
    '/api/campaigns/:id/dispatch/resume',
    requireAuth,
    (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      if (!getWhatsAppManagerForUser(userId).isConnected()) {
        res.status(409).json({
          error: 'Reconnect WhatsApp to resume sending',
          needsWhatsAppAuth: true,
        });
        return;
      }
      const rt = getDispatchRuntime(userId);
      if (rt.job.status === 'paused' && rt.job.campaignId) {
        rt.job = { ...rt.job, status: 'running', nextSendInSeconds: 0 };
        broadcastDispatchJob(userId);
        void runNextDispatchStep(userId);
      }
      res.json({ dispatchJob: { ...rt.job } });
    }
  );

  app.post(
    '/api/campaigns/:id/dispatch/stop',
    requireAuth,
    (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const rt = getDispatchRuntime(userId);
      clearDispatchTimers(rt);
      rt.job = createIdleJob();
      broadcastDispatchJob(userId);
      res.json({ dispatchJob: { ...rt.job } });
    }
  );

  // --- Poll Reset Route ---
  app.post(
    '/api/campaigns/:id/poll/reset-votes',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const updated = await resetCampaignPollVotes(userId, req.params.id);
      if (!updated) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }
      broadcastToUser(userId, {
        type: 'poll_vote_updated',
        campaignId: updated.id,
        poll: updated.poll,
      });
      res.json({ poll: updated.poll, campaign: updated });
    }
  );

  // --- Campaign CRUD Routes (Per-User Scoped in PostgreSQL) ---
  app.get(
    '/api/campaigns',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const campaigns = await listCampaignSummaries(req.user!.id);
      res.json({ campaigns });
    }
  );

  app.get(
    '/api/campaigns/:id',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const campaign = await getCampaignById(req.user!.id, req.params.id);
      if (!campaign) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }
      res.json({ campaign });
    }
  );

  app.post(
    '/api/campaigns',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const { name, message, defaultCountryCode } = req.body as {
        name?: string;
        message?: string;
        defaultCountryCode?: string;
      };
      const campaign = await createCampaign(userId, {
        name,
        message,
        defaultCountryCode,
      });
      broadcastToUser(userId, {
        type: 'campaign_updated',
        campaignId: campaign.id,
      });
      res.status(201).json({ campaign });
    }
  );

  app.patch(
    '/api/campaigns/:id',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const { name, message, defaultCountryCode, settings, poll } =
        req.body as Partial<Campaign>;
      const updated = await updateCampaign(userId, req.params.id, {
        name,
        message,
        defaultCountryCode,
        settings,
        poll,
      });
      if (!updated) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }
      broadcastToUser(userId, {
        type: 'campaign_updated',
        campaignId: updated.id,
      });
      res.json({ campaign: updated });
    }
  );

  app.post(
    '/api/campaigns/:id/duplicate',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const copy = await duplicateCampaign(userId, req.params.id);
      if (!copy) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }
      broadcastToUser(userId, { type: 'campaign_updated', campaignId: copy.id });
      res.status(201).json({ campaign: copy });
    }
  );

  app.delete(
    '/api/campaigns/:id',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const deleted = await deleteCampaign(userId, req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }
      const campaigns = await listCampaignSummaries(userId);
      broadcastToUser(userId, { type: 'campaign_updated' });
      res.json({ ok: true, campaigns });
    }
  );

  // --- Recipients Routes ---
  app.post(
    '/api/campaigns/:id/recipients/import',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const { contacts, replaceExisting } = req.body as {
        contacts?: Array<{
          name?: string;
          rawPhone?: string;
          phone: string;
          customFields?: Record<string, string>;
        }>;
        replaceExisting?: boolean;
      };

      if (!Array.isArray(contacts)) {
        res.status(400).json({ error: 'contacts array required' });
        return;
      }

      const result = await importRecipients(
        userId,
        req.params.id,
        contacts,
        Boolean(replaceExisting)
      );
      if (!result) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }

      broadcastToUser(userId, {
        type: 'recipients_bulk_updated',
        campaignId: result.campaign.id,
      });
      res.json({
        added: result.added,
        duplicates: result.duplicates,
        invalid: result.invalid,
        totalRecipients: result.campaign.recipients.length,
        campaign: result.campaign,
      });
    }
  );

  app.patch(
    '/api/campaigns/:id/recipients/:recipientId',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const recipient = await getRecipientById(
        userId,
        req.params.id,
        req.params.recipientId
      );
      if (!recipient) {
        res.status(404).json({ error: 'Recipient not found' });
        return;
      }

      const { status, failedReason, name, phone } = req.body as {
        status?: DeliveryStatus;
        failedReason?: string | null;
        name?: string;
        phone?: string;
      };
      const now = new Date().toISOString();

      if (typeof name === 'string') recipient.name = name.trim();
      if (typeof phone === 'string') {
        const digits = phone.replace(/\D/g, '');
        if (digits.length >= 7 && digits.length <= 15) {
          recipient.phone = digits;
        }
      }

      if (status) {
        recipient.status = status;
        if (status === 'dispatched') {
          recipient.dispatchedAt = recipient.dispatchedAt || now;
          recipient.failedReason = null;
        } else if (status === 'sent') {
          recipient.dispatchedAt = recipient.dispatchedAt || now;
          recipient.sentAt = now;
          recipient.failedReason = null;
        } else if (status === 'delivered') {
          recipient.sentAt = recipient.sentAt || now;
          recipient.deliveredAt = now;
          recipient.failedReason = null;
        } else if (status === 'read') {
          recipient.sentAt = recipient.sentAt || now;
          recipient.deliveredAt = recipient.deliveredAt || now;
          recipient.readAt = now;
          recipient.failedReason = null;
        } else if (status === 'opened') {
          recipient.dispatchedAt = recipient.dispatchedAt || now;
          recipient.sentAt = recipient.sentAt || now;
          recipient.openedAt = recipient.openedAt || now;
          recipient.openCount += 1;
          recipient.failedReason = null;
        } else if (status === 'failed') {
          recipient.failedReason = failedReason || 'Delivery failed';
        } else if (status === 'queued') {
          recipient.dispatchedAt = null;
          recipient.sentAt = null;
          recipient.deliveredAt = null;
          recipient.readAt = null;
          recipient.openedAt = null;
          recipient.failedReason = null;
        }
      }

      recipient.updatedAt = now;
      await saveRecipientState(userId, req.params.id, recipient);

      broadcastToUser(userId, {
        type: 'recipient_updated',
        campaignId: req.params.id,
        recipientId: recipient.id,
        recipient,
      });
      res.json({ recipient });
    }
  );

  app.post(
    '/api/campaigns/:id/recipients/bulk-status',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const { fromStatuses, toStatus, recipientIds } = req.body as {
        fromStatuses?: DeliveryStatus[];
        toStatus: DeliveryStatus;
        recipientIds?: string[];
      };
      const result = await bulkUpdateRecipientsStatus(userId, req.params.id, {
        fromStatuses,
        toStatus,
        recipientIds,
      });
      if (!result) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }

      broadcastToUser(userId, {
        type: 'recipients_bulk_updated',
        campaignId: req.params.id,
      });
      res.json(result);
    }
  );

  app.delete(
    '/api/campaigns/:id/recipients/:recipientId',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const totalRecipients = await deleteRecipient(
        userId,
        req.params.id,
        req.params.recipientId
      );
      if (totalRecipients === null) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }
      broadcastToUser(userId, {
        type: 'recipients_bulk_updated',
        campaignId: req.params.id,
      });
      res.json({ ok: true, totalRecipients });
    }
  );

  app.delete(
    '/api/campaigns/:id/recipients',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const ok = await clearRecipients(userId, req.params.id);
      if (!ok) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }
      broadcastToUser(userId, {
        type: 'recipients_bulk_updated',
        campaignId: req.params.id,
      });
      res.json({ ok: true });
    }
  );

  // --- Attachments (Stored Durably as BYTEA in Neon PostgreSQL) ---
  app.post(
    '/api/campaigns/:id/attachments',
    requireAuth,
    upload.array('files', 12),
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const files = (req.files as Express.Multer.File[]) || [];
      if (files.length === 0) {
        res.status(400).json({ error: 'No files uploaded' });
        return;
      }

      const result = await addAttachmentsToCampaign(
        userId,
        req.params.id,
        files.map((f) => ({
          originalName: f.originalname,
          mimeType: f.mimetype || 'application/octet-stream',
          size: f.size,
          buffer: f.buffer,
        }))
      );
      if (!result) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }

      broadcastToUser(userId, {
        type: 'campaign_updated',
        campaignId: result.campaign.id,
      });
      res.status(201).json({ attachments: result.added, campaign: result.campaign });
    }
  );

  app.delete(
    '/api/campaigns/:id/attachments/:attachmentId',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.user!.id;
      const attachments = await deleteAttachmentFromCampaign(
        userId,
        req.params.id,
        req.params.attachmentId
      );
      if (!attachments) {
        res.status(404).json({ error: 'Campaign not found' });
        return;
      }
      broadcastToUser(userId, {
        type: 'campaign_updated',
        campaignId: req.params.id,
      });
      res.json({ ok: true, attachments });
    }
  );

  // Serve attachment bytes from Neon PostgreSQL (unguessable 128-bit ID)
  app.get('/api/files/:attachmentId/:filename', async (req: Request, res: Response) => {
    const db = getDatabaseStatus();
    if (!db.configured || !db.ready) {
      res.status(503).send('Database unavailable');
      return;
    }

    const att = await getAttachmentFileById(req.params.attachmentId);
    if (!att) {
      res.status(404).send('Attachment not found');
      return;
    }

    const safeInlineMimeTypes = new Set([
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
      'image/gif',
      'application/pdf',
      'video/mp4',
      'video/webm',
      'audio/mpeg',
      'audio/ogg',
      'audio/wav',
    ]);
    const normalizedMime = (att.mimeType || 'application/octet-stream')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const allowInline =
      req.query.download !== '1' && safeInlineMimeTypes.has(normalizedMime);

    const safeFileName = sanitizeFilenameForHeader(att.originalName);
    if (req.query.download === '1') {
      const count = await incrementAttachmentDownloadCount(att.id);
      broadcastToUser(att.userId, {
        type: 'attachment_downloaded',
        campaignId: att.campaignId,
        attachmentId: att.id,
        downloadCount: count,
      });
    }

    res.setHeader(
      'Content-Disposition',
      `${allowInline ? 'inline' : 'attachment'}; filename*=UTF-8''${safeFileName}`
    );
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', normalizedMime || 'application/octet-stream');
    res.send(att.buffer);
  });

  // Public shared recipient view link (for optional web backup download links)
  app.get(
    '/api/public/view/:campaignId/:recipientId',
    async (req: Request, res: Response) => {
      const db = getDatabaseStatus();
      if (!db.configured || !db.ready) {
        res.status(503).json({ error: 'Database unavailable' });
        return;
      }

      const shouldTrack = req.query.track !== '0';
      const data = await getPublicRecipientView(
        req.params.campaignId,
        req.params.recipientId,
        shouldTrack
      );
      if (!data) {
        res.status(404).json({ error: 'Message link not found or expired' });
        return;
      }

      if (shouldTrack) {
        broadcastToUser(data.userId, {
          type: 'recipient_opened',
          campaignId: req.params.campaignId,
          recipientId: data.recipient.id,
          recipient: data.recipient,
        });
      }

      res.json({
        campaignName: data.campaignName,
        messageTemplate: data.messageTemplate,
        attachments: data.attachments,
        recipient: {
          id: data.recipient.id,
          name: data.recipient.name,
          phone: data.recipient.phone,
          customFields: data.recipient.customFields,
          openedAt: data.recipient.openedAt,
          openCount: data.recipient.openCount,
        },
      });
    }
  );

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sendline server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
