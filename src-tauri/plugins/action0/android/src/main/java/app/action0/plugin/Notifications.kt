package app.action0.plugin

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** Notifications for new mail. Tapping one opens its `action0://` link in the app. */
object Notifications {
  private const val CHANNEL = "mail"

  fun allowed(context: Context): Boolean =
    NotificationManagerCompat.from(context).areNotificationsEnabled()

  fun post(context: Context, tag: String, title: String, body: String, url: String) {
    if (!allowed(context)) return
    ensureChannel(context)
    // Straight to the app's own activity: no other app can catch the link.
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    val open = launch
      .setAction(Intent.ACTION_VIEW)
      .setData(Uri.parse(url))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val tap = PendingIntent.getActivity(
      context,
      tag.hashCode(),
      open,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    val notification = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_mail)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setCategory(NotificationCompat.CATEGORY_EMAIL)
      .setContentIntent(tap)
      .setAutoCancel(true)
      .build()
    try {
      NotificationManagerCompat.from(context).notify(tag, 0, notification)
    } catch (_: SecurityException) {
      // The permission was taken back meanwhile.
    }
  }

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL) != null) return
    val channel = NotificationChannel(
      CHANNEL,
      context.getString(R.string.action0_channel_mail),
      NotificationManager.IMPORTANCE_DEFAULT
    )
    channel.description = context.getString(R.string.action0_channel_mail_description)
    manager.createNotificationChannel(channel)
  }
}
