import { debug } from './debug';

export interface StorageQuota {
    used: number;
    quota: number;
    usagePercentage: number;
    isNearLimit: boolean;
    isAtLimit: boolean;
}

export class StorageMonitor {
    private listeners: Set<(quota: StorageQuota) => void> = new Set();
    private lastQuota: StorageQuota | null = null;
    private monitoringInterval: number | null = null;

    constructor() {
        // Start monitoring when first listener is added
    }

    addListener(callback: (quota: StorageQuota) => void): () => void {
        this.listeners.add(callback);

        if (this.listeners.size === 1) {
            this.startMonitoring();
        }

        return () => {
            this.listeners.delete(callback);

            if (this.listeners.size === 0) {
                this.stopMonitoring();
            }
        };
    }

    async getStorageQuota(): Promise<StorageQuota> {
        const estimate = await navigator.storage.estimate();
        const used = estimate.usage ?? 0;
        const quota = estimate.quota ?? 0;
        const usagePercentage = quota > 0 ? (used / quota) * 100 : 0;
        const isNearLimit = usagePercentage > 80;
        const isAtLimit = usagePercentage > 95;

        return { used, quota, usagePercentage, isNearLimit, isAtLimit };
    }

    /**
     * Whether the browser has marked this origin's storage as persistent
     * (exempt from automatic eviction under storage pressure).
     */
    async isPersisted(): Promise<boolean> {
        if (
            typeof navigator === 'undefined' ||
            !('storage' in navigator) ||
            !('persisted' in navigator.storage)
        ) {
            return false;
        }
        try {
            return await navigator.storage.persisted();
        } catch (error) {
            debug.error('storage.persisted() failed:', error);
            return false;
        }
    }

    /**
     * Ask the browser to mark this origin's storage as persistent so it is not
     * silently evicted. Safe to call repeatedly; resolves to the current state.
     * Chromium/Safari may grant silently; Firefox requires a user gesture.
     */
    async requestPersistence(): Promise<boolean> {
        if (
            typeof navigator === 'undefined' ||
            !('storage' in navigator) ||
            !('persist' in navigator.storage)
        ) {
            return false;
        }
        try {
            if (await this.isPersisted()) {
                return true;
            }
            const granted = await navigator.storage.persist();
            debug.log('storage.persist() granted:', granted);
            return granted;
        } catch (error) {
            debug.error('storage.persist() failed:', error);
            return false;
        }
    }

    async getStorageUsageString(): Promise<string> {
        const quota = await this.getStorageQuota();
        const usedMB = Math.round((quota.used / (1024 * 1024)) * 10) / 10;
        const quotaMB = Math.round((quota.quota / (1024 * 1024)) * 10) / 10;

        return `${usedMB} MB / ${quotaMB} MB (${Math.round(quota.usagePercentage)}%)`;
    }

    private startMonitoring(): void {
        this.monitoringInterval = window.setInterval(() => {
            this.checkAndNotify();
        }, 30000);

        this.checkAndNotify();
    }

    private stopMonitoring(): void {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
    }

    private async checkAndNotify(): Promise<void> {
        try {
            const quota = await this.getStorageQuota();

            // Only notify if quota has changed significantly
            if (
                !this.lastQuota ||
                Math.abs(quota.usagePercentage - this.lastQuota.usagePercentage) > 1 ||
                quota.isNearLimit !== this.lastQuota.isNearLimit ||
                quota.isAtLimit !== this.lastQuota.isAtLimit
            ) {
                this.lastQuota = quota;
                this.notifyListeners();
            }
        } catch (error) {
            debug.error('Storage monitoring error:', error);
        }
    }

    private notifyListeners(): void {
        if (this.lastQuota) {
            this.listeners.forEach((callback) => {
                try {
                    callback(this.lastQuota!);
                } catch (error) {
                    debug.error('Storage listener error:', error);
                }
            });
        }
    }
}

export const storageMonitor = new StorageMonitor();
