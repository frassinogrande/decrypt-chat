<script lang="ts">
    import { translations as LL } from '$lib/i18n/runtime';
    import Icon from '$lib/components/icons/Icon.svelte';

    export let panelId: string;
    export let labelledBy: string;

    const appVersion = __APP_VERSION__;
</script>

<div
    class="tab-content"
    data-tab="about"
    role="tabpanel"
    id={panelId}
    aria-labelledby={labelledBy}
    tabindex="0"
>
    <h3 class="tab-heading">
        <Icon name="info" size={22} className="tab-heading-icon" />
        <span>{$LL.settingsMenuNavAbout()}</span>
    </h3>

    <div class="settings-dialog__section">
        <h4 class="settings-dialog__heading">
            v{appVersion}
        </h4>
        <p>{$LL.settingsMenuAboutIntro()}</p>
        <p>
            {$LL.settingsMenuAboutSelfHost()}<a
                href="https://github.com/frassinogrande/decrypt-chat#running-your-own-instance"
                target="_blank"
                rel="noopener noreferrer">{$LL.settingsMenuAboutSelfHostLink()}</a
            >.
        </p>
        <hr class="about-divider" />
        <ul>
            <li>
                <a
                    href="https://github.com/frassinogrande/decrypt-chat"
                    target="_blank"
                    rel="noopener noreferrer">{$LL.settingsMenuAboutLinkGithub()}</a
                >
            </li>
            <li>
                <a
                    href="https://github.com/frassinogrande/decrypt-chat/releases"
                    target="_blank"
                    rel="noopener noreferrer">{$LL.settingsMenuAboutAllVersions()}</a
                >
            </li>
            <li>
                <a
                    href="https://github.com/frassinogrande/decrypt-chat/blob/main/PRIVACY_POLICY.md"
                    target="_blank"
                    rel="noopener noreferrer">{$LL.settingsMenuAboutLinkPrivacy()}</a
                >
            </li>
            <li>
                <a
                    href="https://github.com/frassinogrande/decrypt-chat/blob/main/LICENSE"
                    target="_blank"
                    rel="noopener noreferrer">{$LL.settingsMenuAboutLinkLicense()}</a
                >
            </li>
        </ul>
    </div>

</div>

<style lang="scss">
    .about-divider {
        border: 0;
        border-top: 1px solid var(--color-border);
        margin: 0;
    }
</style>
