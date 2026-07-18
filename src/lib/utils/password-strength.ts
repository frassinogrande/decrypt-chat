// Passwords below this score trigger a confirm-anyway prompt. Nothing is ever
// rejected on strength or length alone: the user decides.
export const WEAK_PASSWORD_SCORE = 60;

export function isWeakPassword(password: string): boolean {
    return evaluatePasswordStrength(password).score < WEAK_PASSWORD_SCORE;
}

export interface PasswordStrength {
    score: number; // 0-100
    level: 'Very Weak' | 'Weak' | 'Fair' | 'Good' | 'Strong' | 'Very Strong';
    recommendations: string[];
    checks: {
        length: boolean;
        lowercase: boolean;
        uppercase: boolean;
        numbers: boolean;
        symbols: boolean;
    };
}

export function evaluatePasswordStrength(password: string): PasswordStrength {
    if (!password) {
        return {
            score: 0,
            level: 'Very Weak',
            recommendations: ['Start typing to see password strength'],
            checks: {
                length: false,
                lowercase: false,
                uppercase: false,
                numbers: false,
                symbols: false,
            },
        };
    }

    const checks = {
        length: password.length >= 12,
        lowercase: /[a-z]/.test(password),
        uppercase: /[A-Z]/.test(password),
        numbers: /\d/.test(password),
        symbols: /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(password),
    };

    let score = 0;
    const recommendations: string[] = [];

    // Length scoring (0-40 points)
    if (password.length >= 12) {
        score += 40;
    } else if (password.length >= 8) {
        score += 25;
        recommendations.push('Use at least 12 characters for better security');
    } else {
        score += Math.max(0, password.length * 3);
        recommendations.push('Use at least 8 characters');
    }

    // Character variety (0-60 points)
    const varietyScore = [
        checks.lowercase,
        checks.uppercase,
        checks.numbers,
        checks.symbols,
    ].filter(Boolean).length;
    score += varietyScore * 15;

    if (!checks.lowercase) recommendations.push('Add lowercase letters');
    if (!checks.uppercase) recommendations.push('Add uppercase letters');
    if (!checks.numbers) recommendations.push('Add numbers');
    if (!checks.symbols) recommendations.push('Add symbols (!@#$%^&* etc.)');

    let level: PasswordStrength['level'];
    if (score >= 90) level = 'Very Strong';
    else if (score >= 75) level = 'Strong';
    else if (score >= 60) level = 'Good';
    else if (score >= 40) level = 'Fair';
    else if (score >= 20) level = 'Weak';
    else level = 'Very Weak';

    if (score >= 75 && recommendations.length === 0) {
        recommendations.push('Excellent! Your password is very secure.');
    }

    return {
        score,
        level,
        recommendations,
        checks,
    };
}

export function getStrengthColor(level: PasswordStrength['level']): string {
    switch (level) {
        case 'Very Weak':
            return '#dc2626'; // red-600
        case 'Weak':
            return '#ea580c'; // orange-600
        case 'Fair':
            return '#d97706'; // amber-600
        case 'Good':
            return '#65a30d'; // lime-600
        case 'Strong':
            return '#16a34a'; // green-600
        case 'Very Strong':
            return '#059669'; // emerald-600
    }
}
