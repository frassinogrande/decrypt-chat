import { debug } from './debug';

interface MemoryInfo {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
}

interface MemoryPressureEvents {
    onMemoryWarning?: () => void;
    onMemoryPressure?: () => void;
    onMemoryCritical?: () => void;
}

export class MemoryPressureService {
    private static instance: MemoryPressureService;
    private events: MemoryPressureEvents = {};
    private monitoringInterval: number | null = null;
    private isMonitoring = false;

    private readonly WARNING_THRESHOLD = 0.7;
    private readonly PRESSURE_THRESHOLD = 0.85;
    private readonly CRITICAL_THRESHOLD = 0.95;

    private readonly MONITOR_INTERVAL_MS = 30 * 1000;
    private readonly MEMORY_HISTORY_SIZE = 10;
    private memoryHistory: number[] = [];

    private constructor() {
        this.setupMemoryPressureAPI();
    }

    static getInstance(): MemoryPressureService {
        if (!MemoryPressureService.instance) {
            MemoryPressureService.instance = new MemoryPressureService();
        }
        return MemoryPressureService.instance;
    }

    public isSupported(): boolean {
        return (
            typeof window !== 'undefined' &&
            'performance' in window &&
            'memory' in window.performance
        );
    }

    public registerEvents(events: MemoryPressureEvents): void {
        this.events = { ...this.events, ...events };
        debug.log('Memory pressure events registered');
    }

    public startMonitoring(): void {
        if (this.isMonitoring || !this.isSupported()) {
            return;
        }

        this.isMonitoring = true;
        this.monitoringInterval = window.setInterval(() => {
            this.checkMemoryUsage();
        }, this.MONITOR_INTERVAL_MS);

        // Initial check
        this.checkMemoryUsage();
        debug.log('Memory pressure monitoring started');
    }

    public stopMonitoring(): void {
        if (!this.isMonitoring) {
            return;
        }

        this.isMonitoring = false;
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        debug.log('Memory pressure monitoring stopped');
    }

    public getMemoryInfo(): MemoryInfo | null {
        if (!this.isSupported()) {
            return null;
        }

        const memory = (window.performance as any).memory;
        return {
            usedJSHeapSize: memory?.usedJSHeapSize,
            totalJSHeapSize: memory?.totalJSHeapSize,
            jsHeapSizeLimit: memory?.jsHeapSizeLimit,
        };
    }

    /**
     * Get memory usage as a percentage (0-1)
     */
    public getMemoryUsageRatio(): number {
        const memInfo = this.getMemoryInfo();
        if (!memInfo || !memInfo.usedJSHeapSize || !memInfo.jsHeapSizeLimit) {
            return 0;
        }

        return memInfo.usedJSHeapSize / memInfo.jsHeapSizeLimit;
    }

    public getMemoryTrend(): 'increasing' | 'decreasing' | 'stable' | 'unknown' {
        if (this.memoryHistory.length < 3) {
            return 'unknown';
        }

        const recent = this.memoryHistory.slice(-3);
        const increasing = recent.every((val, i) => i === 0 || val > recent[i - 1]);
        const decreasing = recent.every((val, i) => i === 0 || val < recent[i - 1]);

        if (increasing) return 'increasing';
        if (decreasing) return 'decreasing';
        return 'stable';
    }

    /**
     * Force garbage collection if available (Chrome DevTools only)
     */
    public forceGarbageCollection(): boolean {
        try {
            if (typeof window !== 'undefined' && (window as any).gc) {
                (window as any).gc();
                debug.log('Forced garbage collection');
                return true;
            }
        } catch (error) {
            debug.warn('Failed to force garbage collection:', error);
        }
        return false;
    }

    public getMemoryStats(): {
        current: MemoryInfo | null;
        usageRatio: number;
        trend: string;
        history: number[];
        isMonitoring: boolean;
    } {
        return {
            current: this.getMemoryInfo(),
            usageRatio: this.getMemoryUsageRatio(),
            trend: this.getMemoryTrend(),
            history: [...this.memoryHistory],
            isMonitoring: this.isMonitoring,
        };
    }

    private checkMemoryUsage(): void {
        const usageRatio = this.getMemoryUsageRatio();

        // Skip if we can't get memory info
        if (usageRatio === 0) return;

        this.memoryHistory.push(usageRatio);
        if (this.memoryHistory.length > this.MEMORY_HISTORY_SIZE) {
            this.memoryHistory.shift();
        }

        if (usageRatio >= this.CRITICAL_THRESHOLD) {
            debug.warn(`Critical memory usage detected: ${(usageRatio * 100).toFixed(1)}%`);
            this.events.onMemoryCritical?.();
        } else if (usageRatio >= this.PRESSURE_THRESHOLD) {
            debug.warn(`High memory pressure detected: ${(usageRatio * 100).toFixed(1)}%`);
            this.events.onMemoryPressure?.();
        } else if (usageRatio >= this.WARNING_THRESHOLD) {
            debug.log(`Memory usage warning: ${(usageRatio * 100).toFixed(1)}%`);
            this.events.onMemoryWarning?.();
        }

        if (usageRatio >= this.WARNING_THRESHOLD) {
            const trend = this.getMemoryTrend();
            const memInfo = this.getMemoryInfo();
            debug.log(
                `Memory trend: ${trend}, Used: ${this.formatBytes(memInfo?.usedJSHeapSize || 0)}, Limit: ${this.formatBytes(memInfo?.jsHeapSizeLimit || 0)}`
            );
        }
    }

    private setupMemoryPressureAPI(): void {
        if (typeof window !== 'undefined' && 'navigator' in window) {
            if ((navigator as any).memory) {
                debug.log('Browser memory API detected');
            }

            document?.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    debug.log('Page hidden - suggesting memory cleanup');
                    setTimeout(() => {
                        this.forceGarbageCollection();
                    }, 1000);
                }
            });
        }
    }

    private formatBytes(bytes: number): string {
        const sizes = ['B', 'KB', 'MB', 'GB'];
        if (bytes === 0) return '0 B';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + ' ' + sizes[i];
    }

    public createDefensiveActions(callbacks: {
        clearCaches?: () => void;
        lockSession?: () => void;
        reduceFunctionality?: () => void;
    }): MemoryPressureEvents {
        return {
            onMemoryWarning: () => {
                debug.log('Memory warning - performing light cleanup');
                callbacks.clearCaches?.();
                this.forceGarbageCollection();
            },
            onMemoryPressure: () => {
                debug.warn('Memory pressure - performing aggressive cleanup');
                callbacks.clearCaches?.();
                callbacks.reduceFunctionality?.();
                this.forceGarbageCollection();
            },
            onMemoryCritical: () => {
                debug.error('Critical memory usage - locking session for security');
                callbacks.clearCaches?.();
                callbacks.lockSession?.();
                this.forceGarbageCollection();
            },
        };
    }
}

export const memoryPressureService = MemoryPressureService.getInstance();
