import { debug } from './debug';
let initialized = false;
let frameGuardEnforced = false;

/**
 * Clickjacking defense. The app deploys as a static site (GitHub Pages), where the
 * server-side `X-Frame-Options`/`frame-ancestors` headers in hooks.server.ts are never
 * sent, and `frame-ancestors` is ignored when delivered via the CSP <meta> tag. So we
 * enforce a frame buster in script: if the app is loaded inside a frame, try to break
 * out, and if that is blocked (cross-origin top), refuse to render.
 */
export const enforceFrameGuard = (): void => {
    if (typeof window === 'undefined' || frameGuardEnforced) {
        return;
    }
    frameGuardEnforced = true;

    try {
        if (window.self === window.top) {
            return;
        }
    } catch {
        // Accessing window.top threw — we are cross-origin framed. Fall through to lockdown.
    }

    debug.warn('Frame guard: app loaded inside a frame — refusing to render');
    try {
        // Same-origin framing: navigate the top frame to break out.
        if (window.top) {
            window.top.location = window.self.location.href;
            return;
        }
    } catch {
        // Cross-origin: cannot navigate top. Blank the document so nothing is clickable.
    }
    try {
        document.documentElement.style.display = 'none';
        // Clear without innerHTML (banned by lint) — replaceChildren empties the node safely.
        document.body?.replaceChildren();
    } catch {
        /* nothing more we can do */
    }
};

interface CSPEventSummary {
    blockedURI: string;
    violatedDirective: string;
    effectiveDirective: string;
    disposition: SecurityPolicyViolationEvent['disposition'];
}

const summarizeEvent = (event: SecurityPolicyViolationEvent): CSPEventSummary => ({
    blockedURI: event.blockedURI || 'inline',
    violatedDirective: event.violatedDirective,
    effectiveDirective: event.effectiveDirective,
    disposition: event.disposition,
});

/**
 * Attach listeners for browser security signals so we can react quickly to
 * suspicious behaviour (e.g. CSP violations) by locking the profile and
 * removing sensitive material from memory.
 */
export const initializeSecurityMonitor = (): void => {
    if (typeof window === 'undefined' || initialized) {
        return;
    }

    initialized = true;

    window.addEventListener('securitypolicyviolation', async (event) => {
        debug.warn('CSP violation detected and blocked', summarizeEvent(event));

        try {
            const { profileManager } = await import('./profile-manager');
            // Locking clears keys from memory and stops auto unlock timers.
            await profileManager.lockProfile();
        } catch (error) {
            debug.error('Failed to lock profile after CSP violation', error);
        }

        try {
            const { secureKeyManager } = await import('./secure-key-manager');
            secureKeyManager.lockSession();
        } catch (error) {
            debug.error('Failed to lock SecureKeyManager after CSP violation', error);
        }
    });

    // Provide visibility into unexpected runtime errors to aid forensic analysis.
    window.addEventListener('error', (event) => {
        if (event.filename && !event.filename.includes(window.location.origin)) {
            debug.warn('Runtime error from unexpected origin', {
                message: event.message,
                source: event.filename,
                lineno: event.lineno,
            });
        }
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        if (reason && typeof reason === 'object' && 'message' in reason) {
            const message = String((reason as { message?: unknown }).message);
            if (/script/i.test(message) || /csp/i.test(message)) {
                debug.warn('Suspicious unhandled rejection', { message });
            }
        }
    });
};
