// Backward compatibility layer for storage utilities
// This file now delegates to the new service layer while maintaining the same API

import type { AppState } from '../types';
import { storageService } from '../core/storage/StorageService';

export class SecureStorage {
    async setPassword(password: string): Promise<void> {
        await storageService.setPassword(password);
    }

    async saveAppState(state: AppState): Promise<void> {
        await storageService.saveAppState(state);
    }

    async loadAppState(): Promise<AppState> {
        return await storageService.loadAppState();
    }

    saveUsedUUID(uuid: string): void {
        storageService.saveUsedUUID(uuid);
    }

    isUUIDUsed(uuid: string): boolean {
        return storageService.isUUIDUsed(uuid);
    }

    clearAllData(): void {
        storageService.clearAllData();
    }
}

export const storage = new SecureStorage();
