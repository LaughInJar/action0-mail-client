# Called from Rust through JNI, and by Tauri by reflection.
-keep class app.action0.plugin.Native { *; }
-keep class app.action0.plugin.Action0Plugin { *; }
-keep @app.tauri.annotation.InvokeArg class app.action0.plugin.** { *; }

# WorkManager creates its database and the workers by reflection; release
# builds otherwise lose their constructors (and crash at start).
-keep class * extends androidx.room.RoomDatabase { <init>(...); }
-keep class * extends androidx.work.ListenableWorker {
    <init>(android.content.Context, androidx.work.WorkerParameters);
}
