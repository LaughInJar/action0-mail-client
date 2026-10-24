package app.action0.plugin

import android.accounts.Account
import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Tasks
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** The periodic check for new mail while the app isn't open. */
object Background {
  private const val WORK = "action0-mail-check"

  /** Starts (or keeps) the check every 15 minutes or so, or stops it. */
  fun schedule(context: Context, enabled: Boolean) {
    val work = WorkManager.getInstance(context)
    if (!enabled) {
      work.cancelUniqueWork(WORK)
      return
    }
    val request = PeriodicWorkRequestBuilder<MailCheckWorker>(15, TimeUnit.MINUTES)
      .setConstraints(
        Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
      )
      .build()
    work.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
  }
}

/**
 * One check: Google tokens from Play services (silently: never a screen),
 * the rest in Rust, then the notifications. When the system runs it is up
 * to the system (battery, Doze); the app's own sync covers it while open.
 */
class MailCheckWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    if (AppState.foreground) return Result.success()
    try {
      check()
    } catch (error: Exception) {
      // The next period tries again.
      Log.w("action0", "Background check failed", error)
    }
    return Result.success()
  }

  private fun check() {
    val context = applicationContext
    val key = VaultKey.load(context) ?: return
    Native.load()
    val dataDir = context.dataDir.absolutePath
    val accounts = JSONArray(Native.accounts(dataDir, key))
    val tokens = JSONObject()
    for (i in 0 until accounts.length()) {
      val account = accounts.getJSONObject(i)
      if (account.getString("provider") != "google") continue
      val scopes = account.getJSONArray("scopes")
      val request = AuthorizationRequest.builder()
        .setRequestedScopes((0 until scopes.length()).map { Scope(scopes.getString(it)) })
        .setAccount(Account(account.getString("email"), "com.google"))
        .build()
      try {
        val result = Tasks.await(
          Identity.getAuthorizationClient(context).authorize(request),
          30,
          TimeUnit.SECONDS
        )
        // Needs the user: skipped until the app is opened.
        if (!result.hasResolution()) tokens.put(account.getString("key"), result.accessToken)
      } catch (error: Exception) {
        Log.w("action0", "No Google token in the background", error)
      }
    }
    val notices = JSONArray(Native.check(dataDir, key, tokens.toString()))
    for (i in 0 until notices.length()) {
      val notice = notices.getJSONObject(i)
      Notifications.post(
        context,
        notice.getString("tag"),
        notice.getString("title"),
        notice.getString("body"),
        notice.getString("url")
      )
    }
  }
}
