package com.kszyd.vcall

import android.content.Context

/**
 * 本地保存服务器地址、昵称与终端标识，方便电视遥控器重复使用。
 */
class AppPrefs(context: Context) {

    private val prefs = context.getSharedPreferences("vcall", Context.MODE_PRIVATE)

    var server: String
        get() = prefs.getString(KEY_SERVER, DEFAULT_SERVER) ?: DEFAULT_SERVER
        set(value) = prefs.edit().putString(KEY_SERVER, value).apply()

    var name: String
        get() = prefs.getString(KEY_NAME, "") ?: ""
        set(value) = prefs.edit().putString(KEY_NAME, value).apply()

    var deviceId: String
        get() = prefs.getString(KEY_DEVICE_ID, "") ?: ""
        set(value) = prefs.edit().putString(KEY_DEVICE_ID, value).apply()

    var speakerOn: Boolean
        get() = prefs.getBoolean(KEY_SPEAKER, true)
        set(value) = prefs.edit().putBoolean(KEY_SPEAKER, value).apply()

    /** 本地备注：JSON 字符串，形如 {"t1234":"小王"} */
    var aliases: String
        get() = prefs.getString(KEY_ALIASES, "{}") ?: "{}"
        set(value) = prefs.edit().putString(KEY_ALIASES, value).apply()

    /** 广角模式：用 720p 采集，视场角通常比 1080p 裁剪模式更宽 */
    var wideAngle: Boolean
        get() = prefs.getBoolean(KEY_WIDE_ANGLE, false)
        set(value) = prefs.edit().putBoolean(KEY_WIDE_ANGLE, value).apply()

    companion object {
        const val DEFAULT_SERVER = "192.168.199.100:9002"
        private const val KEY_SERVER = "server"
        private const val KEY_NAME = "name"
        private const val KEY_DEVICE_ID = "deviceId"
        private const val KEY_SPEAKER = "speaker"
        private const val KEY_ALIASES = "aliases"
        private const val KEY_WIDE_ANGLE = "wideAngle"
    }
}
