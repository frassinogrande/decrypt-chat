export type TrustedHTML = string & { __trusted_html: true };

type TrustedTypePolicy = {
    createHTML(value: string): TrustedHTML;
};

interface TrustedTypesFactory {
    createPolicy(
        name: string,
        policy: {
            createHTML(value: string): string;
        }
    ): TrustedTypePolicy;
}

declare global {
    interface Window {
        trustedTypes?: TrustedTypesFactory;
    }
}

let policy: TrustedTypePolicy | null = null;

/**
 * Wrap sanitized HTML strings in a TrustedHTML container when supported.
 * This allows us to opt into Trusted Types without breaking browsers that
 * do not implement the API yet.
 */
export const createTrustedHTML = (html: string): string | TrustedHTML => {
    if (typeof window === 'undefined') {
        return html;
    }

    const factory = window.trustedTypes;
    if (!factory) {
        return html;
    }

    if (!policy) {
        policy = factory.createPolicy('decrypt-chat-sanitized-html', {
            createHTML: (value: string) => value,
        });
    }

    return policy.createHTML(html);
};
