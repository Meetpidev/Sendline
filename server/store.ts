import crypto from 'node:crypto';
import type {
  AttachmentItem,
  Campaign,
  CampaignPoll,
  CampaignSummary,
  DeliveryStatus,
  DispatchSettings,
  MonthlyAccountUsage,
  PollDispatchRecord,
  Recipient,
} from '../src/types';
import { query, withTransaction } from './db.ts';

export const RECOMMENDED_MONTHLY_LIMIT = 6000;
export const NEW_ACCOUNT_MONTHLY_LIMIT = 1500;
export const RECOMMENDED_DAILY_LIMIT = 200;
export const OFFICIAL_API_STARTER_DAILY = 250;
export const FREE_APP_BROADCAST_LIST_CAP = 256;

export function createId(prefix: string, bytes = 8): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;
}

export function getMonthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function getDayKey(d = new Date()): string {
  return `${getMonthKey(d)}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function createDefaultSettings(): DispatchSettings {
  return {
    mode: 'queue',
    intervalSeconds: 3,
    burstSize: 5,
    includeMediaLink: false,
    includeTrackingLinkWhenNoMedia: false,
    autoConfirmSent: true,
  };
}

export function createDefaultPoll(): CampaignPoll {
  return {
    enabled: false,
    pollType: 'single_choice',
    question: '',
    options: ['Option 1', 'Option 2'],
    selectableCount: 1,
    votes: {},
    updatedAt: new Date().toISOString(),
  };
}

export function hydratePoll(p?: Partial<CampaignPoll> | null): CampaignPoll {
  const base = createDefaultPoll();
  if (!p) return base;
  return {
    enabled: Boolean(p.enabled),
    pollType: p.pollType || 'single_choice',
    question: typeof p.question === 'string' ? p.question : '',
    options:
      Array.isArray(p.options) && p.options.length >= 2
        ? p.options.map((o) => String(o ?? ''))
        : base.options,
    selectableCount:
      typeof p.selectableCount === 'number' ? p.selectableCount : 1,
    votes: p.votes && typeof p.votes === 'object' ? p.votes : {},
    updatedAt: p.updatedAt || base.updatedAt,
  };
}

function toIso(val: Date | string | null | undefined): string | null {
  if (!val) return null;
  return val instanceof Date ? val.toISOString() : String(val);
}

interface CampaignRow {
  id: string;
  user_id: string;
  name: string;
  message: string;
  default_country_code: string;
  settings: DispatchSettings;
  poll: CampaignPoll;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RecipientRow {
  id: string;
  campaign_id: string;
  user_id: string;
  name: string;
  raw_phone: string;
  phone: string;
  custom_fields: Record<string, string>;
  status: DeliveryStatus;
  whatsapp_message_ids: string[];
  dispatched_at: Date | string | null;
  sent_at: Date | string | null;
  delivered_at: Date | string | null;
  read_at: Date | string | null;
  opened_at: Date | string | null;
  failed_reason: string | null;
  open_count: number;
  updated_at: Date | string;
}

interface AttachmentMetaRow {
  id: string;
  campaign_id: string;
  user_id: string;
  original_name: string;
  mime_type: string;
  size: number;
  download_count: number;
  uploaded_at: Date | string;
}

function mapRecipientRow(row: RecipientRow): Recipient {
  return {
    id: row.id,
    name: row.name ?? '',
    rawPhone: row.raw_phone || row.phone,
    phone: row.phone,
    customFields:
      row.custom_fields && typeof row.custom_fields === 'object'
        ? row.custom_fields
        : {},
    status: row.status || 'queued',
    whatsappMessageIds: Array.isArray(row.whatsapp_message_ids)
      ? row.whatsapp_message_ids
      : [],
    dispatchedAt: toIso(row.dispatched_at),
    sentAt: toIso(row.sent_at),
    deliveredAt: toIso(row.delivered_at),
    readAt: toIso(row.read_at),
    openedAt: toIso(row.opened_at),
    failedReason: row.failed_reason ?? null,
    openCount: Number(row.open_count) || 0,
    updatedAt: toIso(row.updated_at) || new Date().toISOString(),
  };
}

function mapAttachmentMetaRow(row: AttachmentMetaRow): AttachmentItem {
  return {
    id: row.id,
    originalName: row.original_name,
    storedName: row.id,
    mimeType: row.mime_type,
    size: Number(row.size) || 0,
    uploadedAt: toIso(row.uploaded_at) || new Date().toISOString(),
    downloadCount: Number(row.download_count) || 0,
  };
}

export async function createStarterCampaignForUser(
  userId: string
): Promise<Campaign> {
  return createCampaign(userId, {
    name: 'My First Broadcast',
    message: '',
    defaultCountryCode: '91',
  });
}

export async function createCampaign(
  userId: string,
  input: {
    name?: string;
    message?: string;
    defaultCountryCode?: string;
    settings?: DispatchSettings;
    poll?: CampaignPoll;
  }
): Promise<Campaign> {
  const id = createId('cmp');
  const now = new Date().toISOString();
  const countRes = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM campaigns WHERE user_id = $1`,
    [userId]
  );
  const existingCount = Number(countRes.rows[0]?.count || 0);
  const name = (input.name || '').trim() || `Broadcast ${existingCount + 1}`;
  const message = typeof input.message === 'string' ? input.message : '';
  const defaultCountryCode =
    (input.defaultCountryCode || '91').replace(/\D/g, '') || '91';
  const settings = input.settings || createDefaultSettings();
  const poll = hydratePoll(input.poll);

  await query(
    `INSERT INTO campaigns
      (id, user_id, name, message, default_country_code, settings, poll, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
    [
      id,
      userId,
      name,
      message,
      defaultCountryCode,
      JSON.stringify(settings),
      JSON.stringify(poll),
      now,
      now,
    ]
  );

  return {
    id,
    name,
    message,
    defaultCountryCode,
    createdAt: now,
    updatedAt: now,
    settings,
    poll,
    attachments: [],
    recipients: [],
  };
}

export async function listCampaignSummaries(
  userId: string
): Promise<CampaignSummary[]> {
  let campRes = await query<CampaignRow>(
    `SELECT id, user_id, name, message, default_country_code, settings, poll, created_at, updated_at
     FROM campaigns
     WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [userId]
  );

  if (campRes.rows.length === 0) {
    await createStarterCampaignForUser(userId);
    campRes = await query<CampaignRow>(
      `SELECT id, user_id, name, message, default_country_code, settings, poll, created_at, updated_at
       FROM campaigns
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [userId]
    );
  }

  const campaignIds = campRes.rows.map((r) => r.id);
  const [statusRes, attRes] = await Promise.all([
    query<{ campaign_id: string; status: DeliveryStatus; cnt: string }>(
      `SELECT campaign_id, status, COUNT(*)::text AS cnt
       FROM recipients
       WHERE user_id = $1 AND campaign_id = ANY($2::text[])
       GROUP BY campaign_id, status`,
      [userId, campaignIds]
    ),
    query<{ campaign_id: string; cnt: string }>(
      `SELECT campaign_id, COUNT(*)::text AS cnt
       FROM attachments
       WHERE user_id = $1 AND campaign_id = ANY($2::text[])
       GROUP BY campaign_id`,
      [userId, campaignIds]
    ),
  ]);

  const statusMap = new Map<string, Record<DeliveryStatus, number>>();
  for (const row of statusRes.rows) {
    if (!statusMap.has(row.campaign_id)) {
      statusMap.set(row.campaign_id, {
        queued: 0,
        sending: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        opened: 0,
        dispatched: 0,
        failed: 0,
        skipped: 0,
      });
    }
    const counts = statusMap.get(row.campaign_id)!;
    counts[row.status] = Number(row.cnt) || 0;
  }

  const attCountMap = new Map<string, number>();
  for (const row of attRes.rows) {
    attCountMap.set(row.campaign_id, Number(row.cnt) || 0);
  }

  return campRes.rows.map((c) => {
    const counts = statusMap.get(c.id) || {
      queued: 0,
      sending: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      opened: 0,
      dispatched: 0,
      failed: 0,
      skipped: 0,
    };
    const totalRecipients = Object.values(counts).reduce((a, b) => a + b, 0);
    const poll = hydratePoll(c.poll);
    const pollVoterCount = Object.values(poll.votes || {}).filter(
      (v) => v.selectedOptions.length > 0
    ).length;

    return {
      id: c.id,
      name: c.name,
      createdAt: toIso(c.created_at) || new Date().toISOString(),
      updatedAt: toIso(c.updated_at) || new Date().toISOString(),
      totalRecipients,
      attachmentCount: attCountMap.get(c.id) || 0,
      pollEnabled: Boolean(poll.enabled),
      pollVoterCount,
      counts,
    };
  });
}

export async function getCampaignById(
  userId: string,
  campaignId: string
): Promise<Campaign | null> {
  const campRes = await query<CampaignRow>(
    `SELECT id, user_id, name, message, default_country_code, settings, poll, created_at, updated_at
     FROM campaigns
     WHERE id = $1 AND user_id = $2`,
    [campaignId, userId]
  );
  if (campRes.rows.length === 0) return null;
  const c = campRes.rows[0];

  const [recRes, attRes] = await Promise.all([
    query<RecipientRow>(
      `SELECT id, campaign_id, user_id, name, raw_phone, phone, custom_fields, status,
              whatsapp_message_ids, dispatched_at, sent_at, delivered_at, read_at,
              opened_at, failed_reason, open_count, updated_at
       FROM recipients
       WHERE campaign_id = $1 AND user_id = $2
       ORDER BY sort_order ASC`,
      [campaignId, userId]
    ),
    query<AttachmentMetaRow>(
      `SELECT id, campaign_id, user_id, original_name, mime_type, size, download_count, uploaded_at
       FROM attachments
       WHERE campaign_id = $1 AND user_id = $2
       ORDER BY uploaded_at ASC`,
      [campaignId, userId]
    ),
  ]);

  return {
    id: c.id,
    name: c.name,
    message: c.message,
    defaultCountryCode: c.default_country_code,
    createdAt: toIso(c.created_at) || new Date().toISOString(),
    updatedAt: toIso(c.updated_at) || new Date().toISOString(),
    settings: { ...createDefaultSettings(), ...(c.settings || {}) },
    poll: hydratePoll(c.poll),
    attachments: attRes.rows.map(mapAttachmentMetaRow),
    recipients: recRes.rows.map(mapRecipientRow),
  };
}

export async function updateCampaign(
  userId: string,
  campaignId: string,
  patch: Partial<
    Pick<Campaign, 'name' | 'message' | 'defaultCountryCode' | 'settings' | 'poll'>
  >
): Promise<Campaign | null> {
  const existing = await getCampaignById(userId, campaignId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const nextName =
    typeof patch.name === 'string' && patch.name.trim()
      ? patch.name.trim()
      : existing.name;
  const nextMessage =
    typeof patch.message === 'string' ? patch.message : existing.message;
  const nextCountryCode =
    typeof patch.defaultCountryCode === 'string'
      ? patch.defaultCountryCode.replace(/\D/g, '') || '91'
      : existing.defaultCountryCode;
  const nextSettings =
    patch.settings && typeof patch.settings === 'object'
      ? { ...existing.settings, ...patch.settings }
      : existing.settings;
  const nextPoll =
    patch.poll && typeof patch.poll === 'object'
      ? {
          ...hydratePoll(existing.poll),
          ...patch.poll,
          // Preserve live votes recorded on the server
          votes: existing.poll.votes || {},
          updatedAt: now,
        }
      : existing.poll;

  await query(
    `UPDATE campaigns
     SET name = $1, message = $2, default_country_code = $3,
         settings = $4::jsonb, poll = $5::jsonb, updated_at = $6
     WHERE id = $7 AND user_id = $8`,
    [
      nextName,
      nextMessage,
      nextCountryCode,
      JSON.stringify(nextSettings),
      JSON.stringify(nextPoll),
      now,
      campaignId,
      userId,
    ]
  );

  return {
    ...existing,
    name: nextName,
    message: nextMessage,
    defaultCountryCode: nextCountryCode,
    settings: nextSettings,
    poll: nextPoll,
    updatedAt: now,
  };
}

export async function resetCampaignPollVotes(
  userId: string,
  campaignId: string
): Promise<Campaign | null> {
  const existing = await getCampaignById(userId, campaignId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const nextPoll: CampaignPoll = {
    ...hydratePoll(existing.poll),
    votes: {},
    updatedAt: now,
  };

  await query(
    `UPDATE campaigns SET poll = $1::jsonb, updated_at = $2 WHERE id = $3 AND user_id = $4`,
    [JSON.stringify(nextPoll), now, campaignId, userId]
  );

  return {
    ...existing,
    poll: nextPoll,
    updatedAt: now,
  };
}

export async function duplicateCampaign(
  userId: string,
  sourceId: string
): Promise<Campaign | null> {
  const source = await getCampaignById(userId, sourceId);
  if (!source) return null;

  const newCampaignId = createId('cmp');
  const now = new Date().toISOString();
  const cleanPoll: CampaignPoll = {
    ...hydratePoll(source.poll),
    votes: {},
    updatedAt: now,
  };

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO campaigns
        (id, user_id, name, message, default_country_code, settings, poll, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
      [
        newCampaignId,
        userId,
        `${source.name} (Copy)`,
        source.message,
        source.defaultCountryCode,
        JSON.stringify(source.settings),
        JSON.stringify(cleanPoll),
        now,
        now,
      ]
    );

    // Clone attachments (including BYTEA payloads) inside PostgreSQL
    const sourceAtts = await client.query<{
      original_name: string;
      mime_type: string;
      size: number;
      file_data: Buffer;
    }>(
      `SELECT original_name, mime_type, size, file_data
       FROM attachments
       WHERE campaign_id = $1 AND user_id = $2
       ORDER BY uploaded_at ASC`,
      [sourceId, userId]
    );

    for (const att of sourceAtts.rows) {
      await client.query(
        `INSERT INTO attachments
          (id, campaign_id, user_id, original_name, mime_type, size, file_data, download_count, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
        [
          createId('att', 16),
          newCampaignId,
          userId,
          att.original_name,
          att.mime_type,
          att.size,
          att.file_data,
          now,
        ]
      );
    }

    for (const r of source.recipients) {
      await client.query(
        `INSERT INTO recipients
          (id, campaign_id, user_id, name, raw_phone, phone, custom_fields, status, whatsapp_message_ids, open_count, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'queued', '[]'::jsonb, 0, $8)`,
        [
          createId('rcp'),
          newCampaignId,
          userId,
          r.name,
          r.rawPhone,
          r.phone,
          JSON.stringify(r.customFields || {}),
          now,
        ]
      );
    }
  });

  return getCampaignById(userId, newCampaignId);
}

export async function deleteCampaign(
  userId: string,
  campaignId: string
): Promise<boolean> {
  const res = await query(
    `DELETE FROM campaigns WHERE id = $1 AND user_id = $2`,
    [campaignId, userId]
  );
  return (res.rowCount || 0) > 0;
}

export async function importRecipients(
  userId: string,
  campaignId: string,
  contacts: Array<{
    name?: string;
    rawPhone?: string;
    phone: string;
    customFields?: Record<string, string>;
  }>,
  replaceExisting: boolean
): Promise<{
  added: number;
  duplicates: number;
  invalid: number;
  campaign: Campaign;
} | null> {
  const existingCampaign = await getCampaignById(userId, campaignId);
  if (!existingCampaign) return null;

  const now = new Date().toISOString();
  let added = 0;
  let duplicates = 0;
  let invalid = 0;

  await withTransaction(async (client) => {
    if (replaceExisting) {
      await client.query(
        `DELETE FROM recipients WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, userId]
      );
    }

    const existingPhones = new Set<string>(
      replaceExisting ? [] : existingCampaign.recipients.map((r) => r.phone)
    );

    const toInsert: Array<{
      id: string;
      name: string;
      rawPhone: string;
      phone: string;
      customFields: Record<string, string>;
    }> = [];

    for (const item of contacts) {
      const digits = (item.phone || '').replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) {
        invalid++;
        continue;
      }
      if (existingPhones.has(digits)) {
        duplicates++;
        continue;
      }
      existingPhones.add(digits);
      toInsert.push({
        id: createId('rcp'),
        name: (item.name || '').trim(),
        rawPhone: item.rawPhone || digits,
        phone: digits,
        customFields: item.customFields || {},
      });
      added++;
    }

    // Batch insert in chunks of 200 rows for fast CSV/Excel imports
    const CHUNK = 200;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const slice = toInsert.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let p = 1;
      for (const row of slice) {
        placeholders.push(
          `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, 'queued', '[]'::jsonb, 0, $${p++})`
        );
        values.push(
          row.id,
          campaignId,
          userId,
          row.name,
          row.rawPhone,
          row.phone,
          JSON.stringify(row.customFields),
          now
        );
      }
      await client.query(
        `INSERT INTO recipients
          (id, campaign_id, user_id, name, raw_phone, phone, custom_fields, status, whatsapp_message_ids, open_count, updated_at)
         VALUES ${placeholders.join(', ')}`,
        values
      );
    }

    await client.query(
      `UPDATE campaigns SET updated_at = $1 WHERE id = $2 AND user_id = $3`,
      [now, campaignId, userId]
    );
  });

  const updated = await getCampaignById(userId, campaignId);
  if (!updated) return null;
  return { added, duplicates, invalid, campaign: updated };
}

export async function getRecipientById(
  userId: string,
  campaignId: string,
  recipientId: string
): Promise<Recipient | null> {
  const res = await query<RecipientRow>(
    `SELECT id, campaign_id, user_id, name, raw_phone, phone, custom_fields, status,
            whatsapp_message_ids, dispatched_at, sent_at, delivered_at, read_at,
            opened_at, failed_reason, open_count, updated_at
     FROM recipients
     WHERE id = $1 AND campaign_id = $2 AND user_id = $3`,
    [recipientId, campaignId, userId]
  );
  return res.rows.length > 0 ? mapRecipientRow(res.rows[0]) : null;
}

export async function getNextQueuedRecipient(
  userId: string,
  campaignId: string
): Promise<Recipient | null> {
  const res = await query<RecipientRow>(
    `SELECT id, campaign_id, user_id, name, raw_phone, phone, custom_fields, status,
            whatsapp_message_ids, dispatched_at, sent_at, delivered_at, read_at,
            opened_at, failed_reason, open_count, updated_at
     FROM recipients
     WHERE campaign_id = $1 AND user_id = $2 AND status = 'queued'
     ORDER BY sort_order ASC
     LIMIT 1`,
    [campaignId, userId]
  );
  return res.rows.length > 0 ? mapRecipientRow(res.rows[0]) : null;
}

export async function saveRecipientState(
  userId: string,
  campaignId: string,
  recipient: Recipient
): Promise<void> {
  await query(
    `UPDATE recipients
     SET name = $1,
         phone = $2,
         status = $3,
         whatsapp_message_ids = $4::jsonb,
         dispatched_at = $5,
         sent_at = $6,
         delivered_at = $7,
         read_at = $8,
         opened_at = $9,
         failed_reason = $10,
         open_count = $11,
         updated_at = $12
     WHERE id = $13 AND campaign_id = $14 AND user_id = $15`,
    [
      recipient.name,
      recipient.phone,
      recipient.status,
      JSON.stringify(recipient.whatsappMessageIds || []),
      recipient.dispatchedAt,
      recipient.sentAt,
      recipient.deliveredAt,
      recipient.readAt,
      recipient.openedAt,
      recipient.failedReason,
      recipient.openCount,
      recipient.updatedAt,
      recipient.id,
      campaignId,
      userId,
    ]
  );

  await query(
    `UPDATE campaigns SET updated_at = $1 WHERE id = $2 AND user_id = $3`,
    [recipient.updatedAt, campaignId, userId]
  );
}

export async function indexWhatsAppMessageIds(
  userId: string,
  campaignId: string,
  recipientId: string,
  messageIds: string[]
): Promise<void> {
  if (messageIds.length === 0) return;
  for (const messageId of messageIds) {
    await query(
      `INSERT INTO recipient_message_index (message_id, user_id, campaign_id, recipient_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (message_id) DO NOTHING`,
      [messageId, userId, campaignId, recipientId]
    );
  }
}

export async function findRecipientByMessageId(
  userId: string,
  messageId: string
): Promise<{ campaignId: string; recipient: Recipient } | null> {
  const idxRes = await query<{ campaign_id: string; recipient_id: string }>(
    `SELECT campaign_id, recipient_id
     FROM recipient_message_index
     WHERE message_id = $1 AND user_id = $2`,
    [messageId, userId]
  );
  if (idxRes.rows.length === 0) return null;
  const { campaign_id, recipient_id } = idxRes.rows[0];
  const recipient = await getRecipientById(userId, campaign_id, recipient_id);
  if (!recipient) return null;
  return { campaignId: campaign_id, recipient };
}

export async function savePollDispatchRecord(
  userId: string,
  record: PollDispatchRecord
): Promise<void> {
  await query(
    `INSERT INTO poll_dispatches
      (poll_msg_id, user_id, campaign_id, recipient_id, secret_base64, creator_jid, creator_lid, target_jid, options)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (poll_msg_id)
     DO UPDATE SET options = EXCLUDED.options`,
    [
      record.pollMsgId,
      userId,
      record.campaignId,
      record.recipientId,
      record.secretBase64,
      record.creatorJid,
      record.creatorLid || null,
      record.targetJid,
      JSON.stringify(record.options),
    ]
  );
}

export async function getPollDispatchRecord(
  userId: string,
  pollMsgId: string
): Promise<PollDispatchRecord | undefined> {
  const res = await query<{
    poll_msg_id: string;
    campaign_id: string;
    recipient_id: string;
    secret_base64: string;
    creator_jid: string;
    creator_lid: string | null;
    target_jid: string;
    options: string[];
  }>(
    `SELECT poll_msg_id, campaign_id, recipient_id, secret_base64, creator_jid, creator_lid, target_jid, options
     FROM poll_dispatches
     WHERE poll_msg_id = $1 AND user_id = $2`,
    [pollMsgId, userId]
  );
  if (res.rows.length === 0) return undefined;
  const row = res.rows[0];
  return {
    pollMsgId: row.poll_msg_id,
    campaignId: row.campaign_id,
    recipientId: row.recipient_id,
    secretBase64: row.secret_base64,
    creatorJid: row.creator_jid,
    creatorLid: row.creator_lid || undefined,
    targetJid: row.target_jid,
    options: Array.isArray(row.options) ? row.options : [],
  };
}

export async function recordPollVoteInDb(
  userId: string,
  campaignId: string,
  recipient: Recipient,
  selectedOptions: string[],
  now: string
): Promise<CampaignPoll | null> {
  const campRes = await query<{ poll: CampaignPoll }>(
    `SELECT poll FROM campaigns WHERE id = $1 AND user_id = $2`,
    [campaignId, userId]
  );
  if (campRes.rows.length === 0) return null;

  const poll = hydratePoll(campRes.rows[0].poll);
  if (selectedOptions.length === 0) {
    delete poll.votes[recipient.id];
  } else {
    poll.votes[recipient.id] = {
      recipientId: recipient.id,
      phone: recipient.phone,
      name: recipient.name,
      selectedOptions,
      votedAt: now,
    };
  }
  poll.updatedAt = now;

  await query(
    `UPDATE campaigns SET poll = $1::jsonb, updated_at = $2 WHERE id = $3 AND user_id = $4`,
    [JSON.stringify(poll), now, campaignId, userId]
  );

  return poll;
}

export async function bulkUpdateRecipientsStatus(
  userId: string,
  campaignId: string,
  params: {
    fromStatuses?: DeliveryStatus[];
    toStatus: DeliveryStatus;
    recipientIds?: string[];
  }
): Promise<{ updatedCount: number; campaign: Campaign } | null> {
  const campaign = await getCampaignById(userId, campaignId);
  if (!campaign) return null;

  const now = new Date().toISOString();
  let updatedCount = 0;

  await withTransaction(async (client) => {
    for (const r of campaign.recipients) {
      const matchesIds =
        !params.recipientIds ||
        params.recipientIds.length === 0 ||
        params.recipientIds.includes(r.id);
      const matchesFrom =
        !params.fromStatuses ||
        params.fromStatuses.length === 0 ||
        params.fromStatuses.includes(r.status);

      if (!matchesIds || !matchesFrom) continue;

      r.status = params.toStatus;
      if (params.toStatus === 'sent') {
        r.dispatchedAt = r.dispatchedAt || now;
        r.sentAt = now;
        r.failedReason = null;
      } else if (params.toStatus === 'queued') {
        r.dispatchedAt = null;
        r.sentAt = null;
        r.deliveredAt = null;
        r.readAt = null;
        r.openedAt = null;
        r.failedReason = null;
      }
      r.updatedAt = now;

      await client.query(
        `UPDATE recipients
         SET status = $1, dispatched_at = $2, sent_at = $3, delivered_at = $4,
             read_at = $5, opened_at = $6, failed_reason = $7, updated_at = $8
         WHERE id = $9 AND campaign_id = $10 AND user_id = $11`,
        [
          r.status,
          r.dispatchedAt,
          r.sentAt,
          r.deliveredAt,
          r.readAt,
          r.openedAt,
          r.failedReason,
          now,
          r.id,
          campaignId,
          userId,
        ]
      );
      updatedCount++;
    }

    await client.query(
      `UPDATE campaigns SET updated_at = $1 WHERE id = $2 AND user_id = $3`,
      [now, campaignId, userId]
    );
  });

  campaign.updatedAt = now;
  return { updatedCount, campaign };
}

export async function deleteRecipient(
  userId: string,
  campaignId: string,
  recipientId: string
): Promise<number | null> {
  const camp = await query(
    `SELECT 1 FROM campaigns WHERE id = $1 AND user_id = $2`,
    [campaignId, userId]
  );
  if (camp.rows.length === 0) return null;

  await query(
    `DELETE FROM recipients WHERE id = $1 AND campaign_id = $2 AND user_id = $3`,
    [recipientId, campaignId, userId]
  );
  await query(
    `UPDATE campaigns SET updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [campaignId, userId]
  );

  const countRes = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM recipients WHERE campaign_id = $1 AND user_id = $2`,
    [campaignId, userId]
  );
  return Number(countRes.rows[0]?.cnt || 0);
}

export async function clearRecipients(
  userId: string,
  campaignId: string
): Promise<boolean> {
  const camp = await query(
    `SELECT 1 FROM campaigns WHERE id = $1 AND user_id = $2`,
    [campaignId, userId]
  );
  if (camp.rows.length === 0) return false;

  await query(
    `DELETE FROM recipients WHERE campaign_id = $1 AND user_id = $2`,
    [campaignId, userId]
  );
  await query(
    `UPDATE campaigns SET updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [campaignId, userId]
  );
  return true;
}

export async function addAttachmentsToCampaign(
  userId: string,
  campaignId: string,
  files: Array<{
    originalName: string;
    mimeType: string;
    size: number;
    buffer: Buffer;
  }>
): Promise<{ added: AttachmentItem[]; campaign: Campaign } | null> {
  const camp = await query(
    `SELECT 1 FROM campaigns WHERE id = $1 AND user_id = $2`,
    [campaignId, userId]
  );
  if (camp.rows.length === 0) return null;

  const now = new Date().toISOString();
  const added: AttachmentItem[] = [];

  await withTransaction(async (client) => {
    for (const file of files) {
      const id = createId('att', 16);
      await client.query(
        `INSERT INTO attachments
          (id, campaign_id, user_id, original_name, mime_type, size, file_data, download_count, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
        [
          id,
          campaignId,
          userId,
          file.originalName,
          file.mimeType,
          file.size,
          file.buffer,
          now,
        ]
      );
      added.push({
        id,
        originalName: file.originalName,
        storedName: id,
        mimeType: file.mimeType,
        size: file.size,
        uploadedAt: now,
        downloadCount: 0,
      });
    }
    await client.query(
      `UPDATE campaigns SET updated_at = $1 WHERE id = $2 AND user_id = $3`,
      [now, campaignId, userId]
    );
  });

  const campaign = await getCampaignById(userId, campaignId);
  if (!campaign) return null;
  return { added, campaign };
}

export async function getCampaignAttachmentsWithBuffers(
  userId: string,
  campaignId: string
): Promise<Array<{ originalName: string; mimeType: string; buffer: Buffer }>> {
  const res = await query<{
    original_name: string;
    mime_type: string;
    file_data: Buffer;
  }>(
    `SELECT original_name, mime_type, file_data
     FROM attachments
     WHERE campaign_id = $1 AND user_id = $2
     ORDER BY uploaded_at ASC`,
    [campaignId, userId]
  );
  return res.rows.map((r) => ({
    originalName: r.original_name,
    mimeType: r.mime_type,
    buffer: r.file_data,
  }));
}

export async function deleteAttachmentFromCampaign(
  userId: string,
  campaignId: string,
  attachmentId: string
): Promise<AttachmentItem[] | null> {
  const camp = await query(
    `SELECT 1 FROM campaigns WHERE id = $1 AND user_id = $2`,
    [campaignId, userId]
  );
  if (camp.rows.length === 0) return null;

  await query(
    `DELETE FROM attachments WHERE id = $1 AND campaign_id = $2 AND user_id = $3`,
    [attachmentId, campaignId, userId]
  );
  await query(
    `UPDATE campaigns SET updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [campaignId, userId]
  );

  const res = await query<AttachmentMetaRow>(
    `SELECT id, campaign_id, user_id, original_name, mime_type, size, download_count, uploaded_at
     FROM attachments
     WHERE campaign_id = $1 AND user_id = $2
     ORDER BY uploaded_at ASC`,
    [campaignId, userId]
  );
  return res.rows.map(mapAttachmentMetaRow);
}

export async function getAttachmentFileById(attachmentId: string): Promise<{
  id: string;
  userId: string;
  campaignId: string;
  originalName: string;
  mimeType: string;
  downloadCount: number;
  buffer: Buffer;
} | null> {
  const res = await query<{
    id: string;
    user_id: string;
    campaign_id: string;
    original_name: string;
    mime_type: string;
    download_count: number;
    file_data: Buffer;
  }>(
    `SELECT id, user_id, campaign_id, original_name, mime_type, download_count, file_data
     FROM attachments
     WHERE id = $1`,
    [attachmentId]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    id: r.id,
    userId: r.user_id,
    campaignId: r.campaign_id,
    originalName: r.original_name,
    mimeType: r.mime_type,
    downloadCount: Number(r.download_count) || 0,
    buffer: r.file_data,
  };
}

export async function incrementAttachmentDownloadCount(
  attachmentId: string
): Promise<number> {
  const res = await query<{ download_count: number }>(
    `UPDATE attachments
     SET download_count = download_count + 1
     WHERE id = $1
     RETURNING download_count`,
    [attachmentId]
  );
  return Number(res.rows[0]?.download_count || 1);
}

export async function getPublicRecipientView(
  campaignId: string,
  recipientId: string,
  shouldTrack: boolean
): Promise<{
  userId: string;
  campaignName: string;
  messageTemplate: string;
  attachments: AttachmentItem[];
  recipient: Recipient;
} | null> {
  const recRes = await query<RecipientRow>(
    `SELECT id, campaign_id, user_id, name, raw_phone, phone, custom_fields, status,
            whatsapp_message_ids, dispatched_at, sent_at, delivered_at, read_at,
            opened_at, failed_reason, open_count, updated_at
     FROM recipients
     WHERE id = $1 AND campaign_id = $2`,
    [recipientId, campaignId]
  );
  if (recRes.rows.length === 0) return null;

  const recipient = mapRecipientRow(recRes.rows[0]);
  const userId = recRes.rows[0].user_id;

  const campRes = await query<{ name: string; message: string }>(
    `SELECT name, message FROM campaigns WHERE id = $1 AND user_id = $2`,
    [campaignId, userId]
  );
  if (campRes.rows.length === 0) return null;

  const attRes = await query<AttachmentMetaRow>(
    `SELECT id, campaign_id, user_id, original_name, mime_type, size, download_count, uploaded_at
     FROM attachments
     WHERE campaign_id = $1 AND user_id = $2
     ORDER BY uploaded_at ASC`,
    [campaignId, userId]
  );

  if (shouldTrack) {
    const now = new Date().toISOString();
    recipient.status = 'opened';
    recipient.dispatchedAt = recipient.dispatchedAt || now;
    recipient.sentAt = recipient.sentAt || now;
    recipient.deliveredAt = recipient.deliveredAt || now;
    recipient.readAt = recipient.readAt || now;
    recipient.openedAt = recipient.openedAt || now;
    recipient.openCount += 1;
    recipient.failedReason = null;
    recipient.updatedAt = now;
    await saveRecipientState(userId, campaignId, recipient);
  }

  return {
    userId,
    campaignName: campRes.rows[0].name,
    messageTemplate: campRes.rows[0].message,
    attachments: attRes.rows.map(mapAttachmentMetaRow),
    recipient,
  };
}

export async function getUserAccountUsage(
  userId: string,
  accountPhone?: string | null
): Promise<MonthlyAccountUsage> {
  const accountKey = accountPhone || 'default';
  const monthKey = getMonthKey();
  const dayKey = getDayKey();

  const res = await query<{ period_type: string; sent_count: number }>(
    `SELECT period_type, sent_count
     FROM account_usage
     WHERE user_id = $1
       AND account_key = $2
       AND ((period_type = 'month' AND period_key = $3)
         OR (period_type = 'day' AND period_key = $4))`,
    [userId, accountKey, monthKey, dayKey]
  );

  let sentThisMonth = 0;
  let sentToday = 0;
  for (const row of res.rows) {
    if (row.period_type === 'month') sentThisMonth = Number(row.sent_count) || 0;
    if (row.period_type === 'day') sentToday = Number(row.sent_count) || 0;
  }

  return {
    monthKey,
    accountKey,
    sentThisMonth,
    sentToday,
    recommendedMonthlyLimit: RECOMMENDED_MONTHLY_LIMIT,
    newAccountMonthlyLimit: NEW_ACCOUNT_MONTHLY_LIMIT,
    recommendedDailyLimit: RECOMMENDED_DAILY_LIMIT,
    officialApiStarterDaily: OFFICIAL_API_STARTER_DAILY,
    freeAppBroadcastListCap: FREE_APP_BROADCAST_LIST_CAP,
  };
}

export async function incrementUserAccountUsage(
  userId: string,
  accountPhone?: string | null,
  count = 1
): Promise<MonthlyAccountUsage> {
  const accountKey = accountPhone || 'default';
  const monthKey = getMonthKey();
  const dayKey = getDayKey();

  await query(
    `INSERT INTO account_usage (user_id, account_key, period_type, period_key, sent_count)
     VALUES ($1, $2, 'month', $3, $4)
     ON CONFLICT (user_id, account_key, period_type, period_key)
     DO UPDATE SET sent_count = account_usage.sent_count + EXCLUDED.sent_count`,
    [userId, accountKey, monthKey, count]
  );

  await query(
    `INSERT INTO account_usage (user_id, account_key, period_type, period_key, sent_count)
     VALUES ($1, $2, 'day', $3, $4)
     ON CONFLICT (user_id, account_key, period_type, period_key)
     DO UPDATE SET sent_count = account_usage.sent_count + EXCLUDED.sent_count`,
    [userId, accountKey, dayKey, count]
  );

  return getUserAccountUsage(userId, accountKey);
}
