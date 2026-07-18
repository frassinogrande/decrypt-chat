import type { ContactMethod } from '../types';

export interface ContactAppDef {
    key: string;
    inputType: 'text' | 'email' | 'tel';
}

// Dropdown order: Email, SMS, then the 3 most-popular apps, then Other.
// Swapping which apps appear is a one-line edit here (plus BRAND_LABELS below).
export const CONTACT_APPS: ContactAppDef[] = [
    { key: 'email', inputType: 'email' },
    { key: 'sms', inputType: 'tel' },
    { key: 'whatsapp', inputType: 'text' },
    { key: 'signal', inputType: 'text' },
    { key: 'telegram', inputType: 'text' },
    { key: 'other', inputType: 'text' },
];

// Brand names are proper nouns and are not translated.
export const BRAND_LABELS: Record<string, string> = {
    whatsapp: 'WhatsApp',
    signal: 'Signal',
    telegram: 'Telegram',
};

// Only the two generic app names and the "Other" fallback need translating.
export interface ContactAppMessages {
    contactAppEmail: () => string;
    contactAppSms: () => string;
    contactAppOther: () => string;
}

/**
 * Human-readable name for a contact method's app. Generic methods (email, SMS)
 * are localized; brand names are literal; an 'other' method shows whatever the
 * user typed, falling back to the localized "Other" if they left it blank.
 */
export function resolveAppLabel(method: ContactMethod, LL: ContactAppMessages): string {
    switch (method.app) {
        case 'email':
            return LL.contactAppEmail();
        case 'sms':
            return LL.contactAppSms();
        case 'other':
            return method.label?.trim() || LL.contactAppOther();
        default:
            return BRAND_LABELS[method.app] ?? method.app;
    }
}

/**
 * Input type for a method's value field, so mobile keyboards match (email
 * keyboard for email, phone pad for SMS, plain text otherwise).
 */
export function inputTypeFor(app: string): 'text' | 'email' | 'tel' {
    return CONTACT_APPS.find((a) => a.key === app)?.inputType ?? 'text';
}
