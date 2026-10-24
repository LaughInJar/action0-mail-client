package app.action0.plugin

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The key of the account vault (`accounts.vault`, written by Rust). It's
 * kept in the app's preferences, encrypted with an AES key that lives in
 * the Android Keystore and never leaves it.
 */
object VaultKey {
  private const val ALIAS = "action0-vault"
  private const val PREFERENCES = "action0"
  private const val ENTRY = "vault-key"

  /** The vault's key (base64), or null if there's none yet. */
  fun load(context: Context): String? {
    val stored = preferences(context).getString(ENTRY, null) ?: return null
    val bytes = Base64.decode(stored, Base64.NO_WRAP)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, bytes, 0, 12))
    val key = cipher.doFinal(bytes, 12, bytes.size - 12)
    return Base64.encodeToString(key, Base64.NO_WRAP)
  }

  /** Keeps the vault's key (base64). */
  fun save(context: Context, key: String) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
    val sealed = cipher.iv + cipher.doFinal(Base64.decode(key, Base64.NO_WRAP))
    preferences(context)
      .edit()
      .putString(ENTRY, Base64.encodeToString(sealed, Base64.NO_WRAP))
      .apply()
  }

  private fun preferences(context: Context) =
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  private fun wrappingKey(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }
}
