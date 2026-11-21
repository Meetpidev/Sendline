export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export type DeliveryStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'opened'
  | 'dispatched'
  | 'failed'
  | 'skipped';

export type PollType =
  | 'single_choice'
  | 'multiple_choice'
  | 'yes_no'
  | 'rating';

export interface PollVoteRecord {
  recipientId: string;
  phone: string;
  name: string;
  selectedOptions: string[];
  votedAt: string;
}

export interface CampaignPoll {
  enabled: boolean;
  pollType: PollType;
  question: string;
  options: string[];
  /** 1 = single choice, 0 = unlimited multiple choice, 2..N = max selections */
  selectableCount: number;
  /** Latest vote per recipientId */
  votes: Record<string, PollVoteRecord>;
  updatedAt: string;
}

export interface PollDispatchRecord {
  pollMsgId: string;
  campaignId: string;
  recipientId: string;
  secretBase64: string;
  creatorJid: string;
  creatorLid?: string;
  targetJid: string;
  options: string[];
}

export interface AttachmentItem {
  id: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  downloadCount: number;
}

export interface Recipient {
  id: string;
  name: string;
  rawPhone: string;
  phone: string; // Normalized E.164 digits only (e.g. 919876543210)
  customFields: Record<string, string>;
  status: DeliveryStatus;
  whatsappMessageIds?: string[];
  dispatchedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  openedAt: string | null;
  failedReason: string | null;
  openCount: number;
  updatedAt: string;
}

export interface DispatchSettings {
  mode: 'queue' | 'burst';
  intervalSeconds: number;
  burstSize: number;
  includeMediaLink: boolean;
  includeTrackingLinkWhenNoMedia: boolean;
  autoConfirmSent: boolean;
}

export interface Campaign {
  id: string;
  name: string;
  message: string;
  defaultCountryCode: string;
  createdAt: string;
  updatedAt: string;
  settings: DispatchSettings;
  poll: CampaignPoll;
  attachments: AttachmentItem[];
  recipients: Recipient[];
}

export interface CampaignSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  totalRecipients: number;
  attachmentCount: number;
  pollEnabled: boolean;
  pollVoterCount: number;
  counts: Record<DeliveryStatus, number>;
}

export interface ParsedCsvResult {
  headers: string[];
  rows: Record<string, string>[];
  totalRows: number;
}

export type WhatsAppConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_ready'
  | 'connected';

export interface WhatsAppSessionState {
  status: WhatsAppConnectionStatus;
  qrDataUrl: string | null;
  pairingCode: string | null;
  accountName: string | null;
  accountPhone: string | null;
  lastError: string | null;
}

export interface MonthlyAccountUsage {
  monthKey: string; // e.g. "2026-11"
  accountKey: string;
  sentThisMonth: number;
  sentToday: number;
  recommendedMonthlyLimit: number; // 6,000 / month for established linked accounts (~200/day)
  newAccountMonthlyLimit: number; // 1,500 / month for new accounts (<30 days, ~50/day)
  recommendedDailyLimit: number; // 200 / day safe pacing
  officialApiStarterDaily: number; // 250 unique users / 24h (Meta API Tier 0)
  freeAppBroadcastListCap: number; // 256 contacts / list on WhatsApp mobile app
}

export interface ServerDispatchJobState {
  campaignId: string | null;
  status: 'idle' | 'running' | 'paused' | 'completed';
  currentRecipientId: string | null;
  currentPhone: string | null;
  processedCount: number;
  totalCount: number;
  sentCount: number;
  failedCount: number;
  nextSendInSeconds: number;
}

export interface RealtimeEvent {
  type:
    | 'connected'
    | 'campaign_updated'
    | 'recipient_updated'
    | 'recipients_bulk_updated'
    | 'recipient_opened'
    | 'attachment_downloaded'
    | 'poll_vote_updated'
    | 'whatsapp_status'
    | 'usage_updated'
    | 'dispatch_job';
  campaignId?: string;
  recipientId?: string;
  recipient?: Recipient;
  attachmentId?: string;
  downloadCount?: number;
  poll?: CampaignPoll;
  voterLabel?: string;
  selectedOptions?: string[];
  whatsapp?: WhatsAppSessionState;
  usage?: MonthlyAccountUsage;
  dispatchJob?: ServerDispatchJobState;
  timestamp: string;
}
