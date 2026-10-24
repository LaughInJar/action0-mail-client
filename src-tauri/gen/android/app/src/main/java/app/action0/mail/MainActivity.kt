package app.action0.mail

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // The page draws under the system bars; action0's plugin tells it how
    // much the navigation bar and the keyboard cover.
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
