<script lang="ts">
	import { base } from '$app/paths';

	export let name: string;
	export let size: number | string = 24;
	export let className = '';
	export let ariaLabel: string | undefined = undefined;

	$: dimension = typeof size === 'number' ? `${size}` : size;
	$: href = `${base}/assets/icons/sprite.svg#icon-${name}`;
</script>

<svg
	class={`icon ${className}`.trim()}
	width={dimension}
	height={dimension}
	role={ariaLabel ? 'img' : undefined}
	aria-label={ariaLabel}
	aria-hidden={ariaLabel ? undefined : 'true'}
	focusable="false"
>
	<use href={href} />
</svg>

<style>
	svg.icon {
		display: inline-block;
		vertical-align: middle;
	}
</style>
