interface SecretStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
}

export function purgeWeakCredentials(
  storage: SecretStorage,
  clear: () => void,
  platform = process.platform,
): void {
  // Only a known plaintext fallback justifies deleting legacy records. A locked or
  // temporarily unavailable keyring must leave protected records recoverable.
  if (platform !== 'linux') return;
  let backend: string;
  try {
    backend = storage.getSelectedStorageBackend();
  } catch {
    return;
  }
  if (backend === 'basic_text') clear();
}

/** Linux's basic_text backend is not a protected credential store. */
export function secureStorageAvailable(
  storage: SecretStorage,
  platform = process.platform,
): boolean {
  try {
    if (!storage.isEncryptionAvailable()) return false;
    return (
      platform !== 'linux' ||
      ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
        storage.getSelectedStorageBackend(),
      )
    );
  } catch {
    return false;
  }
}
