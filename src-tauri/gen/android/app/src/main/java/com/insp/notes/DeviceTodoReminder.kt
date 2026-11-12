package com.insp.notes

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.Calendar

internal object DeviceTodoReminder {
    private const val KEY = "device-todo-reminders-v1"

    private fun records(context: Context): JSONArray =
        JSONArray(DeviceSecrets(context).get(KEY) ?: "[]")

    private fun pending(context: Context, id: String): PendingIntent = PendingIntent.getBroadcast(
        context, id.hashCode(), Intent(context, DeviceTodoReceiver::class.java).apply {
            data = Uri.parse("insp://todo/$id")
            putExtra("id", id)
        }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private fun nextTime(first: Long, repeat: String): Long {
        if (repeat == "none") return first
        val calendar = Calendar.getInstance().apply { timeInMillis = first }
        val field = when (repeat) { "daily" -> Calendar.DATE; "weekly" -> Calendar.WEEK_OF_YEAR; else -> Calendar.MONTH }
        while (calendar.timeInMillis <= System.currentTimeMillis()) calendar.add(field, 1)
        return calendar.timeInMillis
    }

    private fun arm(context: Context, record: JSONObject) {
        val alarm = context.getSystemService(AlarmManager::class.java)
        val time = nextTime(record.getLong("time"), record.getString("repeat"))
        if (time <= System.currentTimeMillis()) return
        val intent = pending(context, record.getString("id"))
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarm.canScheduleExactAlarms())
            alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, time, intent)
        else alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, time, intent)
    }

    fun schedule(context: Context, args: TodoScheduleArgs) {
        val old = records(context)
        val updated = JSONArray()
        for (index in 0 until old.length()) if (old.getJSONObject(index).getString("id") != args.id) updated.put(old.getJSONObject(index))
        val record = JSONObject().put("id", args.id).put("text", args.text)
            .put("time", Instant.parse(args.remindAt).toEpochMilli()).put("repeat", args.repeat)
        updated.put(record)
        DeviceSecrets(context).set(KEY, updated.toString())
        context.getSystemService(AlarmManager::class.java).cancel(pending(context, args.id))
        arm(context, record)
    }

    fun cancel(context: Context, id: String) {
        val old = records(context)
        val updated = JSONArray()
        for (index in 0 until old.length()) if (old.getJSONObject(index).getString("id") != id) updated.put(old.getJSONObject(index))
        DeviceSecrets(context).set(KEY, updated.toString())
        context.getSystemService(AlarmManager::class.java).cancel(pending(context, id))
        context.getSystemService(NotificationManager::class.java).cancel(id.hashCode())
    }

    fun record(context: Context, id: String): JSONObject? {
        val list = records(context)
        for (index in 0 until list.length()) if (list.getJSONObject(index).getString("id") == id) return list.getJSONObject(index)
        return null
    }

    fun restore(context: Context) {
        val list = records(context)
        for (index in 0 until list.length()) arm(context, list.getJSONObject(index))
    }

    fun repeat(context: Context, record: JSONObject) {
        if (record.getString("repeat") != "none") arm(context, record)
    }
}

class DeviceTodoReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val record = DeviceTodoReminder.record(context, intent.getStringExtra("id") ?: return) ?: return
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val notifications = context.getSystemService(NotificationManager::class.java)
        notifications.createNotificationChannel(NotificationChannel("todo", "待办提醒", NotificationManager.IMPORTANCE_HIGH))
        val id = record.getString("id")
        val open = PendingIntent.getActivity(context, id.hashCode(), Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        notifications.notify(id.hashCode(), NotificationCompat.Builder(context, "todo")
            .setSmallIcon(R.mipmap.ic_launcher).setContentTitle("拾页 · 待办")
            .setContentText(record.getString("text")).setAutoCancel(true).setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_HIGH).build())
        DeviceTodoReminder.repeat(context, record)
    }
}

class DeviceTodoBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) DeviceTodoReminder.restore(context)
    }
}
