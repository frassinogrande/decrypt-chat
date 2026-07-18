declare global {
    namespace App {
        interface Locals {
            locale: import('./lib/i18n/config').Locale;
        }
        interface PageData {
            locale: import('./lib/i18n/config').Locale;
        }
    }

    interface Window {
        secureKeyManager?: import('./lib/utils/secure-key-manager').SecureKeyManager;
        secureChatStorage?: import('./lib/utils/secure-chat-storage').SecureChatStorage;
    }

    // Build-time constants
    const __SECURE_BUILD__: boolean;
    const __DEV__: boolean;
    const __APP_VERSION__: string;
}

export {};
