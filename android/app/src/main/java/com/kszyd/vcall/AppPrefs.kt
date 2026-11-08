package com.kszyd.vcall

import android.content.Context

/**
 * 本地保存服务器地址、昵称与房间号，方便电视遥控器重复使用。
 */
class AppPrefs(context: Context) {

    private val prefs = context.getSharedPreferences("vcall", Context.MODE_PRIVATE)

    var server: String
        get() = prefs.getString(KEY_SERVER, DEFAULT_SERVER) ?: DEFAULT_SERVER
        set(value) = prefs.edit().putString(KEY_SERVER, value).apply()

    var name: String
        get() = prefs.getString(KEY_NAME, "") ?: ""
        set(value) = prefs.edit().putString(KEY_NAME, value).apply()

    var room: String
        get() = prefs.getString(KEY_ROOM, "1001") ?: "1001"
        set(value) = prefs.edit().putString(KEY_ROOM, value).apply()

    var speakerOn: Boolean
        get() = prefs.getBoolean(KEY_SPEAKER, true)
        set(value) = prefs.edit().putBoolean(KEY_SPEAKER, value).apply()

    companion object {
        const val DEFAULT_SERVER = "192.168.199.100:9002"
        private const val KEY_SERVER = "server"
        private const val KEY_NAME = "name"
        private const val KEY_ROOM = "room"
        private const val KEY_SPEAKER = "speaker"
    }
}
