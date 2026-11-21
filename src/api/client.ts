import type {
  AttachmentItem,
  AuthUser,
  Campaign,
  CampaignSummary,
  DeliveryStatus,
  MonthlyAccountUsage,
  Recipient,
  ServerDispatchJobState,
  WhatsAppSessionState,
} from '../types';

export class ApiError extends Error {
  public status: number;
  public needsWhatsAppAuth?: boolean;
  constructor(message: string, status: number, needsWhatsAppAuth?: boolean) {
    super(message);
    this.status = status;
    this.needsWhatsAppAuth = needsWhatsAppAuth;
  }
}

// Keep Bearer session token strictly in JS memory (never localStorage/sessionStorage).
// Returning visits across reloads are seamlessly restored by the server's HttpOnly cookie.
let inMemoryToken: string | null = null;

export function setAuthToken(token: string | null): void {
  inMemoryToken = token;
}

export function getAuthToken(): string | null {
  return inMemoryToken;
}

function buildAuthHeaders(extra?: HeadersInit): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Requested-With': 'Sendline',
  };
  if (inMemoryToken) {
    headers.Authorization = `Bearer ${inMemoryToken}`;
  }
  if (extra) {
    if (extra instanceof Headers) {
      extra.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(extra)) {
      for (const [k, v] of extra) headers[k] = v;
    } else {
      Object.assign(headers, extra);
    }
  }
  return headers;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: buildAuthHeaders({
      'Content-Type': 'application/json',
      ...(init?.headers &&
      !(init.headers instanceof Headers) &&
      !Array.isArray(init.headers)
        ? (init.headers as Record<string, string>)
        : {}),
    }),
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let needsWhatsAppAuth = false;
    try {
      const body = (await res.json()) as {
        error?: string;
        needsWhatsAppAuth?: boolean;
      };
      if (body?.error) msg = body.error;
      if (body?.needsWhatsAppAuth) needsWhatsAppAuth = true;
    } catch {
      // ignore non-JSON body
    }
    throw new ApiError(msg, res.status, needsWhatsAppAuth);
  }
  return (await res.json()) as T;
}

export const api = {
  // Authentication & Workspace Session
  getMe: () =>
    jsonRequest<{
      databaseConfigured: boolean;
      databaseReady: boolean;
      databaseError: string | null;
      user: AuthUser | null;
    }>('/api/auth/me'),

  register: async (payload: { name: string; email: string; password: string }) => {
    const res = await jsonRequest<{ token: string; user: AuthUser }>(
      '/api/auth/register',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    setAuthToken(res.token);
    return res;
  },

  login: async (payload: { email: string; password: string }) => {
    const res = await jsonRequest<{ token: string; user: AuthUser }>(
      '/api/auth/login',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    setAuthToken(res.token);
    return res;
  },

  logout: async () => {
    try {
      await jsonRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
    } finally {
      setAuthToken(null);
    }
  },

  // WhatsApp Linked-Device Direct Connection (Per-User Isolated)
  getWhatsAppStatus: () =>
    jsonRequest<{
      whatsapp: WhatsAppSessionState;
      usage: MonthlyAccountUsage;
      dispatchJob: ServerDispatchJobState;
    }>('/api/whatsapp/status'),

  connectWhatsApp: () =>
    jsonRequest<{ whatsapp: WhatsAppSessionState }>('/api/whatsapp/connect', {
      method: 'POST',
    }),

  pairWhatsAppWithPhone: (phone: string) =>
    jsonRequest<{ whatsapp: WhatsAppSessionState }>('/api/whatsapp/pair', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),

  disconnectWhatsApp: () =>
    jsonRequest<{ whatsapp: WhatsAppSessionState }>('/api/whatsapp/disconnect', {
      method: 'POST',
    }),

  // Direct Zero-Redirect Sending
  sendRecipientDirect: (campaignId: string, recipientId: string, origin: string) =>
    jsonRequest<{ recipient: Recipient }>(
      `/api/campaigns/${encodeURIComponent(campaignId)}/recipients/${encodeURIComponent(recipientId)}/send`,
      {
        method: 'POST',
        body: JSON.stringify({ origin }),
      }
    ),

  startDirectDispatch: (campaignId: string, origin: string) =>
    jsonRequest<{ dispatchJob: ServerDispatchJobState }>(
      `/api/campaigns/${encodeURIComponent(campaignId)}/dispatch/start`,
      {
        method: 'POST',
        body: JSON.stringify({ origin }),
      }
    ),

  pauseDirectDispatch: (campaignId: string) =>
    jsonRequest<{ dispatchJob: ServerDispatchJobState }>(
      `/api/campaigns/${encodeURIComponent(campaignId)}/dispatch/pause`,
      { method: 'POST' }
    ),

  resumeDirectDispatch: (campaignId: string) =>
    jsonRequest<{ dispatchJob: ServerDispatchJobState }>(
      `/api/campaigns/${encodeURIComponent(campaignId)}/dispatch/resume`,
      { method: 'POST' }
    ),

  stopDirectDispatch: (campaignId: string) =>
    jsonRequest<{ dispatchJob: ServerDispatchJobState }>(
      `/api/campaigns/${encodeURIComponent(campaignId)}/dispatch/stop`,
      { method: 'POST' }
    ),

  // Campaign CRUD
  listCampaigns: () => jsonRequest<{ campaigns: CampaignSummary[] }>('/api/campaigns'),

  getCampaign: (id: string) =>
    jsonRequest<{ campaign: Campaign }>(`/api/campaigns/${encodeURIComponent(id)}`),

  createCampaign: (payload: {
    name: string;
    message?: string;
    defaultCountryCode?: string;
  }) =>
    jsonRequest<{ campaign: Campaign }>('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateCampaign: (
    id: string,
    payload: Partial<
      Pick<Campaign, 'name' | 'message' | 'defaultCountryCode' | 'settings' | 'poll'>
    >
  ) =>
    jsonRequest<{ campaign: Campaign }>(`/api/campaigns/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  resetPollVotes: (id: string) =>
    jsonRequest<{ poll: Campaign['poll']; campaign: Campaign }>(
      `/api/campaigns/${encodeURIComponent(id)}/poll/reset-votes`,
      { method: 'POST' }
    ),

  duplicateCampaign: (id: string) =>
    jsonRequest<{ campaign: Campaign }>(
      `/api/campaigns/${encodeURIComponent(id)}/duplicate`,
      { method: 'POST' }
    ),

  deleteCampaign: (id: string) =>
    jsonRequest<{ ok: boolean; campaigns: CampaignSummary[] }>(
      `/api/campaigns/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    ),

  importRecipients: (
    campaignId: string,
    contacts: Array<{
      name?: string;
      rawPhone?: string;
      phone: string;
      customFields?: Record<string, string>;
    }>,
    replaceExisting = false
  ) =>
    jsonRequest<{
      added: number;
      duplicates: number;
      invalid: number;
      totalRecipients: number;
      campaign: Campaign;
    }>(`/api/campaigns/${encodeURIComponent(campaignId)}/recipients/import`, {
      method: 'POST',
      body: JSON.stringify({ contacts, replaceExisting }),
    }),

  updateRecipient: (
    campaignId: string,
    recipientId: string,
    payload: {
      status?: DeliveryStatus;
      failedReason?: string | null;
      name?: string;
      phone?: string;
    }
  ) =>
    jsonRequest<{ recipient: Recipient }>(
      `/api/campaigns/${encodeURIComponent(campaignId)}/recipients/${encodeURIComponent(recipientId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }
    ),

  bulkUpdateStatus: (
    campaignId: string,
    payload: {
      fromStatuses?: DeliveryStatus[];
      toStatus: DeliveryStatus;
      recipientIds?: string[];
    }
  ) =>
    jsonRequest<{ updatedCount: number; campaign: Campaign }>(
      `/api/campaigns/${encodeURIComponent(campaignId)}/recipients/bulk-status`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),

  deleteRecipient: (campaignId: string, recipientId: string) =>
    jsonRequest<{ ok: boolean; totalRecipients: number }>(
      `/api/campaigns/${encodeURIComponent(campaignId)}/recipients/${encodeURIComponent(recipientId)}`,
      { method: 'DELETE' }
    ),

  clearRecipients: (campaignId: string) =>
    jsonRequest<{ ok: boolean }>(
      `/api/campaigns/${encodeURIComponent(campaignId)}/recipients`,
      { method: 'DELETE' }
    ),

  uploadAttachments: async (
    campaignId: string,
    files: File[]
  ): Promise<{ attachments: AttachmentItem[]; campaign: Campaign }> => {
    const form = new FormData();
    for (const file of files) {
      form.append('files', file);
    }
    const res = await fetch(
      `/api/campaigns/${encodeURIComponent(campaignId)}/attachments`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: buildAuthHeaders(),
        body: form,
      }
    );
    if (!res.ok) {
      let msg = `Upload failed (${res.status})`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) msg = body.error;
      } catch {
        // ignore
      }
      throw new ApiError(msg, res.status);
    }
    return (await res.json()) as { attachments: AttachmentItem[]; campaign: Campaign };
  },

  deleteAttachment: (campaignId: string, attachmentId: string) =>
    jsonRequest<{ ok: boolean; attachments: AttachmentItem[] }>(
      `/api/campaigns/${encodeURIComponent(campaignId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: 'DELETE' }
    ),
};
