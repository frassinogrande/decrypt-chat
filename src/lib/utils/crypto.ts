// Backward compatibility layer for crypto utilities
// This file delegates to CryptoService while maintaining the same API

import { cryptoService } from '../core/crypto/CryptoService';

export {
    generateUUID,
    generateMnemonic,
    validateMnemonic,
    mnemonicToKey,
    encryptMessage,
    decryptMessage,
    deriveKeyFromPassword,
    deriveBitsFromPassword,
} from '../core/crypto/CryptoService';

export const mnemonicToRawBytes = (mnemonic: string) => cryptoService.mnemonicToRawBytes(mnemonic);
