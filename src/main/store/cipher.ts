/** Abstraction over at-rest encryption so the store can be unit-tested without Electron. */
export interface Cipher {
  encrypt(plain: string): string
  decrypt(encrypted: string): string
}

/** Uses Electron safeStorage (backed by the macOS Keychain). Must be created after app 'ready'. */
export async function createElectronCipher(): Promise<Cipher> {
  const { safeStorage } = await import('electron')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption is not available on this system')
  }
  return {
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (enc) => safeStorage.decryptString(Buffer.from(enc, 'base64'))
  }
}

/** Reversible, non-secret encoding. Only for tests. */
export function createPlainCipher(): Cipher {
  return {
    encrypt: (plain) => 'plain:' + Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: (enc) => Buffer.from(enc.replace(/^plain:/, ''), 'base64').toString('utf8')
  }
}
