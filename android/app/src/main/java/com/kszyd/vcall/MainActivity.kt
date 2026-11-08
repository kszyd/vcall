package com.kszyd.vcall

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection
import org.webrtc.SurfaceViewRenderer

class MainActivity : AppCompatActivity(), SignalingClient.Listener {

    private lateinit var prefs: AppPrefs
    private lateinit var app: VCallApp
    private val handler = Handler(Looper.getMainLooper())

    private var signaling: SignalingClient? = null
    private var session: CallSession? = null

    private var selfId = ""
    private var peerId: String? = null
    private var currentRoom = ""
    private var deviceName = ""
    private var iceServers: List<PeerConnection.IceServer> = emptyList()
    private var isTv = false

    private var micOn = true
    private var camOn = true
    private var speakerOn = true
    private var inCall = false
    private var joining = false
    private var callStartAt = 0L

    private lateinit var setupPanel: View
    private lateinit var serverInput: EditText
    private lateinit var nameInput: EditText
    private lateinit var roomInput: EditText
    private lateinit var joinButton: Button
    private lateinit var setupStatus: TextView
    private lateinit var announcementText: TextView

    private lateinit var callPanel: View
    private lateinit var remoteRenderer: SurfaceViewRenderer
    private lateinit var localRenderer: SurfaceViewRenderer
    private lateinit var waitingOverlay: LinearLayout
    private lateinit var waitingTitle: TextView
    private lateinit var waitingRoom: TextView
    private lateinit var roomBadge: TextView
    private lateinit var stateBadge: TextView
    private lateinit var statsBadge: TextView
    private lateinit var hintOverlay: TextView
    private lateinit var micButton: Button
    private lateinit var camButton: Button
    private lateinit var switchButton: Button
    private lateinit var speakerButton: Button
    private lateinit var hangupButton: Button

    private val ticker = object : Runnable {
        override fun run() {
            if (inCall && callStartAt > 0) {
                val elapsed = (SystemClock.elapsedRealtime() - callStartAt) / 1000
                stateBadge.text = getString(R.string.state_in_call) + " " + formatDuration(elapsed)
            }
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        prefs = AppPrefs(this)
        app = application as VCallApp
        isTv = packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
            packageManager.hasSystemFeature("android.hardware.type.television")

        bindViews()
        setupDefaults()
        setupListeners()
        showSetup()

        if (isTv) {
            joinButton.requestFocus()
        }
    }

    private fun bindViews() {
        setupPanel = findViewById(R.id.setupPanel)
        serverInput = findViewById(R.id.serverInput)
        nameInput = findViewById(R.id.nameInput)
        roomInput = findViewById(R.id.roomInput)
        joinButton = findViewById(R.id.joinButton)
        setupStatus = findViewById(R.id.setupStatus)
        announcementText = findViewById(R.id.announcementText)

        callPanel = findViewById(R.id.callPanel)
        remoteRenderer = findViewById(R.id.remoteRenderer)
        localRenderer = findViewById(R.id.localRenderer)
        waitingOverlay = findViewById(R.id.waitingOverlay)
        waitingTitle = findViewById(R.id.waitingTitle)
        waitingRoom = findViewById(R.id.waitingRoom)
        roomBadge = findViewById(R.id.roomBadge)
        stateBadge = findViewById(R.id.stateBadge)
        statsBadge = findViewById(R.id.statsBadge)
        hintOverlay = findViewById(R.id.hintOverlay)
        micButton = findViewById(R.id.micButton)
        camButton = findViewById(R.id.camButton)
        switchButton = findViewById(R.id.switchButton)
        speakerButton = findViewById(R.id.speakerButton)
        hangupButton = findViewById(R.id.hangupButton)
    }

    private fun setupDefaults() {
        serverInput.setText(prefs.server)
        nameInput.setText(prefs.name.ifEmpty { Build.MODEL ?: "VCall" })
        roomInput.setText(prefs.room)
        speakerOn = prefs.speakerOn
        updateSpeakerButton()
        updateMicButton()
        updateCamButton()
        roomBadge.text = "房间 " + prefs.room
    }

    private fun setupListeners() {
        joinButton.setOnClickListener { joinRoom() }
        hangupButton.setOnClickListener { leaveCall() }
        micButton.setOnClickListener { toggleMic() }
        camButton.setOnClickListener { toggleCam() }
        switchButton.setOnClickListener { switchCamera() }
        speakerButton.setOnClickListener { toggleSpeaker() }
    }

    /* ------------------------------ 加入流程 ------------------------------ */

    private fun joinRoom() {
        if (joining) return
        val server = serverInput.text.toString().trim()
        val name = nameInput.text.toString().trim().ifEmpty { Build.MODEL ?: "VCall 设备" }
        val room = roomInput.text.toString().trim()

        if (server.isEmpty()) {
            showSetupMessage(getString(R.string.server_invalid))
            serverInput.requestFocus()
            return
        }
        if (!ROOM_PATTERN.matches(room)) {
            showSetupMessage(getString(R.string.room_invalid))
            roomInput.requestFocus()
            return
        }

        currentRoom = room
        deviceName = name
        prefs.server = server
        prefs.name = name
        prefs.room = room

        if (!hasPermissions()) {
            joining = true
            ActivityCompat.requestPermissions(this, REQUIRED_PERMISSIONS, REQUEST_PERMISSIONS)
            return
        }
        startJoin(server)
    }

    private fun startJoin(server: String) {
        joining = true
        showCallUi()
        prepareSession()
        connectSignaling(server)
    }

    private fun prepareSession() {
        val existing = session
        if (existing != null) {
            existing.setIceServers(iceServers)
            return
        }
        val created = CallSession(this, app, localRenderer, remoteRenderer)
        created.initRenderers()
        created.setIceServers(iceServers)
        created.setSpeakerphone(speakerOn)
        created.onIceCandidate = { candidate -> sendIce(candidate) }
        created.onRemoteStream = { runOnUiThread { onRemoteVideo() } }
        created.onConnectionState = { state -> runOnUiThread { onConnectionState(state) } }
        created.onStats = { stats -> runOnUiThread { onStats(stats) } }
        created.onError = { message -> runOnUiThread { showHint(message) } }
        session = created

        val hasCamera = created.startLocalMedia()
        if (!hasCamera) {
            showHint(getString(R.string.no_camera))
        }
    }

    private fun connectSignaling(server: String) {
        signaling?.close()
        val url = SignalingClient.normalizeUrl(server)
        signaling = SignalingClient(this).also { it.connect(url) }
        setSetupMessage(getString(R.string.connecting_server))
    }

    /* ------------------------------ 信令回调 ------------------------------ */

    override fun onSignalingOpen() {
        runOnUiThread {
            val device = JSONObject().apply {
                put("platform", "android")
                put("model", Build.MODEL ?: "")
                put("brand", Build.BRAND ?: "")
                put("os", "Android " + Build.VERSION.RELEASE)
                put("appVersion", versionName())
                put("isTv", isTv)
            }
            val message = JSONObject().apply {
                put("type", "join")
                put("room", currentRoom)
                put("name", deviceName)
                put("device", device)
            }
            signaling?.send(message)
        }
    }

    override fun onSignalingMessage(message: JSONObject) {
        runOnUiThread { handleMessage(message) }
    }

    override fun onSignalingClosed(code: Int, reason: String) {
        runOnUiThread {
            if (callPanel.visibility == View.VISIBLE) {
                showHint(getString(R.string.state_disconnected))
                leaveCall()
            }
        }
    }

    override fun onSignalingFailure(error: Throwable) {
        runOnUiThread {
            joining = false
            if (callPanel.visibility == View.VISIBLE) {
                showHint("无法连接服务器：${error.message ?: "网络错误"}")
                leaveCall()
            } else {
                showSetupMessage("无法连接服务器：${error.message ?: "网络错误"}")
            }
        }
    }

    private fun handleMessage(message: JSONObject) {
        when (message.optString("type")) {
            "welcome" -> {
                iceServers = CallSession.parseIceServers(message.optJSONArray("iceServers"))
                session?.setIceServers(iceServers)
                val announcement = message.optString("announcement", "")
                if (announcement.isNotEmpty()) {
                    announcementText.text = announcement
                    announcementText.visibility = View.VISIBLE
                }
            }

            "joined" -> {
                joining = false
                selfId = message.optJSONObject("self")?.optString("id") ?: ""
                setSetupMessage("")
                val peers = message.optJSONArray("peers")
                if (peers != null && peers.length() > 0) {
                    val peer = peers.optJSONObject(0)
                    peerId = peer?.optString("id")
                    waitingTitle.text = "正在接通 " + (peer?.optString("name") ?: "对方") + "…"
                    stateBadge.text = getString(R.string.state_connecting)
                    startOffer()
                } else {
                    showWaiting()
                }
            }

            "peer-joined" -> {
                val peer = message.optJSONObject("peer")
                peerId = peer?.optString("id")
                waitingTitle.text = "正在接通 " + (peer?.optString("name") ?: "对方") + "…"
                stateBadge.text = getString(R.string.state_connecting)
            }

            "offer" -> {
                peerId = message.optString("from")
                session?.createPeerConnection()
                session?.handleOffer(message.optString("sdp")) { answer ->
                    if (answer != null) {
                        sendJson(
                            JSONObject()
                                .put("type", "answer")
                                .put("to", peerId)
                                .put("sdp", answer)
                        )
                    } else {
                        runOnUiThread { showHint("应答失败，请重试") }
                    }
                }
            }

            "answer" -> session?.handleAnswer(message.optString("sdp"))

            "ice" -> {
                val candidate = message.optJSONObject("candidate")
                if (candidate != null) session?.addIceCandidate(candidate)
            }

            "peer-left", "peer-hangup" -> {
                val name = message.optString("name", "对方")
                session?.closePeerConnection()
                inCall = false
                callStartAt = 0
                waitingOverlay.visibility = View.VISIBLE
                waitingTitle.text = "对方已离开"
                waitingRoom.text = "房间 $currentRoom · 等待重新接通"
                stateBadge.text = getString(R.string.state_waiting)
                showHint("$name 已离开")
            }

            "kicked" -> {
                showHint(message.optString("reason", getString(R.string.kicked)))
                leaveCall()
            }

            "error" -> {
                val code = message.optString("code")
                val text = message.optString("message", "发生错误")
                if (code == "room_full") {
                    showHint(text)
                    leaveCall()
                } else {
                    showHint(text)
                }
            }

            "pong" -> {
            }
        }
    }

    private fun startOffer() {
        session?.createPeerConnection()
        session?.createOffer { sdp ->
            if (sdp != null) {
                sendJson(JSONObject().put("type", "offer").put("to", peerId).put("sdp", sdp))
            } else {
                runOnUiThread { showHint("创建通话失败，请重试") }
            }
        }
    }

    private fun sendIce(candidate: IceCandidate) {
        val payload = JSONObject().apply {
            put("type", "ice")
            put("to", peerId)
            put(
                "candidate",
                JSONObject().apply {
                    put("sdpMid", candidate.sdpMid ?: "")
                    put("sdpMLineIndex", candidate.sdpMLineIndex)
                    put("candidate", candidate.sdp)
                }
            )
        }
        sendJson(payload)
    }

    private fun sendJson(json: JSONObject) {
        signaling?.send(json)
    }

    private fun sendState() {
        val muted = JSONObject().put("audio", !micOn).put("video", !camOn)
        sendJson(JSONObject().put("type", "state").put("muted", muted))
    }

    /* ------------------------------ 通话状态 ------------------------------ */

    private fun onRemoteVideo() {
        waitingOverlay.visibility = View.GONE
        if (!inCall) {
            inCall = true
            callStartAt = SystemClock.elapsedRealtime()
            handler.removeCallbacks(ticker)
            handler.post(ticker)
        }
        stateBadge.text = getString(R.string.state_in_call)
    }

    private fun onConnectionState(state: String) {
        when (state) {
            "connected" -> {
                if (inCall) stateBadge.text = getString(R.string.state_in_call)
            }
            "disconnected" -> showHint("网络不稳定，正在恢复…")
            "failed" -> showHint("连接失败，请重新加入")
            else -> {
            }
        }
    }

    private fun onStats(stats: CallSession.StatsSnapshot) {
        val parts = mutableListOf<String>()
        if (stats.width > 0 && stats.height > 0) parts.add("${stats.width}×${stats.height}")
        if (stats.fps > 0) parts.add("${stats.fps}fps")
        if (stats.bitrateKbps > 0) parts.add("${stats.bitrateKbps}kbps")
        if (stats.rttMs > 0) parts.add("${stats.rttMs}ms")
        statsBadge.text = if (parts.isEmpty()) "已连接" else parts.joinToString(" · ")

        // 上报给管理后台
        val payload = JSONObject().apply {
            put("type", "stats")
            put("rtt", stats.rttMs)
            put("bitrate", stats.bitrateKbps * 1000)
            put("width", stats.width)
            put("height", stats.height)
            put("fps", stats.fps)
        }
        sendJson(payload)
    }

    private fun toggleMic() {
        micOn = !micOn
        session?.setMicrophoneEnabled(micOn)
        updateMicButton()
        sendState()
        showHint(if (micOn) "麦克风已开启" else "麦克风已静音")
    }

    private fun toggleCam() {
        camOn = !camOn
        session?.setVideoEnabled(camOn)
        updateCamButton()
        sendState()
        showHint(if (camOn) "摄像头已开启" else "摄像头已关闭")
    }

    private fun switchCamera() {
        val switched = session?.switchCamera() == true
        if (switched) {
            showHint("已切换摄像头")
        } else {
            showHint("当前设备不支持切换摄像头")
        }
    }

    private fun toggleSpeaker() {
        speakerOn = !speakerOn
        prefs.speakerOn = speakerOn
        session?.setSpeakerphone(speakerOn)
        updateSpeakerButton()
    }

    private fun updateMicButton() {
        micButton.text = getString(if (micOn) R.string.mic_on else R.string.mic_off)
    }

    private fun updateCamButton() {
        camButton.text = getString(if (camOn) R.string.cam_on else R.string.cam_off)
    }

    private fun updateSpeakerButton() {
        speakerButton.text = getString(if (speakerOn) R.string.speaker else R.string.earpiece)
    }

    /* ------------------------------ 界面切换 ------------------------------ */

    private fun showSetup() {
        setupPanel.visibility = View.VISIBLE
        callPanel.visibility = View.GONE
    }

    private fun showCallUi() {
        setupPanel.visibility = View.GONE
        callPanel.visibility = View.VISIBLE
        waitingOverlay.visibility = View.VISIBLE
        waitingTitle.text = getString(R.string.waiting_title)
        waitingRoom.text = "房间 $currentRoom"
        roomBadge.text = "房间 $currentRoom"
        stateBadge.text = getString(R.string.state_connecting)
        statsBadge.text = "--"
        setSetupMessage("")
        joinButton.isEnabled = true
        joinButton.text = getString(R.string.join_room)
    }

    private fun showWaiting() {
        waitingOverlay.visibility = View.VISIBLE
        waitingTitle.text = getString(R.string.waiting_title)
        waitingRoom.text = "房间 $currentRoom"
        stateBadge.text = getString(R.string.state_waiting)
        inCall = false
        callStartAt = 0
        handler.removeCallbacks(ticker)
    }

    private fun leaveCall() {
        sendJson(JSONObject().put("type", "hangup"))
        sendJson(JSONObject().put("type", "leave"))
        joining = false
        inCall = false
        callStartAt = 0
        handler.removeCallbacks(ticker)
        signaling?.close()
        signaling = null
        session?.release()
        session = null
        peerId = null
        selfId = ""
        waitingOverlay.visibility = View.VISIBLE
        statsBadge.text = "--"
        stateBadge.text = getString(R.string.state_connecting)
        showSetup()
        updateMicButton()
        updateCamButton()
    }

    private fun setSetupMessage(text: String) {
        setupStatus.text = text
    }

    private fun showSetupMessage(text: String) {
        setupStatus.text = text
    }

    private fun showHint(text: String) {
        if (text.isEmpty()) return
        hintOverlay.text = text
        hintOverlay.visibility = View.VISIBLE
        handler.removeCallbacks(hideHint)
        handler.postDelayed(hideHint, 3000)
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
    }

    private val hideHint = Runnable { hintOverlay.visibility = View.GONE }

    /* ------------------------------ 工具 ------------------------------ */

    private fun hasPermissions(): Boolean {
        return REQUIRED_PERMISSIONS.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_PERMISSIONS) return
        joining = false
        if (hasPermissions()) {
            startJoin(serverInput.text.toString().trim())
        } else {
            // 缺少摄像头/麦克风仍可加入房间接收画面
            setupStatus.text = getString(R.string.permission_needed)
            startJoin(serverInput.text.toString().trim())
        }
    }

    override fun onBackPressed() {
        if (callPanel.visibility == View.VISIBLE) {
            leaveCall()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacksAndMessages(null)
        try {
            signaling?.close()
        } catch (ignored: Throwable) {
        }
        signaling = null
        try {
            session?.release()
        } catch (ignored: Throwable) {
        }
        session = null
    }

    private fun versionName(): String {
        return try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0.0"
        } catch (t: Throwable) {
            "1.0.0"
        }
    }

    private fun formatDuration(seconds: Long): String {
        val minutes = seconds / 60
        val remain = seconds % 60
        return String.format("%02d:%02d", minutes, remain)
    }

    companion object {
        private const val REQUEST_PERMISSIONS = 1001
        private val REQUIRED_PERMISSIONS = arrayOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO
        )
        private val ROOM_PATTERN = Regex("^[0-9A-Za-z_-]{1,32}$")
    }
}
