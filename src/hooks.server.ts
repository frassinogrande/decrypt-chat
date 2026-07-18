/**
 * SvelteKit server hooks: security headers and request locale.
 */

import type { Handle } from '@sveltejs/kit';
import { determineRequestLocale } from '$lib/i18n/config';

const isProduction = process.env.NODE_ENV === 'production';

const getSecurityHeaders = (): Record<string, string> => {
    return {
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block',
        'Permissions-Policy':
            'geolocation=(), microphone=(self), camera=(self), usb=(), serial=(), payment=()',
        'Strict-Transport-Security': isProduction
            ? 'max-age=31536000; includeSubDomains; preload'
            : 'max-age=0', // Don't enforce HSTS in development
    };
};

export const handle: Handle = async ({ event, resolve }) => {
    const locale = determineRequestLocale(event);
    event.locals.locale = locale;

    const response = await resolve(event);

    const securityHeaders = getSecurityHeaders();

    Object.entries(securityHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
    });

    response.headers.set('Content-Language', locale);

    // Remove server identification headers for security
    response.headers.delete('server');
    response.headers.delete('x-powered-by');

    return response;
};

export const handleError = ({ error, event }: { error: unknown; event: any }) => {
    // Log errors securely (don't expose sensitive information)
    console.error('Server error:', {
        message: (error instanceof Error ? error.message : String(error)) || 'Unknown error',
        url: event.url.pathname,
        userAgent: event.request.headers.get('user-agent'),
        timestamp: new Date().toISOString(),
    });

    // Return generic error message to client (don't leak server details)
    return new Error('Internal server error');
};
