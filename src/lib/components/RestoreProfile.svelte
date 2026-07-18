<script lang="ts">
	import { get } from 'svelte/store';
  import { createEventDispatcher, tick } from 'svelte';
  import { restoreFromEncryptedBackup } from '../utils/backup';
  import { profileManager } from '../utils/profile-manager';
  import { translations as LL } from '$lib/i18n/runtime';
  import Icon from '$lib/components/icons/Icon.svelte';

  const dispatch = createEventDispatcher();

  export let isRequired: boolean = true;

  let file: File | null = null;
  let password = '';
  let showPassword = false;
  let isRestoring = false;
  let error = '';
  let dragActive = false;
  let fileInput: HTMLInputElement;
  let clearFileButton: HTMLButtonElement;
  let fileAnnouncement = '';

  $: passwordToggleLabel = showPassword ? $LL.profileSetupToggleHide() : $LL.profileSetupToggleShow();

  async function selectFile(selected: File) {
    file = selected;
    fileAnnouncement = get(LL).restoreProfileFileSelected({ name: selected.name });
    // The dropzone (and its focus) is destroyed by the branch swap; move focus
    // to the clear-file button so keyboard users are not dropped at the top.
    await tick();
    clearFileButton?.focus();
  }

  function handleFileChange(e: Event) {
    const t = e.target as HTMLInputElement;
    const selected = t && t.files && t.files[0] ? t.files[0] : null;
    if (selected) {
      selectFile(selected);
    } else {
      file = null;
    }
  }

  function openFileDialog() {
    if (isRestoring) return;
    fileInput?.click();
  }

  function clearSelectedFile() {
    if (isRestoring) return;
    file = null;
    fileAnnouncement = '';
    if (fileInput) fileInput.value = '';
  }

  function handleDragOver(e: DragEvent) {
    if (isRestoring) return;
    e.preventDefault();
    dragActive = true;
  }

  function handleDragLeave() {
    dragActive = false;
  }

  function handleDrop(e: DragEvent) {
    if (isRestoring) return;
    e.preventDefault();
    dragActive = false;
    const dropped = e.dataTransfer?.files?.[0];
    if (dropped) selectFile(dropped);
  }

  async function handleRestore() {
    error = '';
    if (!file) { error = get(LL).restoreProfileErrorNoFile(); return; }
    if (!password) { error = get(LL).restoreProfileErrorNoPassword(); return; }

    isRestoring = true;
    try {
      await restoreFromEncryptedBackup(file, password);
      // Try unlocking immediately for a smooth experience (best-effort)
      try {
        await profileManager.unlockProfile(password);
      } catch {
        /* best-effort auto-unlock; reload below handles the locked case */
      }
      // Reload to ensure all stores/app state rehydrate cleanly
      window.location.reload();
    } catch (e) {
      error = get(LL).restoreProfileErrorGeneric();
    } finally {
      isRestoring = false;
    }
  }

  function handleCancel() {
    dispatch('cancel');
  }
</script>

<div class="profile-setup-container brand-backdrop">
  <div class="profile-setup-card">
    <div class="header">
      <h1>{$LL.restoreProfileTitle()}</h1>
      <p>{$LL.restoreProfileSubtitle()}</p>
    </div>

    {#if error}
      <div class="error-message" role="alert">{error}</div>
    {/if}

    <!-- Persistent live node: mounted from the start so file selection announces. -->
    <span class="visually-hidden" role="status">{fileAnnouncement}</span>

    <div class="form-group">
      <span class="field-label">{$LL.restoreProfileFileLabel()}</span>
      {#if !file}
        <div
          class="dropzone {dragActive ? 'active' : ''} {isRestoring ? 'disabled' : ''}"
          role="button"
          aria-label={$LL.restoreProfileFileLabel()}
          tabindex={isRestoring ? -1 : 0}
          on:click={openFileDialog}
          on:keydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openFileDialog();
            }
          }}
          on:dragover={handleDragOver}
          on:dragleave={handleDragLeave}
          on:drop={handleDrop}
        >
          <div class="dropzone-inner">
            <Icon name="upload" size={32} className="dz-icon" />
            <div class="dz-title">{$LL.restoreProfileDropzoneTitle()}</div>
            <div class="dz-subtitle">{$LL.restoreProfileDropzoneSubtitle()}</div>
          </div>
          <input
            bind:this={fileInput}
            class="file-input"
            type="file"
            accept=".ecb,application/octet-stream,application/json"
            on:change={handleFileChange}
            disabled={isRestoring}
            tabindex="-1"
          />
        </div>
      {:else}
        <div class="file-row">
          <div class="file-name">
            <Icon name="description" size={18} className="file-icon" />
            <span>{file.name}</span>
          </div>
          <button
            bind:this={clearFileButton}
            type="button"
            class="btn btn--secondary clear-file"
            on:click={clearSelectedFile}
            disabled={isRestoring}
            aria-label={$LL.restoreProfileClearFileAria()}>×</button
          >
        </div>
      {/if}
    </div>

    <div class="form-group">
      <label for="password">{$LL.restoreProfilePasswordLabel()}</label>
      <div class="password-input-container">
        <input
          id="password"
          type={showPassword ? 'text' : 'password'}
          value={password}
          on:input={(e) => (password = e.currentTarget.value)}
          class="input"
          placeholder={$LL.restoreProfilePasswordPlaceholder()}
          disabled={isRestoring}
          autocomplete="current-password"
          aria-describedby="password-help"
          on:keydown={(e) => e.key === 'Enter' && handleRestore()}
        />
        <button
          type="button"
          class="btn btn--secondary password-toggle"
          on:click={() => (showPassword = !showPassword)}
          disabled={isRestoring}
          title={passwordToggleLabel}
          aria-label={passwordToggleLabel}
        >
          <Icon
            name={showPassword ? 'eye-disabled' : 'eye'}
            size={20}
            className={`password-toggle-icon${showPassword ? ' password-toggle-icon--disabled' : ''}`}
          />
        </button>
      </div>
      <small class="form-help" id="password-help">{$LL.restoreProfilePasswordHelp()}</small>
    </div>

    <div class="form-actions">
      {#if !isRequired}
        <button type="button" class="btn btn--secondary" on:click={handleCancel} disabled={isRestoring}>
          {$LL.profileSetupCancel()}
        </button>
      {/if}
      <button
        type="button"
        class="btn btn--primary"
        on:click={handleRestore}
        disabled={isRestoring || !file || !password}>{isRestoring ? $LL.restoreProfileSubmitting() : $LL.restoreProfileSubmit()}</button>
    </div>

    <div class="security-note">
      <div class="security-icon"><Icon name="warning" size={20} className="security-icon-graphic" /></div>
      <div class="security-text">
        <strong>{$LL.restoreProfileWarningTitle()}</strong>
        <ul>
          <li>{$LL.restoreProfileWarningItem1()}</li>
          <li>{$LL.restoreProfileWarningItem2()}</li>
        </ul>
      </div>
    </div>
  </div>
</div>

<style>
  .profile-setup-container {
    min-height: 100vh;
    min-height: 100svh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .profile-setup-card {
    background: var(--color-surface);
    border-radius: 16px;
    padding: 2rem;
    width: 100%;
    max-width: 500px;
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
  }
  .header { text-align: center; margin-bottom: 1.25rem; }
  .header h1 { margin: 0 0 0.5rem 0; color: var(--color-text); font-size: 1.75rem; font-weight: 600; }
  .header p { margin: 0; color: var(--color-text-muted); font-size: 1rem; line-height: 1.4; }
  .form-group { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
  /* Labels use the form-group gap for spacing; drop the shared field-label margin. */
  .form-group label, .form-group :global(.field-label) { margin-bottom: 0; }
  .form-actions { display: flex; gap: 1rem; margin-top: 1rem; }
  .form-actions :global(.btn.btn--secondary) {
    flex: 1;
  }
  .form-actions :global(.btn.btn--primary) {
    flex: 2;
  }
  .error-message { background: var(--color-error-bg); border: 1px solid var(--color-error-border); color: var(--color-error-text); padding: 0.75rem; border-radius: 8px; font-size: 0.9rem; text-align: center; }
  .security-note { margin-top: 1rem; padding: 1rem; background: color-mix(in srgb, #fb923c 12%, var(--color-bg)); border: 1px solid #fb923c; border-radius: 8px; display: flex; gap: 0.75rem; align-items: flex-start; }
  .security-icon { flex-shrink: 0; color: #fb923c; display: flex; }
  .security-icon :global(.security-icon-graphic) { width: 1.5rem; height: 1.5rem; }
  .security-text { font-size: 0.85rem; color: var(--color-text); line-height: 1.4; }
  .security-text strong { display: block; margin-bottom: 0.5rem; }
  .security-text ul { margin: 0; padding-left: 1.25rem; }
</style>
