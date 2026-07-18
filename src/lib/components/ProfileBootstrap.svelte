<script lang="ts">
    import { get } from 'svelte/store';
    import { createEventDispatcher } from 'svelte';
    import Icon from '$lib/components/icons/Icon.svelte';
    import { locale, translations as LL } from '$lib/i18n/runtime';

    const dispatch = createEventDispatcher();
    const heroImage = '/landing-image.jpg';

    // Realistic-looking (but fake) examples shown in the "How it works" steps.
    const exampleShareCode = '#secure=Ah2Kp9rLmX4...Qz7w';
    const exampleKeyPhrase =
        'ribbon velvet mango anchor pledge squeeze orbit cradle timber harvest clarify nephew';

    let featureHighlights: Array<{ icon: string; title: string; description: string }> = [];
    let workflowSteps: Array<{
        title: string;
        description: string;
        code?: string;
        message?: string;
    }> = [];
    let trustPillars: Array<{ icon: string; title: string; description: string }> = [];

    $: {
        // ensure reactivity on locale switch
        const _locale = $locale;
        featureHighlights = [
            {
                icon: 'mobile-chat',
                title: get(LL).profileBootstrapFeature1Title(),
                description: get(LL).profileBootstrapFeature1Description(),
            },
            {
                icon: 'account-circle-off',
                title: get(LL).profileBootstrapFeature2Title(),
                description: get(LL).profileBootstrapFeature2Description(),
            },
            {
                icon: 'call',
                title: get(LL).profileBootstrapFeature3Title(),
                description: get(LL).profileBootstrapFeature3Description(),
            },
        ];

        workflowSteps = [
            {
                title: get(LL).profileBootstrapWorkflowStep1Title(),
                description: get(LL).profileBootstrapWorkflowStep1Description(),
                code: exampleKeyPhrase,
            },
            {
                title: get(LL).profileBootstrapWorkflowStep2Title(),
                description: get(LL).profileBootstrapWorkflowStep2Description(),
                code: exampleShareCode,
            },
            {
                title: get(LL).profileBootstrapWorkflowStep3Title(),
                description: get(LL).profileBootstrapWorkflowStep3Description(),
                message: get(LL).profileBootstrapWorkflowExampleMessage(),
            },
        ];

        trustPillars = [
            {
                icon: 'code',
                title: get(LL).profileBootstrapPillar1Title(),
                description: get(LL).profileBootstrapPillar1Description(),
            },
            {
                icon: 'key',
                title: get(LL).profileBootstrapPillar2Title(),
                description: get(LL).profileBootstrapPillar2Description(),
            },
            {
                icon: 'save',
                title: get(LL).profileBootstrapPillar3Title(),
                description: get(LL).profileBootstrapPillar3Description(),
            },
        ];
    }

    function startCreate() {
        dispatch('create-new');
    }

    function startRestore() {
        dispatch('restore');
    }
</script>

<!-- The layout already provides the <main> landmark; a nested main is invalid. -->
<div class="landing-page">
    <section class="band hero brand-backdrop">
        <div class="band-inner hero-inner">
            <div class="hero-content">
                <h1>{$LL.profileBootstrapHeroTitle()}</h1>
                <p class="tagline">{$LL.profileBootstrapHeroTagline()}</p>

                <div class="hero-actions">
                    <button type="button" class="btn btn--white" on:click={startCreate}>
                        {$LL.profileBootstrapCreateCta()}
                    </button>
                    <button type="button" class="btn btn--white-outline" on:click={startRestore}>
                        {$LL.profileBootstrapRestoreCta()}
                    </button>
                </div>
            </div>
        </div>

        <div class="hero-image">
            <img
                src={heroImage}
                alt="The app on a desktop screen: a list of chats on the left, and an open conversation on the right where each message is labelled as sent offline or online, alongside a voice call record."
                loading="lazy"
            />
        </div>
    </section>

    <section class="band features" id="features">
        <div class="band-inner">
            <div class="section-header">
                <h2>{$LL.profileBootstrapFeaturesTitle()}</h2>
                <p>{$LL.profileBootstrapFeaturesSubtitle()}</p>
            </div>
            <div class="feature-grid">
                {#each featureHighlights as feature}
                    <article class="feature-card">
                        <span class="feature-icon" aria-hidden="true">
                            <Icon name={feature.icon} size={26} />
                        </span>
                        <h3>{feature.title}</h3>
                        <p>{feature.description}</p>
                    </article>
                {/each}
            </div>
        </div>
    </section>

    <section class="band assurance brand-backdrop">
        <div class="band-inner">
            <div class="section-header">
                <h2>{$LL.profileBootstrapAssuranceTitle()}</h2>
                <p>{$LL.profileBootstrapAssuranceDescription()}</p>
            </div>
            <div class="assurance-grid">
                {#each trustPillars as pillar}
                    <article>
                        <span class="pillar-icon" aria-hidden="true">
                            <Icon name={pillar.icon} size={26} />
                        </span>
                        <h3>{pillar.title}</h3>
                        <p>{pillar.description}</p>
                    </article>
                {/each}
            </div>
        </div>
    </section>

    <section class="band workflow">
        <div class="band-inner">
            <div class="section-header">
                <h2>{$LL.profileBootstrapWorkflowTitle()}</h2>
                <p>{$LL.profileBootstrapWorkflowSubtitle()}</p>
            </div>

            <ol class="flow-steps">
                {#each workflowSteps as step, i}
                    <li class="flow-step">
                        <span class="flow-step__num" aria-hidden="true">{(i + 1).toString().padStart(2, '0')}</span>
                        <h3 class="flow-step__title">{step.title}</h3>
                        <p class="flow-step__desc">{step.description}</p>
                        {#if step.code}
                            <span class="flow-bubble flow-bubble--code" aria-hidden="true"><code>{step.code}</code></span>
                        {:else if step.message}
                            <span class="flow-bubble">{step.message}</span>
                        {/if}
                    </li>
                {/each}
            </ol>
        </div>
    </section>

    <section class="band cta brand-backdrop">
        <div class="band-inner">
            <h2>{$LL.profileBootstrapCtaTitle()}</h2>
            <p>{$LL.profileBootstrapCtaDescription()}</p>
            <div class="cta-actions">
                <button type="button" class="btn btn--white" on:click={startCreate}>
                    {$LL.profileBootstrapCreateCta()}
                </button>
                <button type="button" class="btn btn--white-outline" on:click={startRestore}>
                    {$LL.profileBootstrapRestoreCta()}
                </button>
            </div>

            <div class="cta-tips">
                <span class="cta-tips__label">{$LL.profileBootstrapTipsTitle()}</span>
                <ul>
                    <li>{$LL.profileBootstrapTipsItem1()}</li>
                    <li>{$LL.profileBootstrapTipsItem3()}</li>
                    <li>{$LL.profileBootstrapTipsItem4()}</li>
                    <li>{$LL.profileBootstrapTipsItem2()}</li>
                </ul>
            </div>
        </div>
    </section>
</div>

<style>
    :global(body) {
        background: var(--color-bg);
    }

    .landing-page {
        display: block;
        color: var(--color-text);
        min-height: 100vh;
        min-height: 100svh;
    }

    .band {
        padding: clamp(4rem, 8vw, 6rem) 1.5rem;
        border-top: 1px solid var(--color-border);
    }

    .band-inner {
        width: 100%;
        max-width: 1100px;
        margin: 0 auto;
    }

    .hero {
        position: relative;
        overflow: visible;
        min-height: 100vh;
        min-height: 100svh;
        display: flex;
        flex-direction: column;
        justify-content: center;
        color: #f8fafc;
        border-top: none;
        /* Bottom padding reserves room for the screenshot that creeps up into the
           hero (~32% of its height) so the centred content never collides with it.
           Scales with width because the image does; 8rem floor on small screens. */
        padding: clamp(3rem, 6vw, 5rem) 1.5rem clamp(8rem, 18vw, 13rem);
    }

    .hero-content {
        max-width: 640px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 1.5rem;
    }

    h1 {
        margin: 0;
        font-size: clamp(2rem, 5.5vw, 3rem);
        line-height: 1.05;
        font-weight: 700;
    }

    .tagline {
        font-size: clamp(1.05rem, 2vw, 1.25rem);
        line-height: 1.6;
        color: rgba(248, 250, 252, 0.85);
        margin: 0;
    }

    .hero-actions,
    .cta-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 1rem;
    }

    .hero-image {
        position: absolute;
        left: 50%;
        top: 100%;
        /* Pull up so the top of the screenshot creeps into the hero's bottom edge. */
        transform: translate(-50%, -32%);
        width: min(1000px, 90vw);
        z-index: 2;
    }

    .hero-image img {
        width: 100%;
        display: block;
        border: 1px solid var(--color-border);
        border-radius: 12px;
    }

    .section-header {
        margin: 0 auto clamp(2.5rem, 4vw, 3.5rem);
        max-width: 720px;
        text-align: center;
    }

    .section-header h2 {
        margin: 0 0 1rem;
        font-size: clamp(2rem, 4vw, 2.5rem);
        color: var(--color-text);
    }

    .section-header p {
        margin: 0;
        font-size: 1.05rem;
        color: var(--color-text-muted);
        line-height: 1.6;
    }

    .features {
        /* White so the screenshot (light chat UI) flows seamlessly into this section. */
        background: var(--color-bg);
        border-top: none;
        /* Clear the part of the screenshot that hangs below the hero. The vw term
           tracks the image height (image width is 90vw until it caps at 1000px). */
        margin-top: clamp(13rem, 31vw, 22rem);
    }

    .feature-grid {
        display: grid;
        gap: 1.5rem;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    }

    .feature-card {
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: 12px;
        padding: 2rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    .feature-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 2.75rem;
        height: 2.75rem;
        border-radius: 12px;
        background: color-mix(in srgb, #006de2 10%, var(--color-bg));
        color: #006de2;
    }

    .feature-card h3 {
        margin: 0;
        font-size: 1.25rem;
        color: var(--color-text);
    }

    .feature-card p {
        margin: 0;
        color: var(--color-text-muted);
        line-height: 1.6;
    }

    .workflow {
        background: var(--color-bg);
    }

    .flow-steps {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        gap: 2rem 1.5rem;
    }

    .flow-step {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.6rem;
        padding-top: 1.25rem;
        border-top: 2px solid color-mix(in srgb, #006de2 30%, var(--color-border));
    }

    .flow-step__num {
        font-size: 0.85rem;
        font-weight: 700;
        letter-spacing: 0.12em;
        color: #006de2;
    }

    .flow-step__title {
        margin: 0;
        font-size: 1.1rem;
        color: var(--color-text);
    }

    .flow-step__desc {
        margin: 0;
        color: var(--color-text-muted);
        font-size: 0.95rem;
        line-height: 1.55;
    }

    .flow-bubble {
        margin-top: 0.25rem;
        max-width: 100%;
        background: #006de2;
        color: #fff;
        padding: 0.7rem 1rem;
        border-radius: 14px;
        font-size: 0.95rem;
        line-height: 1.45;
    }

    .flow-bubble--code code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.9rem;
        color: #fff;
        overflow-wrap: anywhere;
    }

    .assurance {
        background: #0f172a;
        color: #e2e8f0;
        border-top: none;
    }

    .assurance.brand-backdrop::before {
        opacity: 0.03;
        filter: invert(1);
    }

    .assurance .section-header h2 {
        color: #f8fafc;
    }

    .assurance .section-header p {
        color: rgba(226, 232, 240, 0.85);
    }

    .assurance-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 1.5rem;
    }

    .assurance-grid article {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        background: rgb(255 255 255 / 2%);
        backdrop-filter: blur(2px);
        -webkit-backdrop-filter: blur(5px);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        padding: 1.5rem;
    }

    .pillar-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 2.75rem;
        height: 2.75rem;
        border-radius: 12px;
        background: #fff;
        color: #0f172a;
    }

    .assurance-grid h3 {
        margin: 0;
        font-size: 1.25rem;
        color: #f8fafc;
    }

    .assurance-grid p {
        margin: 0;
        color: rgba(226, 232, 240, 0.75);
        line-height: 1.6;
    }

    .cta {
        color: #f8fafc;
        border-top: none;
        text-align: center;
    }

    .cta .band-inner {
        max-width: 720px;
    }

    .cta h2 {
        margin: 0 0 1rem;
        font-size: clamp(2rem, 4vw, 2.5rem);
        color: #f8fafc;
    }

    .cta > .band-inner > p {
        margin: 0 0 2rem;
        color: rgba(248, 250, 252, 0.85);
        line-height: 1.6;
    }

    .cta-tips {
        margin: 2.5rem auto 0;
        text-align: left;
        border-top: 1px solid rgba(248, 250, 252, 0.25);
        padding-top: 1.5rem;
    }

    .cta-tips__label {
        display: block;
        margin-bottom: 0.75rem;
        font-size: 0.8rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: rgba(248, 250, 252, 0.75);
    }

    .cta-tips ul {
        margin: 0;
        padding-left: 1.2rem;
        color: rgba(248, 250, 252, 0.85);
        line-height: 1.7;
    }

    .cta-tips li + li {
        margin-top: 0.6rem;
    }

    @media (max-width: 768px) {
        .hero {
            min-height: auto;
            padding: clamp(3rem, 6vw, 5rem) 1.5rem clamp(6rem, 18vw, 13rem);
        }

        .hero-image {
            width: min(720px, calc(100% - 3rem));
            transform: translate(-50%, -26%);
        }

        .features {
            margin-top: clamp(9rem, 34vw, 15rem);
        }

        .feature-grid,
        .assurance-grid {
            grid-template-columns: 1fr;
        }
    }

    @media (max-width: 480px) {
        .hero-content {
            gap: 1.25rem;
        }

        .hero-actions,
        .cta-actions {
            flex-direction: column;
        }

        .hero-actions :global(.btn),
        .cta-actions :global(.btn) {
            width: 100%;
            justify-content: center;
        }
    }
</style>
