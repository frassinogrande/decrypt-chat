/**
 * Secure debug utility with runtime log levels.
 * - In production (secure builds): all methods are no-ops (tree-shaken).
 * - In development: output is gated by a runtime level (default: 'warn').
 *
 * Configure level at runtime via browser devtools:
 *   localStorage.setItem('debug-level', 'debug'); // or 'info', 'warn', 'error', 'trace', 'none'
 *   // then reload the page
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogFunction = (...args: any[]) => void;

type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'log' | 'debug' | 'trace';

interface DebugLogger {
    log: LogFunction;
    warn: LogFunction;
    error: LogFunction;
    info: LogFunction;
    debug: LogFunction;
    trace: LogFunction;
}

function createDebugLogger(): DebugLogger {
    // Production/secure builds: hard no-ops (tree-shaken by terser)
    if (!__DEV__) {
        const noop = () => {};
        return { log: noop, warn: noop, error: noop, info: noop, debug: noop, trace: noop };
    }

    // Development: gate output by level
    const LEVELS: Record<LogLevel, number> = {
        none: 0,
        error: 1,
        warn: 2,
        info: 3,
        log: 3, // treat 'log' same as 'info'
        debug: 4,
        trace: 5,
    };

    const getLevel = (): number => {
        try {
            const isBrowser = typeof window !== 'undefined';
            let levelStr: LogLevel | null = null;

            // Allow env default if provided (must match LogLevel)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const envLevel = (import.meta as any)?.env?.VITE_DEBUG_LEVEL as LogLevel | undefined;

            if (isBrowser) {
                levelStr = (localStorage.getItem('debug-level') ||
                    sessionStorage.getItem('debug-level') ||
                    envLevel ||
                    null) as LogLevel | null;
            } else {
                levelStr = envLevel || null;
            }

            const effective: LogLevel =
                levelStr && LEVELS[levelStr] !== undefined ? levelStr : 'warn';
            return LEVELS[effective];
        } catch {
            return LEVELS.warn;
        }
    };

    const wrap = (method: keyof Console, level: number): LogFunction => {
        return (...args) => {
            if (getLevel() >= level) {
                // eslint-disable-next-line no-console
                (console[method] as LogFunction).apply(console, args);
            }
        };
    };

    return {
        error: wrap('error', LEVELS.error),
        warn: wrap('warn', LEVELS.warn),
        info: wrap('info', LEVELS.info),
        log: wrap('log', LEVELS.log),
        debug: wrap('debug', LEVELS.debug),
        trace: wrap('trace', LEVELS.trace),
    };
}

export const debug = createDebugLogger();

export function debugAssert(condition: boolean, message?: string): void {
    if (__DEV__ && !condition) {
        throw new Error(`Debug assertion failed: ${message || 'Unknown error'}`);
    }
}

export function debugTime<T>(label: string, fn: () => T): T {
    if (__DEV__) {
        console.time(label);
        try {
            return fn();
        } finally {
            console.timeEnd(label);
        }
    }
    return fn();
}

export async function debugTimeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (__DEV__) {
        console.time(label);
        try {
            return await fn();
        } finally {
            console.timeEnd(label);
        }
    }
    return fn();
}
