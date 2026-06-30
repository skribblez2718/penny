/**
 * Dashboard App — Main application controller.
 * 
 * Handles navigation, user profile rendering, and settings management.
 * Contains: DOM XSS, prototype pollution entry points.
 */

import { fetchUserData, saveUserConfig } from './api.js';
import { formatDate, mergeConfig, sanitizeHTML } from './utils.js';

// ── Application State ──

const DEFAULT_CONFIG = {
    theme: 'light',
    fontSize: 14,
    showNotifications: true,
};

let appConfig = { ...DEFAULT_CONFIG };

// ── Router ──

function handleRoute() {
    const hash = location.hash.slice(1);  // SOURCE: attacker-controlled
    const params = new URLSearchParams(location.search);  // SOURCE: attacker-controlled
    
    switch (hash) {
        case 'profile':
            renderProfile(params.get('id'));
            break;
        case 'settings':
            renderSettings();
            break;
        case 'search':
            renderSearchResults(params.get('q'));
            break;
        default:
            renderDashboard(hash);
    }
}

// ── Profile Rendering ──

async function renderProfile(userId) {
    const user = await fetchUserData(userId);
    const container = document.getElementById('content');
    
    // VULNERABLE: DOM XSS — user.name flows into innerHTML without sanitization
    container.innerHTML = `
        <div class="profile">
            <h1>${user.name}</h1>
            <p class="bio">${user.bio}</p>
            <p class="email">${user.email}</p>
        </div>
    `;
}

// ── Settings Rendering ──

function renderSettings() {
    const container = document.getElementById('content');
    const params = new URLSearchParams(location.search);
    
    // VULNERABLE: DOM XSS — location.search → document.write
    const redirect = params.get('redirect');
    if (redirect) {
        document.write('<p>Redirecting to: ' + redirect + '</p>');
    }
    
    // VULNERABLE: Prototype pollution — user config merged without hasOwnProperty
    const userConfig = loadUserConfig();
    mergeConfig(appConfig, userConfig);
    
    // Check if theme was polluted
    if (appConfig.theme === 'dark') {
        document.body.classList.add('dark-mode');
    }
    
    container.innerHTML = renderSettingsForm();
}

// ── Settings Form ──

function renderSettingsForm() {
    return `
        <form id="settings-form">
            <label>Theme:
                <select name="theme">
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                </select>
            </label>
            <label>Font Size:
                <input type="number" name="fontSize" value="${appConfig.fontSize}">
            </label>
            <button type="submit">Save</button>
        </form>
    `;
}

// ── Search Results ──

function renderSearchResults(query) {
    const container = document.getElementById('content');
    
    if (!query) {
        container.innerHTML = '<p>Please enter a search term.</p>';
        return;
    }
    
    // VULNERABLE: DOM XSS — raw query inserted into HTML
    container.innerHTML = `
        <h2>Search Results for "${query}"</h2>
        <p>No results found. Try a different search term.</p>
    `;
    
    // SAFE: using textContent (auto-escaped)
    const heading = document.getElementById('search-heading');
    if (heading) {
        heading.textContent = `Search: ${query}`;  // SAFE — textContent escapes
    }
}

// ── Dashboard ──

function renderDashboard(title) {
    const container = document.getElementById('content');
    const user = JSON.parse(localStorage.getItem('currentUser') || '{}');
    
    // SAFE: sanitized before insertion
    const safeTitle = sanitizeHTML(title || 'Dashboard');
    const safeUser = sanitizeHTML(user.name || 'Guest');
    
    container.innerHTML = `
        <h1>${safeTitle}</h1>
        <p>Welcome back, ${safeUser}!</p>
        <div class="stats">
            <div class="stat">Projects: 12</div>
            <div class="stat">Tasks: 5</div>
        </div>
    `;
}

// ── User Config Loading ──

function loadUserConfig() {
    try {
        // VULNERABLE: Reads from localStorage — attacker can set this
        const raw = localStorage.getItem('userConfig');
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        return {};
    }
}

// ── Event Handlers ──

window.addEventListener('hashchange', handleRoute);
window.addEventListener('DOMContentLoaded', handleRoute);

// Listen for config updates from other tabs
window.addEventListener('message', (event) => {
    // VULNERABLE: postMessage without origin validation
    if (event.data && event.data.type === 'configUpdate') {
        mergeConfig(appConfig, event.data.config);
        renderSettings();
    }
});

// Listen for config updates via BroadcastChannel
const channel = new BroadcastChannel('app-config');
channel.onmessage = (event) => {
    // VULNERABLE: BroadcastChannel data → eval
    if (event.data && event.data.script) {
        eval(event.data.script);
    }
};
