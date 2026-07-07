/**
 * Utilities — Helper functions.
 *
 * Contains: safe sanitizers, vulnerable merge, safe formatting.
 */

// ── Date Formatting (SAFE) ──

export function formatDate(date) {
    if (!date) return '';
    const d = new Date(date);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day}`;
}

export function formatRelativeTime(date) {
    const now = new Date();
    const then = new Date(date);
    const diff = Math.floor((now - then) / 1000);
    
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

// ── Sanitization (SAFE) ──

export function sanitizeHTML(input) {
    if (!input) return '';
    const div = document.createElement('div');
    div.textContent = input;  // SAFE: textContent escapes HTML
    return div.innerHTML;
}

export function sanitizeURL(url) {
    // SAFE: only allows http/https
    if (/^https?:\/\//.test(url)) {
        return url;
    }
    return '';
}

// ── Config Merging (VULNERABLE) ──

export function mergeConfig(target, source) {
    // VULNERABLE: No hasOwnProperty check — prototype pollutable
    for (let key in source) {
        if (typeof source[key] === 'object' && source[key] !== null) {
            if (!target[key]) {
                target[key] = {};
            }
            mergeConfig(target[key], source[key]);
        } else {
            target[key] = source[key];
        }
    }
}

// ── DOM Helpers (SAFE) ──

export function createElement(tag, attributes, children) {
    const el = document.createElement(tag);
    
    if (attributes) {
        for (const [key, value] of Object.entries(attributes)) {
            if (key === 'className') {
                el.className = value;
            } else if (key.startsWith('on')) {
                // SAFE: Don't set inline event handlers from untrusted data
                console.warn('Skipping inline event handler:', key);
            } else {
                el.setAttribute(key, value);
            }
        }
    }
    
    if (children) {
        if (typeof children === 'string') {
            el.textContent = children;  // SAFE: textContent, not innerHTML
        } else if (Array.isArray(children)) {
            children.forEach(child => {
                if (typeof child === 'string') {
                    el.appendChild(document.createTextNode(child));
                } else {
                    el.appendChild(child);
                }
            });
        }
    }
    
    return el;
}

// ── URL Parsing (POTENTIALLY VULNERABLE) ──

export function parseQueryString(queryString) {
    const params = {};
    if (!queryString) return params;
    
    const pairs = queryString.slice(1).split('&');
    for (const pair of pairs) {
        const [key, value] = pair.split('=');
        params[decodeURIComponent(key || '')] = decodeURIComponent(value || '');
    }
    
    return params;
}

// ── Validation ──

export function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validateURL(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}
