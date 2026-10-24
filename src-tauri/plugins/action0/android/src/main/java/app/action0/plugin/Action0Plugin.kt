package app.action0.plugin

import android.Manifest
import android.accounts.Account
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.view.View
import android.util.Base64
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.PermissionState
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope
import java.io.File
import java.security.MessageDigest
import java.util.UUID

@InvokeArg
class GoogleArgs {
  var scopes: Array<String> = arrayOf()
  var account: String? = null
  var interactive: Boolean = false
}

@InvokeArg
class TokenArgs {
  var token: String = ""
}

@InvokeArg
class TabArgs {
  var url: String = ""
  var redirect: String = ""
}

@InvokeArg
class KeyArgs {
  var key: String = ""
}

@InvokeArg
class FileArgs {
  var path: String = ""
  var name: String = ""
  var mimeType: String = "application/octet-stream"
}

@InvokeArg
class NoticeArgs {
  var tag: String = ""
  var title: String = ""
  var body: String = ""
  var url: String = ""
}

@InvokeArg
class PermissionArgs {
  var ask: Boolean = false
}

@InvokeArg
class ScheduleArgs {
  var enabled: Boolean = false
}

@InvokeArg
class ThemeArgs {
  var dark: Boolean = false
  /** The page's background ("#rrggbb"), shown below it (navigation bar). */
  var background: String = "#ffffff"
}

/**
 * action0's Android side. Rust calls most commands (sign-in, the vault key,
 * files, notifications); the UI calls `pending` and listens for `incoming`
 * (`mailto:` links, shares and notification taps that opened the app).
 */
@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")
  ]
)
class Action0Plugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())

  /** Links and shares that arrived before the UI listened. */
  private val waiting = mutableListOf<JSObject>()

  /** The sign-in tab under way: who waits, and where the browser comes back to. */
  private var tab: Invoke? = null
  private var tabRedirect: String? = null
  private var tabLeft = false

  /** What the navigation bar or the keyboard covers at the bottom, in CSS px. */
  private var bottom = 0f

  override fun load(webView: WebView) {
    AppState.foreground = true
    // The web view reports the status bar as safe area to the page, but
    // not the navigation bar or the keyboard: those go to the page as an
    // event (and `insets`). Watched on the web view's parent and passed on
    // untouched: the web view has its own listener for the safe area.
    val content = activity.findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val covered = insets.getInsets(
        WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.ime()
      ).bottom / view.resources.displayMetrics.density
      if (covered != bottom) {
        bottom = covered
        trigger("insets", JSObject().put("bottom", covered.toDouble()))
      }
      insets
    }
    ViewCompat.requestApplyInsets(content)
    handle(activity.intent)
  }

  /** What the navigation bar or the keyboard covers now. */
  @Command
  fun insets(invoke: Invoke) {
    invoke.resolve(JSObject().put("bottom", bottom.toDouble()))
  }

  override fun onNewIntent(intent: Intent) {
    handle(intent)
  }

  override fun onPause(activity: AppCompatActivity) {
    AppState.foreground = false
    if (tab != null) tabLeft = true
  }

  override fun onResume(activity: AppCompatActivity) {
    AppState.foreground = true
    val waitingTab = tab ?: return
    if (!tabLeft) return
    // Back without the browser's answer: the tab was closed. (The answer,
    // if any, arrives as a new intent just before this.)
    main.postDelayed({
      if (tab === waitingTab) {
        tab = null
        tabRedirect = null
        waitingTab.reject("The sign-in was closed.", "cancelled")
      }
    }, 800)
  }

  // Incoming links and shares.

  private fun handle(intent: Intent?) {
    intent ?: return
    val url = intent.dataString
    when (intent.action) {
      Intent.ACTION_VIEW -> {
        url ?: return
        val redirect = tabRedirect
        val waitingTab = tab
        if (redirect != null && waitingTab != null && url.startsWith(redirect)) {
          tab = null
          tabRedirect = null
          waitingTab.resolve(JSObject().put("value", url))
        } else if (url.startsWith("mailto:", ignoreCase = true)) {
          emit(JSObject().put("kind", "mailto").put("url", url))
        } else if (url.startsWith("action0:")) {
          emit(JSObject().put("kind", "open").put("url", url))
        }
      }
      Intent.ACTION_SENDTO ->
        if (url != null && url.startsWith("mailto:", ignoreCase = true))
          emit(JSObject().put("kind", "mailto").put("url", url))
      Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> {
        // Copying the files may take a moment: not on the UI thread.
        Thread { emit(shared(intent)) }.start()
      }
      else -> return
    }
    // Handled: a recreated activity mustn't see it again.
    activity.intent = Intent(Intent.ACTION_MAIN)
  }

  private fun emit(event: JSObject) {
    synchronized(waiting) {
      if (!hasListener("incoming")) {
        waiting.add(event)
        return
      }
    }
    trigger("incoming", event)
  }

  /** What another app shared: text, a subject, addresses, files (copied into the cache). */
  private fun shared(intent: Intent): JSObject {
    val uris = mutableListOf<Uri>()
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      @Suppress("DEPRECATION")
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let { uris.addAll(it) }
    } else {
      @Suppress("DEPRECATION")
      (intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))?.let { uris.add(it) }
    }
    val files = JSArray()
    val folder = File(activity.cacheDir, "shared/${UUID.randomUUID()}").apply { mkdirs() }
    for (uri in uris) {
      try {
        val name = displayName(uri) ?: "file"
        val file = File(folder, name.replace('/', '_'))
        activity.contentResolver.openInputStream(uri)?.use { input ->
          file.outputStream().use { output -> input.copyTo(output) }
        } ?: continue
        files.put(
          JSObject()
            .put("path", file.absolutePath)
            .put("name", name)
            .put("type", activity.contentResolver.getType(uri) ?: "application/octet-stream")
        )
      } catch (_: Exception) {
        // A file that can't be read is left out.
      }
    }
    val to = JSArray()
    intent.getStringArrayExtra(Intent.EXTRA_EMAIL)?.forEach { to.put(it) }
    return JSObject()
      .put("kind", "share")
      .put("text", intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
      .put("subject", intent.getStringExtra(Intent.EXTRA_SUBJECT))
      .put("to", to)
      .put("files", files)
  }

  private fun displayName(uri: Uri): String? =
    activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
      ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
      ?: uri.lastPathSegment

  /** What arrived before the UI listened (and forgets it). */
  @Command
  fun pending(invoke: Invoke) {
    val items = JSArray()
    synchronized(waiting) {
      waiting.forEach { items.put(it) }
      waiting.clear()
    }
    invoke.resolve(JSObject().put("items", items))
  }

  // Google, through Play services.

  @Command
  fun googleAuthorize(invoke: Invoke) {
    val args = invoke.parseArgs(GoogleArgs::class.java)
    val availability = GoogleApiAvailability.getInstance()
    if (availability.isGooglePlayServicesAvailable(activity) != ConnectionResult.SUCCESS) {
      invoke.reject("Google Play services aren't available on this phone.", "noPlayServices")
      return
    }
    val request = AuthorizationRequest.builder()
      .setRequestedScopes(args.scopes.map { Scope(it) })
      .apply { args.account?.let { setAccount(Account(it, "com.google")) } }
      .build()
    Identity.getAuthorizationClient(activity)
      .authorize(request)
      .addOnSuccessListener { result ->
        val pendingIntent = result.pendingIntent
        if (result.hasResolution() && pendingIntent != null) {
          if (!args.interactive) {
            invoke.reject("Google wants you to confirm the access again.", "interaction")
          } else {
            startIntentSenderForResult(
              invoke,
              IntentSenderRequest.Builder(pendingIntent.intentSender).build(),
              "googleAuthorized"
            )
          }
        } else {
          resolveToken(invoke, result)
        }
      }
      .addOnFailureListener { error -> rejectGoogle(invoke, error) }
  }

  @ActivityCallback
  private fun googleAuthorized(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode != Activity.RESULT_OK) {
      invoke.reject("The sign-in was closed.", "cancelled")
      return
    }
    try {
      resolveToken(
        invoke,
        Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(result.data)
      )
    } catch (error: ApiException) {
      rejectGoogle(invoke, error)
    }
  }

  private fun resolveToken(invoke: Invoke, result: AuthorizationResult) {
    val token = result.accessToken
    if (token == null) {
      invoke.reject("Google didn't hand out access.", "denied")
      return
    }
    val granted = JSArray()
    result.grantedScopes.forEach { granted.put(it) }
    invoke.resolve(JSObject().put("accessToken", token).put("grantedScopes", granted))
  }

  private fun rejectGoogle(invoke: Invoke, error: Exception) {
    when ((error as? ApiException)?.statusCode) {
      7 -> invoke.reject(error.message ?: "No connection to Google.", "network") // NETWORK_ERROR
      16 -> invoke.reject("The sign-in was closed.", "cancelled") // CANCELED
      // DEVELOPER_ERROR: no Android client for this package and key in Google Cloud.
      10 -> invoke.reject("This app isn't registered with Google (DEVELOPER_ERROR).", "provider")
      else -> invoke.reject(error.message ?: "Google sign-in failed.", "provider")
    }
  }

  @Command
  fun googleClear(invoke: Invoke) {
    val args = invoke.parseArgs(TokenArgs::class.java)
    Identity.getAuthorizationClient(activity)
      .clearToken(ClearTokenRequest.builder().setToken(args.token).build())
      .addOnCompleteListener { invoke.resolve() }
  }

  // Other sign-ins: a browser tab that comes back through a link.

  @Command
  fun authTab(invoke: Invoke) {
    val args = invoke.parseArgs(TabArgs::class.java)
    tab?.reject("Another sign-in started.", "cancelled")
    tab = invoke
    tabRedirect = args.redirect
    tabLeft = false
    try {
      CustomTabsIntent.Builder().build().launchUrl(activity, Uri.parse(args.url))
    } catch (_: ActivityNotFoundException) {
      tab = null
      tabRedirect = null
      invoke.reject("There's no browser on this phone to sign in with.", "provider")
    }
  }

  @Command
  fun signatureHash(invoke: Invoke) {
    val packageManager = activity.packageManager
    val signature = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      packageManager
        .getPackageInfo(activity.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        .signingInfo
        ?.apkContentsSigners
        ?.firstOrNull()
    } else {
      @Suppress("DEPRECATION")
      packageManager
        .getPackageInfo(activity.packageName, PackageManager.GET_SIGNATURES)
        .signatures
        ?.firstOrNull()
    }
    if (signature == null) {
      invoke.reject("The app's signature is unknown.")
      return
    }
    val hash = MessageDigest.getInstance("SHA").digest(signature.toByteArray())
    invoke.resolve(JSObject().put("value", Base64.encodeToString(hash, Base64.NO_WRAP)))
  }

  // The vault's key.

  @Command
  fun vaultKey(invoke: Invoke) {
    try {
      invoke.resolve(JSObject().put("value", VaultKey.load(activity)))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "The vault's key can't be read.")
    }
  }

  @Command
  fun saveVaultKey(invoke: Invoke) {
    val args = invoke.parseArgs(KeyArgs::class.java)
    try {
      VaultKey.save(activity, args.key)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "The vault's key can't be kept.")
    }
  }

  // Files for other apps.

  private fun uriOf(args: FileArgs): Uri =
    FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", File(args.path))

  @Command
  fun openFile(invoke: Invoke) {
    val args = invoke.parseArgs(FileArgs::class.java)
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uriOf(args), args.mimeType)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try {
      activity.startActivity(intent)
      invoke.resolve()
    } catch (_: ActivityNotFoundException) {
      invoke.reject("No app on this phone opens this file.", "noApp")
    }
  }

  @Command
  fun shareFile(invoke: Invoke) {
    val args = invoke.parseArgs(FileArgs::class.java)
    val intent = Intent(Intent.ACTION_SEND)
      .setType(args.mimeType)
      .putExtra(Intent.EXTRA_STREAM, uriOf(args))
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    activity.startActivity(Intent.createChooser(intent, args.name))
    invoke.resolve()
  }

  /** The file being saved with "Save to…", until the user has chosen where. */
  private var saving: FileArgs? = null

  @Command
  fun saveFile(invoke: Invoke) {
    val args = invoke.parseArgs(FileArgs::class.java)
    saving = args
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
      .addCategory(Intent.CATEGORY_OPENABLE)
      .setType(args.mimeType)
      .putExtra(Intent.EXTRA_TITLE, args.name)
    startActivityForResult(invoke, intent, "saved")
  }

  @ActivityCallback
  private fun saved(invoke: Invoke, result: ActivityResult) {
    val args = saving
    saving = null
    val target = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || target == null || args == null) {
      invoke.resolve(JSObject().put("value", false))
      return
    }
    try {
      activity.contentResolver.openOutputStream(target)?.use { output ->
        File(args.path).inputStream().use { input -> input.copyTo(output) }
      }
      invoke.resolve(JSObject().put("value", true))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "The file couldn't be saved.")
    }
  }

  // Notifications and the background check.

  @Command
  fun notify(invoke: Invoke) {
    val args = invoke.parseArgs(NoticeArgs::class.java)
    Notifications.post(activity, args.tag, args.title, args.body, args.url)
    invoke.resolve()
  }

  @Command
  fun notificationPermission(invoke: Invoke) {
    val args = invoke.parseArgs(PermissionArgs::class.java)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
      val state = if (Notifications.allowed(activity)) "granted" else "denied"
      invoke.resolve(JSObject().put("value", state))
      return
    }
    val state = getPermissionState("notifications")
    if (args.ask &&
      (state == PermissionState.PROMPT || state == PermissionState.PROMPT_WITH_RATIONALE)
    ) {
      requestPermissionForAlias("notifications", invoke, "notificationAnswer")
    } else {
      invoke.resolve(JSObject().put("value", answerOf(state)))
    }
  }

  @PermissionCallback
  private fun notificationAnswer(invoke: Invoke) {
    invoke.resolve(JSObject().put("value", answerOf(getPermissionState("notifications"))))
  }

  private fun answerOf(state: PermissionState?): String = when (state) {
    PermissionState.GRANTED -> "granted"
    PermissionState.DENIED -> "denied"
    else -> "prompt"
  }

  /** The system bars follow the app's theme (not only the phone's). */
  @Command
  fun setTheme(invoke: Invoke) {
    val args = invoke.parseArgs(ThemeArgs::class.java)
    activity.runOnUiThread {
      val window = activity.window
      try {
        window.decorView.setBackgroundColor(Color.parseColor(args.background))
      } catch (_: IllegalArgumentException) {
        // Not a color: the bars keep theirs.
      }
      WindowCompat.getInsetsController(window, window.decorView).apply {
        isAppearanceLightStatusBars = !args.dark
        isAppearanceLightNavigationBars = !args.dark
      }
      invoke.resolve()
    }
  }

  @Command
  fun scheduleChecks(invoke: Invoke) {
    val args = invoke.parseArgs(ScheduleArgs::class.java)
    Background.schedule(activity, args.enabled)
    invoke.resolve()
  }
}
