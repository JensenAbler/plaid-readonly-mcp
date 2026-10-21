import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Item store. Plaid access tokens are sealed with AES-256-GCM under a key kept outside the data directory. */
export function createStore({ dataDirectory, tokenKey }) {
  if (!Buffer.isBuffer(tokenKey) || tokenKey.length !== 32) throw new Error('A 32-byte token encryption key is required');
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDirectory, 'items.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS items (
      item_id TEXT PRIMARY KEY, institution_id TEXT, institution_name TEXT,
      sealed_access_token TEXT NOT NULL, days_requested INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
  const seal = (plain) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', tokenKey, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  };
  const open = (sealed) => {
    const raw = Buffer.from(sealed, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', tokenKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  };
  const publicRow = (row) => row && ({
    itemId: row.item_id, institutionId: row.institution_id, institutionName: row.institution_name,
    daysRequested: row.days_requested, linkedAt: row.created_at, updatedAt: row.updated_at,
  });
  return {
    upsertItem({ itemId, accessToken, institutionId = null, institutionName = null, daysRequested = null }) {
      const at = new Date().toISOString();
      db.prepare(`INSERT INTO items(item_id,institution_id,institution_name,sealed_access_token,days_requested,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET institution_id=excluded.institution_id,
        institution_name=excluded.institution_name, sealed_access_token=excluded.sealed_access_token,
        days_requested=COALESCE(excluded.days_requested, days_requested), updated_at=excluded.updated_at`)
        .run(itemId, institutionId, institutionName, seal(accessToken), daysRequested, at, at);
    },
    listItems() { return db.prepare('SELECT * FROM items ORDER BY created_at').all().map(publicRow); },
    getItem(itemId) { return publicRow(db.prepare('SELECT * FROM items WHERE item_id=?').get(itemId)); },
    accessToken(itemId) {
      const row = db.prepare('SELECT sealed_access_token FROM items WHERE item_id=?').get(itemId);
      if (!row) throw Object.assign(new Error(`Unknown item_id ${itemId}. Use plaid_list_items.`), { code: 'UNKNOWN_ITEM' });
      return open(row.sealed_access_token);
    },
    deleteItem(itemId) { db.prepare('DELETE FROM items WHERE item_id=?').run(itemId); },
    close() { db.close(); },
  };
}
