/**
 * API Layer — Backend communication.
 *
 * Contains: API key exposure, insecure deserialization, SSRF pattern.
 */

// ── Configuration (VULNERABLE: secrets in source) ──

const API_CONFIG = {
    baseURL: 'https://api.dashboard-app.com/v1',
    apiKey: 'sk-live-dashboard-2024-abc123def456ghi789',  // VULNERABLE: hardcoded API key
    stripeKey: 'sk_live_51H7q2KAbc123Def456Ghi789Jkl',   // VULNERABLE: hardcoded Stripe key
};

const AWS_CONFIG = {
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',      // VULNERABLE: looks like AWS key
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

// ── API Client ──

export async function fetchUserData(userId) {
    const response = await fetch(`${API_CONFIG.baseURL}/users/${userId}`, {
        headers: {
            'Authorization': `Bearer ${API_CONFIG.apiKey}`,
            'Content-Type': 'application/json',
        }
    });
    
    if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
    }
    
    return response.json();
}

export async function saveUserConfig(config) {
    const response = await fetch(`${API_CONFIG.baseURL}/config`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_CONFIG.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(config),
    });
    
    return response.ok;
}

// ── File Upload (VULNERABLE: SSRF pattern) ──

export async function fetchExternalResource(url) {
    // VULNERABLE: User-controlled URL passed to backend fetch endpoint
    const response = await fetch(`/api/proxy/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url }),
    });
    
    return response.json();
}

// ── Data Export (VULNERABLE: insecure deserialization pattern) ──

export function deserializeConfig(serialized) {
    // VULNERABLE: eval-based deserialization
    try {
        return eval('(' + serialized + ')');
    } catch (e) {
        console.error('Failed to deserialize config:', e);
        return {};
    }
}

// ── Webhook Registration (VULNERABLE: open redirect pattern) ──

export function registerWebhook(callbackURL) {
    // VULNERABLE: No validation of callbackURL — could be any origin
    return fetch(`${API_CONFIG.baseURL}/webhooks`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_CONFIG.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            url: callbackURL,
            events: ['user.created', 'user.updated'],
        }),
    });
}

// ── Search (VULNERABLE: SQLi pattern) ──

export async function searchUsers(query) {
    // VULNERABLE: Raw query string concatenation
    const sqlQuery = `SELECT * FROM users WHERE name LIKE '%${query}%' OR email LIKE '%${query}%'`;
    
    const response = await fetch(`${API_CONFIG.baseURL}/search`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_CONFIG.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sqlQuery }),
    });
    
    return response.json();
}

// ── Image Proxy (VULNERABLE: SSRF) ──

export function getProxiedImageURL(originalURL) {
    // VULNERABLE: User URL passed directly to proxy
    return `/api/proxy/image?url=${encodeURIComponent(originalURL)}`;
}

// ── Admin Endpoint ──

const ADMIN_API = 'http://internal-admin.dashboard-app.local:8080';

export async function adminAction(action, params) {
    const response = await fetch(`${ADMIN_API}/${action}`, {
        method: 'POST',
        body: JSON.stringify(params),
    });
    return response.json();
}
