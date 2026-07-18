<script lang="ts">
	import { evaluatePasswordStrength, getStrengthColor, type PasswordStrength } from '../utils/password-strength';
	import Icon from '$lib/components/icons/Icon.svelte';
	import { translations as LL } from '$lib/i18n/runtime';

	export let password: string = '';
	// Force a single column. The viewport-width media query below can't see that
	// a container (e.g. the settings dialog) is narrow on a wide screen.
	export let stacked: boolean = false;

	$: strength = evaluatePasswordStrength(password);
	$: strengthColor = getStrengthColor(strength.level);

	// The strength module returns a stable level id; localization happens here.
	let levelLabels: Record<PasswordStrength['level'], string>;
	$: levelLabels = {
		'Very Weak': $LL.passwordStrengthLevelVeryWeak(),
		'Weak': $LL.passwordStrengthLevelWeak(),
		'Fair': $LL.passwordStrengthLevelFair(),
		'Good': $LL.passwordStrengthLevelGood(),
		'Strong': $LL.passwordStrengthLevelStrong(),
		'Very Strong': $LL.passwordStrengthLevelVeryStrong(),
	};
	$: localizedLevel = levelLabels[strength.level];
</script>

<div class="password-strength-container">
	<!-- The text only changes when the level id changes, so a polite live region
	     announces level transitions without announcing every keystroke. -->
	<div class="strength-header" aria-live="polite">
		<span class="strength-label">{$LL.passwordStrengthLabel()}</span>
		<span
			class="strength-level"
			style="color: {strengthColor}"
		>
			{localizedLevel}
		</span>
	</div>

	<div
		class="strength-bar-container"
		role="progressbar"
		aria-valuenow={strength.score}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-label="{$LL.passwordStrengthLabel()} {localizedLevel}"
	>
		<div class="strength-bar-bg"></div>
		<div
			class="strength-bar"
			style="width: {strength.score}%; background-color: {strengthColor}"
		></div>
	</div>

	<div class="requirements-grid" class:stacked>
		<div class="requirement" class:met={strength.checks.length}>
			<Icon name={strength.checks.length ? 'check' : 'close'} size={14} className="check-icon" />
			<span class="visually-hidden">{strength.checks.length ? $LL.passwordStrengthMet() : $LL.passwordStrengthNotMet()}</span>
			{$LL.passwordStrengthReqLength()}
		</div>
		<div class="requirement" class:met={strength.checks.uppercase}>
			<Icon name={strength.checks.uppercase ? 'check' : 'close'} size={14} className="check-icon" />
			<span class="visually-hidden">{strength.checks.uppercase ? $LL.passwordStrengthMet() : $LL.passwordStrengthNotMet()}</span>
			{$LL.passwordStrengthReqUppercase()}
		</div>
		<div class="requirement" class:met={strength.checks.lowercase}>
			<Icon name={strength.checks.lowercase ? 'check' : 'close'} size={14} className="check-icon" />
			<span class="visually-hidden">{strength.checks.lowercase ? $LL.passwordStrengthMet() : $LL.passwordStrengthNotMet()}</span>
			{$LL.passwordStrengthReqLowercase()}
		</div>
		<div class="requirement" class:met={strength.checks.numbers}>
			<Icon name={strength.checks.numbers ? 'check' : 'close'} size={14} className="check-icon" />
			<span class="visually-hidden">{strength.checks.numbers ? $LL.passwordStrengthMet() : $LL.passwordStrengthNotMet()}</span>
			{$LL.passwordStrengthReqNumbers()}
		</div>
		<div class="requirement" class:met={strength.checks.symbols}>
			<Icon name={strength.checks.symbols ? 'check' : 'close'} size={14} className="check-icon" />
			<span class="visually-hidden">{strength.checks.symbols ? $LL.passwordStrengthMet() : $LL.passwordStrengthNotMet()}</span>
			{$LL.passwordStrengthReqSymbols()}
		</div>
	</div>
</div>

<style>
	.password-strength-container {
		padding: 1rem;
		background: var(--color-bg-subtle);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		font-size: 0.875rem;
	}

	.strength-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.5rem;
	}

	.strength-label {
		color: var(--color-text);
		font-weight: 500;
	}

	.strength-level {
		font-weight: 600;
		font-size: 0.9rem;
	}

	.strength-bar-container {
		position: relative;
		height: 8px;
		margin-bottom: 1rem;
		border-radius: 4px;
		overflow: hidden;
	}

	.strength-bar-bg {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		background-color: var(--color-border);
		border-radius: 4px;
	}

	.strength-bar {
		position: absolute;
		top: 0;
		left: 0;
		height: 100%;
		border-radius: 4px;
		transition: width 0.3s ease, background-color 0.3s ease;
		min-width: 2px;
	}

	.requirements-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
	}

	.requirements-grid.stacked {
		grid-template-columns: 1fr;
	}

	.requirement {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--color-text-muted);
		transition: color 0.2s ease;
	}

	.requirement.met {
		color: var(--color-success-text);
	}

	.requirement :global(.check-icon) {
		flex-shrink: 0;
	}

	@media (max-width: 600px) {
		.requirements-grid {
			grid-template-columns: 1fr;
		}

		.password-strength-container {
			padding: 0.75rem;
			font-size: 0.8rem;
		}
	}
</style>
