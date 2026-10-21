import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

export const MAX_DAYS_REQUESTED = 730; // Plaid's ceiling for transactions.days_requested.

export function daysRequested(env = process.env) {
  const raw = env.PLAID_TRANSACTIONS_DAYS_REQUESTED;
  const value = raw === undefined || raw === '' ? MAX_DAYS_REQUESTED : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_DAYS_REQUESTED) {
    throw new Error(`PLAID_TRANSACTIONS_DAYS_REQUESTED must be an integer from 1 to ${MAX_DAYS_REQUESTED}`);
  }
  return value;
}

export function createPlaidClient(env = process.env) {
  const name = (env.PLAID_ENV ?? 'production').toLowerCase();
  if (!['sandbox', 'production'].includes(name)) throw new Error('PLAID_ENV must be sandbox or production');
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) return null;
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[name],
    baseOptions: { headers: { 'PLAID-CLIENT-ID': env.PLAID_CLIENT_ID, 'PLAID-SECRET': env.PLAID_SECRET, 'Plaid-Version': env.PLAID_VERSION ?? '2020-09-14' } },
  }));
}

/** Reduce Plaid/axios errors to safe, useful fields. Never includes credentials or tokens. */
export function plaidError(error) {
  const data = error?.response?.data;
  if (data && typeof data === 'object' && data.error_code) {
    const { error_type, error_code, error_message, display_message, request_id, suggested_action } = data;
    return { code: error_code, type: error_type, message: error_message, displayMessage: display_message ?? null, suggestedAction: suggested_action ?? null, plaidRequestId: request_id };
  }
  if (error?.code && /^[A-Z_]+$/.test(error.code)) return { code: error.code, message: error.message };
  return { code: 'PLAID_REQUEST_FAILED', message: 'The Plaid request failed.' };
}
