const LAST_ACTIVITY_KEY = 'profile-last-activity';

import { debug } from './debug';

class ActivityTracker {
    private isInitialized = false;
    private autoLockTimer: number | null = null;
    private currentTimeoutMinutes: number | null = null;
    private onLockCallback: (() => void) | null = null;

    public initialize(): void {
        if (this.isInitialized || typeof window === 'undefined') {
            return;
        }

        const events = [
            'mousedown',
            'mousemove',
            'mouseup',
            'click',
            'keydown',
            'keypress',
            'keyup',
            'scroll',
            'wheel',
            'touchstart',
            'touchmove',
            'touchend',
            'focus',
            'blur',
        ];

        events.forEach((event) => {
            document.addEventListener(event, this.handleUserActivity, true);
        });

        document.addEventListener('visibilitychange', this.handleVisibilityChange);

        // Do NOT update activity timestamp on initialization - preserve existing timestamp

        this.isInitialized = true;
        debug.log('Activity tracker initialized');
    }

    public destroy(): void {
        if (!this.isInitialized) return;

        const events = [
            'mousedown',
            'mousemove',
            'mouseup',
            'click',
            'keydown',
            'keypress',
            'keyup',
            'scroll',
            'wheel',
            'touchstart',
            'touchmove',
            'touchend',
            'focus',
            'blur',
        ];

        events.forEach((event) => {
            document.removeEventListener(event, this.handleUserActivity, true);
        });

        document.removeEventListener('visibilitychange', this.handleVisibilityChange);

        this.clearAutoLockTimer();
        this.isInitialized = false;
    }

    public setAutoLock(timeoutMinutes: number, onLock: () => void): void {
        this.currentTimeoutMinutes = timeoutMinutes;
        this.onLockCallback = onLock;

        this.clearAutoLockTimer();

        if (timeoutMinutes > 0) {
            this.startAutoLockTimer();
        }
    }

    public clearAutoLock(): void {
        this.clearAutoLockTimer();
        this.currentTimeoutMinutes = null;
        this.onLockCallback = null;
    }

    public isTimeoutExceeded(timeoutMinutes: number): boolean {
        const lastActivity = this.getLastActivity();
        if (!lastActivity) {
            return false; // No last activity recorded, don't lock
        }

        const now = Date.now();
        const timeoutMs = timeoutMinutes * 60 * 1000;
        const timeSinceLastActivity = now - lastActivity;

        return timeSinceLastActivity > timeoutMs;
    }

    public getLastActivity(): number | null {
        if (typeof window === 'undefined') return null;

        const stored = localStorage.getItem(LAST_ACTIVITY_KEY);
        return stored ? parseInt(stored, 10) : null;
    }

    /**
     * Get time remaining until auto-lock (in milliseconds)
     */
    public getTimeRemaining(timeoutMinutes: number): number {
        const lastActivity = this.getLastActivity();
        if (!lastActivity) return timeoutMinutes * 60 * 1000;

        const now = Date.now();
        const timeoutMs = timeoutMinutes * 60 * 1000;
        const elapsed = now - lastActivity;

        return Math.max(0, timeoutMs - elapsed);
    }

    public updateActivity(): void {
        if (typeof window === 'undefined') return;

        localStorage.setItem(LAST_ACTIVITY_KEY, Date.now().toString());

        if (this.currentTimeoutMinutes && this.currentTimeoutMinutes > 0) {
            this.clearAutoLockTimer();
            this.startAutoLockTimer();
        }
    }

    private handleUserActivity = (event: Event): void => {
        // Ignore some events that shouldn't reset the timer
        if (
            event.type === 'blur' ||
            (event.type === 'mousemove' && this.isMouseMoveMinimal(event as MouseEvent))
        ) {
            return;
        }

        this.updateActivity();
    };

    private handleVisibilityChange = (): void => {
        if (!document.hidden) {
            if (
                this.currentTimeoutMinutes &&
                this.currentTimeoutMinutes > 0 &&
                this.isTimeoutExceeded(this.currentTimeoutMinutes)
            ) {
                if (this.onLockCallback) {
                    this.onLockCallback();
                }
            } else {
                this.updateActivity();
            }
        }
    };

    private isMouseMoveMinimal(event: MouseEvent): boolean {
        // Only reset timer for significant mouse movements
        // This prevents tiny movements from constantly resetting the timer
        const threshold = 10; // pixels

        if (!this.lastMousePosition) {
            this.lastMousePosition = { x: event.clientX, y: event.clientY };
            return false;
        }

        const distance = Math.sqrt(
            Math.pow(event.clientX - this.lastMousePosition.x, 2) +
                Math.pow(event.clientY - this.lastMousePosition.y, 2)
        );

        this.lastMousePosition = { x: event.clientX, y: event.clientY };

        return distance < threshold;
    }

    private lastMousePosition: { x: number; y: number } | null = null;

    private startAutoLockTimer(): void {
        if (
            !this.currentTimeoutMinutes ||
            this.currentTimeoutMinutes <= 0 ||
            !this.onLockCallback
        ) {
            return;
        }

        const timeRemaining = this.getTimeRemaining(this.currentTimeoutMinutes);

        this.autoLockTimer = window.setTimeout(() => {
            if (this.onLockCallback) {
                this.onLockCallback();
            }
        }, timeRemaining);
    }

    private clearAutoLockTimer(): void {
        if (this.autoLockTimer) {
            clearTimeout(this.autoLockTimer);
            this.autoLockTimer = null;
        }
    }
}

export const activityTracker = new ActivityTracker();
