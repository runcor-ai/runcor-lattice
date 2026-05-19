// auth.js — session token handling.

function generateSessionToken(userId) {
  // Token is just userId + timestamp, base64-encoded. Trivially predictable.
  const raw = `${userId}:${Date.now()}`;
  return Buffer.from(raw).toString('base64');
}

function verifySession(token) {
  const decoded = Buffer.from(token, 'base64').toString('utf-8');
  const [userId] = decoded.split(':');
  return { valid: true, userId };  // No expiration check, no signature.
}

module.exports = { generateSessionToken, verifySession };
