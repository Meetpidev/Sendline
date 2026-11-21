import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { query } from './db.ts';

async function readKey(userId: string, keyId: string): Promise<unknown | null> {
  const res = await query<{ data_json: string }>(
    `SELECT data_json FROM whatsapp_auth_state WHERE user_id = $1 AND key_id = $2`,
    [userId, keyId]
  );
  if (res.rows.length === 0) return null;
  try {
    return JSON.parse(res.rows[0].data_json, BufferJSON.reviver);
  } catch {
    return null;
  }
}

async function writeKey(userId: string, keyId: string, data: unknown): Promise<void> {
  const serialized = JSON.stringify(data, BufferJSON.replacer);
  await query(
    `INSERT INTO whatsapp_auth_state (user_id, key_id, data_json, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, key_id)
     DO UPDATE SET data_json = EXCLUDED.data_json, updated_at = NOW()`,
    [userId, keyId, serialized]
  );
}

async function removeKey(userId: string, keyId: string): Promise<void> {
  await query(
    `DELETE FROM whatsapp_auth_state WHERE user_id = $1 AND key_id = $2`,
    [userId, keyId]
  );
}

export async function hasSavedPostgresAuth(userId: string): Promise<boolean> {
  const res = await query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM whatsapp_auth_state WHERE user_id = $1 AND key_id = 'creds'
     ) AS exists`,
    [userId]
  );
  return Boolean(res.rows[0]?.exists);
}

export async function listUsersWithSavedWhatsAppAuth(): Promise<string[]> {
  const res = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM whatsapp_auth_state WHERE key_id = 'creds'`
  );
  return res.rows.map((r) => r.user_id);
}

export async function clearPostgresAuthState(userId: string): Promise<void> {
  await query(`DELETE FROM whatsapp_auth_state WHERE user_id = $1`, [userId]);
}

export async function usePostgresAuthState(userId: string): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const existingCreds = (await readKey(userId, 'creds')) as AuthenticationCreds | null;
  const creds: AuthenticationCreds = existingCreds || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          if (ids.length === 0) return data;

          const keyIds = ids.map((id) => `${type}-${id}`);
          const res = await query<{ key_id: string; data_json: string }>(
            `SELECT key_id, data_json
             FROM whatsapp_auth_state
             WHERE user_id = $1 AND key_id = ANY($2::text[])`,
            [userId, keyIds]
          );

          const prefix = `${type}-`;
          for (const row of res.rows) {
            const rawId = row.key_id.slice(prefix.length);
            try {
              let value = JSON.parse(row.data_json, BufferJSON.reviver);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              if (value) {
                data[rawId] = value as SignalDataTypeMap[T];
              }
            } catch {
              // skip corrupt entry
            }
          }
          return data;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
            const entries = data[category];
            if (!entries) continue;
            for (const id of Object.keys(entries)) {
              const value = entries[id];
              const keyId = `${category}-${id}`;
              if (value) {
                tasks.push(writeKey(userId, keyId, value));
              } else {
                tasks.push(removeKey(userId, keyId));
              }
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeKey(userId, 'creds', creds);
    },
  };
}
