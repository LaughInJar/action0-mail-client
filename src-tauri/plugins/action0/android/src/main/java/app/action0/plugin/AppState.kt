package app.action0.plugin

/** Whether the app is in front (the background check leaves it to the app then). */
object AppState {
  @Volatile var foreground = false
}
