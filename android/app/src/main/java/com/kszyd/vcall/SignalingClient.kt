package com.kszyd.vcall

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 基于 OkHttp 的 WebSocket 信令客户端。
 */
class SignalingClient(private val listener: Listener) {

    interface Listener {
        fun onSignalingOpen()
        fun onSignalingMessage(message: JSONObject)
        fun onSignalingClosed(code: Int, reason: String)
        fun onSignalingFailure(error: Throwable)
    }

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private var webSocket: WebSocket? = null

    @Volatile
    private var closedNotified = false

    fun connect(url: String) {
        closedNotified = false
        val request = Request.Builder().url(url).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                listener.onSignalingOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val json = try {
                    JSONObject(text)
                } catch (t: Throwable) {
                    return
                }
                listener.onSignalingMessage(json)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (closedNotified) return
                closedNotified = true
                listener.onSignalingClosed(code, reason)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (closedNotified) return
                closedNotified = true
                listener.onSignalingFailure(t)
            }
        })
    }

    fun send(message: JSONObject): Boolean {
        return webSocket?.send(message.toString()) ?: false
    }

    fun close() {
        try {
            webSocket?.close(1000, "bye")
        } catch (t: Throwable) {
            // ignore
        }
        webSocket = null
    }

    /**
     * 把用户输入的地址规范化为 ws 地址：
     * 192.168.199.100:9002 -> ws://192.168.199.100:9002/ws
     */
    companion object {
        fun normalizeUrl(input: String): String {
            var value = input.trim().trimEnd('/')
            if (value.isEmpty()) return ""
            value = when {
                value.startsWith("wss://", ignoreCase = true) -> value
                value.startsWith("ws://", ignoreCase = true) -> value
                value.startsWith("https://", ignoreCase = true) -> "wss://" + value.substring(8)
                value.startsWith("http://", ignoreCase = true) -> "ws://" + value.substring(7)
                else -> "ws://$value"
            }
            if (!value.endsWith("/ws")) {
                value = value.trimEnd('/') + "/ws"
            }
            return value
        }
    }
}
