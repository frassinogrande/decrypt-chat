/**
 * JavaScript fallback for CSS Anchor Positioning, used by the popover elements:
 * the message menu, reaction picker, expiry tooltip and chat-options menu.
 */

export type AnchorPlacement =
    | 'top-start'
    | 'top-end'
    | 'bottom-start'
    | 'bottom-end'
    | 'right-start'
    | 'left-start';

export interface AnchorFallbackParams {
    /** The element the popover is anchored to (the `popovertarget` button). */
    trigger: HTMLElement | null | undefined;
    /** Preferred placement, mirroring the CSS `anchor()` default. */
    placement: AnchorPlacement;
    /** Gap between the trigger and the popover, in px. */
    gap?: number;
    /** Minimum distance to keep from the viewport edge, in px. */
    margin?: number;
}

let cachedSupport: boolean | null = null;

function supportsAnchorPositioning(): boolean {
    if (cachedSupport === null) {
        cachedSupport =
            typeof CSS !== 'undefined' &&
            typeof CSS.supports === 'function' &&
            CSS.supports('anchor-name: --probe');
    }
    return cachedSupport;
}

export function anchorFallback(node: HTMLElement, params: AnchorFallbackParams) {
    // Native CSS anchor positioning handles everything; stay out of the way.
    if (supportsAnchorPositioning()) {
        return {};
    }

    let current = params;
    let open = false;

    function place() {
        const trigger = current.trigger;
        if (!trigger || !open) return;

        const gap = current.gap ?? 4;
        const edge = current.margin ?? 8;
        const rect = trigger.getBoundingClientRect();
        const width = node.offsetWidth;
        const height = node.offsetHeight;
        const vw = document.documentElement.clientWidth;
        const vh = document.documentElement.clientHeight;

        const [side, align] = current.placement.split('-');

        let top = 0;
        let left = 0;

        if (side === 'top' || side === 'bottom') {
            const above = rect.top - gap - height;
            const below = rect.bottom + gap;
            let useTop = side === 'top';
            // Flip vertically if the preferred side would clip and the other fits.
            if (useTop && above < edge && below + height <= vh - edge) useTop = false;
            else if (!useTop && below + height > vh - edge && above >= edge) useTop = true;
            top = useTop ? rect.top - gap - height : rect.bottom + gap;
            // `end` aligns the right edges, `start` aligns the left edges.
            left = align === 'end' ? rect.right - width : rect.left;
        } else {
            const toRight = rect.right + gap;
            const toLeft = rect.left - gap - width;
            let useRight = side === 'right';
            // Flip horizontally if the preferred side would clip and the other fits.
            if (useRight && toRight + width > vw - edge && toLeft >= edge) useRight = false;
            else if (!useRight && toLeft < edge && toRight + width <= vw - edge) useRight = true;
            left = useRight ? rect.right + gap : rect.left - gap - width;
            // `start` aligns the top edges.
            top = rect.top;
        }

        // Keep the whole popover inside the viewport.
        left = Math.min(Math.max(left, edge), Math.max(edge, vw - width - edge));
        top = Math.min(Math.max(top, edge), Math.max(edge, vh - height - edge));

        node.style.position = 'fixed';
        node.style.margin = '0';
        node.style.left = `${left}px`;
        node.style.top = `${top}px`;
        node.style.right = 'auto';
        node.style.bottom = 'auto';
    }

    function clearInlinePosition() {
        node.style.left = '';
        node.style.top = '';
        node.style.right = '';
        node.style.bottom = '';
    }

    function onToggle(event: Event) {
        open = (event as ToggleEvent).newState === 'open';
        if (open) {
            // Position before the first paint of the open state to avoid a flash
            // at the wrong spot. Reading offsetWidth in place() forces the layout
            // the browser needs to report real dimensions.
            place();
        } else {
            clearInlinePosition();
        }
    }

    function onReflow() {
        if (open) place();
    }

    node.addEventListener('toggle', onToggle);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);

    return {
        update(next: AnchorFallbackParams) {
            current = next;
            if (open) place();
        },
        destroy() {
            node.removeEventListener('toggle', onToggle);
            window.removeEventListener('resize', onReflow);
            window.removeEventListener('scroll', onReflow, true);
        },
    };
}
