export interface Message {
    magic: string;
    from: string;
    timestamp: number;
    body: string;
    uuid: string;
    pad: string;
}

export interface StoredMessage {
    id: string;
    from: string;
    body?: string; // Optional for encrypted messages
    encryptedBody?: ArrayBuffer;
    iv?: ArrayBuffer; // Initialization vector for encryption
    timestamp: number;
    isOwn: boolean;
    // Delivery method label used in UI. Keep common literals but allow custom strings
    // like "imported via WhatsApp" for imported messages.
    deliveryMethod?: 'online' | 'offline' | 'via Whatsapp' | string;
    // The sender-provided UUID inside the encrypted payload; used to correlate replies/reactions
    remoteUuid?: string;
    // Optional emoji reaction applied by the other participant to this message.
    // Deliberately limited to three; see "Planned / Not Yet Implemented" in README.md.
    reaction?: 'laugh' | 'heart' | '100';
    // Optional name of who reacted
    reactionBy?: string;
    chatId?: string; // For storage operations
    autoDeleteAfter?: number | null; // ms; stamped at message creation from the chat's active setting
    storedWithDWK?: boolean; // true = body encrypted with device wrap key; false/absent = conversation key (legacy)
    // When set, this record is a call event (completed/declined/missed/cancelled) rendered as a
    // system line rather than a chat bubble. The body is unused for these records.
    callEvent?: CallEventInfo;
}

export type CallEventOutcome = 'missed' | 'declined' | 'cancelled' | 'completed';

export interface CallEventInfo {
    direction: 'incoming' | 'outgoing'; // relative to the local user; incoming = the peer called us
    outcome: CallEventOutcome;
    callType: 'audio' | 'video';
    // Seconds spent connected; only set on 'completed'. Each side measures its own connection,
    // so the two participants' records can differ by the signalling round-trip.
    duration?: number;
}

export interface ContactMethod {
    app: string; // key from CONTACT_APPS; 'other' means user-named
    label?: string; // only when app === 'other': the name the user typed, shown verbatim
    value: string; // number / username / address / link
}

export interface SharedProfile {
    name?: string;
    contacts?: ContactMethod[];
    createdAt: number;
}

export interface Chat {
    id: string;
    name: string;
    key?: string; // BIP39 mnemonic phrase
    messages: StoredMessage[];
    lastActivity: number;
    isOnlineMode?: boolean;
    sharedProfile?: SharedProfile;
    autoDeleteAfter?: number | null; // ms; the currently active setting for new messages
}

export interface UserProfile {
    id: string;
    name?: string;
    contacts?: ContactMethod[];
    createdAt: number;
}

export interface ProfileSettings {
    autoLockTimeout: number; // minutes, -2 = on refresh, -1 = after new session, -3 = manual only (less secure: unlock material persists in localStorage), >0 = inactivity timeout
    hideMessagesOnHomepage: boolean; // when true, show "Tap to view messages" instead of message preview
    showInstantLockButton: boolean; // when true, show a quick lock button in the chat list header
    enterKeySendsMessage: boolean; // when true, Enter sends; when false, Enter inserts newline
    use24HourTime: boolean; // when true, display timestamps in 24-hour format
    themePreference: 'light' | 'dark' | 'system'; // color scheme preference
}

export interface ProfileLockState {
    isLocked: boolean;
    isInitializing?: boolean;
    unlockTimestamp?: number;
    autoLockTimer?: number;
}

// Updated AppState - only light data, heavy chat data moved to IndexedDB
export interface AppState {
    currentChatId: string | null;
    isFirstTime: boolean;

    usedUUIDs: Set<string>;

    peerConnections: Map<string, PeerConnection>;

    profile?: UserProfile;
    profileSettings: ProfileSettings;
    profileLockState: ProfileLockState;
}

export interface CryptoKey {
    key: CryptoKey;
    mnemonic: string;
}

export interface EncryptedBlob {
    data: string;
    iv: string;
}

export interface PeerConnection {
    chatId: string;
    state: 'disconnected' | 'connecting' | 'connected' | 'failed';
    lastSeen: number | null;
}

export interface MediaDevice {
    deviceId: string;
    label: string;
    kind: 'audioinput' | 'audiooutput' | 'videoinput';
}

export interface CallParticipant {
    id: string;
    name: string;
    stream?: MediaStream;
    isAudioMuted?: boolean;
    isVideoMuted?: boolean;
}

export interface Call {
    id: string;
    chatId: string;
    type: 'audio' | 'video';
    state: 'idle' | 'outgoing' | 'incoming' | 'connected' | 'ended' | 'failed';
    participants: CallParticipant[];
    startTime?: number; // when the call started ringing, not when it connected
    connectedAt?: number; // when the peer answered; the origin for any duration shown to the user
    endTime?: number;
    duration?: number;
    isInitiator: boolean;
}

export interface CallSettings {
    defaultAudioInput?: string;
    defaultAudioOutput?: string;
    defaultVideoInput?: string;
    autoAnswer: boolean;
    videoEnabled: boolean;
}

export interface MediaConstraints {
    audio: boolean | MediaTrackConstraints;
    video: boolean | MediaTrackConstraints;
}

export interface CallSignalData {
    type: 'call-offer' | 'call-answer' | 'call-ice-candidate' | 'call-hangup' | 'call-media-toggle';
    callId: string;
    data: any;
    timestamp: number;
}
