import { google } from 'googleapis';
import { kvGet, kvSet } from './store.js';

const TOKEN_KEY = 'google_tokens';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
];

export function getOAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  const tokens = kvGet(TOKEN_KEY);
  if (tokens) client.setCredentials(tokens);

  // Persist refreshed access tokens automatically
  client.on('tokens', (newTokens) => {
    const merged = { ...(kvGet(TOKEN_KEY) ?? {}), ...newTokens };
    kvSet(TOKEN_KEY, merged);
  });

  return client;
}

export function getAuthUrl() {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force refresh_token on every consent
    scope: SCOPES,
  });
}

export async function handleOAuthCallback(req, res) {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    kvSet(TOKEN_KEY, tokens);
    res.send('✅ Google authorized. You can close this tab.');
  } catch (err) {
    console.error('OAuth callback failed:', err);
    res.status(500).send(`OAuth failed: ${err.message}`);
  }
}

export function isAuthorized() {
  return kvGet(TOKEN_KEY) !== null;
}

export function calendar() {
  return google.calendar({ version: 'v3', auth: getOAuthClient() });
}

export function gmail() {
  return google.gmail({ version: 'v1', auth: getOAuthClient() });
}
