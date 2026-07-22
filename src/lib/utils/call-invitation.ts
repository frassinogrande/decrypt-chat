import { get } from 'svelte/store';
import type { Chat } from '$lib/types';
import { secureKeyManager } from '$lib/utils/secure-key-manager';
import { buildShareCode } from '$lib/utils/share-link';
import { copyToClipboard } from '$lib/utils/web-share';
import { debug } from '$lib/utils/debug';
import { translations as LL } from '$lib/i18n/runtime';

export async function generateCallInvitation(chat: Chat, callType: 'audio' | 'video') {
    try {
        // The copy starts synchronously with a pending promise; Safari drops
        // the click's transient activation at the first await, so encrypting
        // first and copying after would fail there.
        await copyToClipboard(buildInvitationUrl(chat, callType));
        debug.log('Call invitation copied to clipboard');
    } catch (error) {
        debug.error('Failed to generate call invitation:', error);
        alert(get(LL).chatInterfaceErrorInvite());
    }
}

async function buildInvitationUrl(chat: Chat, callType: 'audio' | 'video'): Promise<string> {
    debug.log(`ChatInterface: Generating ${callType} call invitation for`, chat.name);

    const { generateUUID } = await import('$lib/utils/crypto');
    const callId = generateUUID();

    // Create call invitation data. magic and uuid let the receive path apply the same
    // envelope validation and replay protection it applies to messages, so an old
    // invitation lifted from the carrier thread can't be re-pasted.
    const callInvitation = {
        magic: 'trusted-chat',
        callType: callType,
        callId: callId,
        uuid: generateUUID(),
        timestamp: Date.now(),
    };

    // Encrypt with the conversation key — the URL must not leak chat id,
    // names, or call metadata, and must not be forgeable
    if (!secureKeyManager.hasConversationKey(chat.id)) {
        await secureKeyManager.unwrapConversationKey(chat.id);
    }
    const { serializeBinaryPayload } = await import('$lib/utils/secure-key-manager');
    const payload = await secureKeyManager.createSharePayload(
        chat.id,
        new TextEncoder().encode(JSON.stringify(callInvitation))
    );
    const invitationUrl = buildShareCode(`#secure=${serializeBinaryPayload(payload)}`);

    debug.log('ChatInterface: Generated call invitation URL:', invitationUrl);
    return invitationUrl;
}
