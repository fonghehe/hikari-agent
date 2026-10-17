import { expect, it } from 'vitest';
import {
  secureStorageAvailable,
  purgeWeakCredentials,
} from '../apps/desktop/src/main/secret-storage';

it('refuses Linux plaintext and unknown credential backends', () => {
  for (const backend of ['basic_text', 'unknown', '', 'future-unverified-backend'])
    expect(
      secureStorageAvailable(
        { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend },
        'linux',
      ),
    ).toBe(false);
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])
    expect(
      secureStorageAvailable(
        { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend },
        'linux',
      ),
    ).toBe(true);
});

it('requires encryption availability and does not inspect Linux backends on other platforms', () => {
  const storage = {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => {
      throw new Error('Not available');
    },
  };
  expect(secureStorageAvailable(storage, 'darwin')).toBe(false);
  storage.isEncryptionAvailable = () => true;
  expect(secureStorageAvailable(storage, 'darwin')).toBe(true);
  expect(secureStorageAvailable(storage, 'win32')).toBe(true);
});

it('clears known weak legacy records without deleting temporarily locked protected credentials', () => {
  for (const backend of ['basic_text', 'unknown', 'gnome_libsecret']) {
    let cleared = false;
    purgeWeakCredentials(
      { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => backend },
      () => {
        cleared = true;
      },
      'linux',
    );
    expect(cleared).toBe(backend === 'basic_text');
  }
  expect(() =>
    purgeWeakCredentials(
      { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' },
      () => {
        throw new Error('Cannot delete');
      },
      'linux',
    ),
  ).toThrow('Cannot delete');
});
