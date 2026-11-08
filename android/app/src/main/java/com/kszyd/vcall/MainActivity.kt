package com.kszyd.vcall

import android.Manifest
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
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

/**
 * 仿微信视频通话的界面与交互：
 * 加入 -> 呼叫等待页 -> 接通（远端全屏 + 右上本地小窗 + 底部圆钮）-> 挂断
 */
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
    private var peerName = ""
    private var iceServers: List<PeerConnection.IceServer> = emptyList()
    private var isTv = false

    private var micOn = true
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
    private lateinit var localContainer: View
    private lateinit var topBar: View
    private lateinit var bottomBar: View
    private lateinit var peerNameView: TextView
    private lateinit var callTimer: TextView
    private lateinit var netStatus: TextView
    private lateinit var waitingOverlay: LinearLayout
    private lateinit var avatarText: TextView
    private lateinit var waitingName: TextView
    private lateinit var waitingHint: TextView
    private lateinit var waitingRoom: TextView
    private lateinit var cancelButton: View
    private lateinit var micButton: View
    private lateinit var micIcon: ImageView
    private lateinit var micLabel: TextView
    private lateinit var switchButton: View
    private lateinit var hangupButton: View
    private lateinit var speakerButton: View
    private lateinit var speakerIcon: ImageView
    private lateinit var speakerLabel: TextView
    private lateinit var hintOverlay: TextView

    private val ticker = object : Runnable {
        override fun run() {
            if (inCall && callStartAt > 0) {
                val elapsed = (SystemClock.elapsedRealtime() - callStartAt) / 1000
                callTimer.text = formatDuration(elapsed)
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

        if (isTv) joinButton.requestFocus()
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
        localContainer = findViewById(R.id.localContainer)
        topBar = findViewById(R.id.topBar)
        bottomBar = findViewById(R.id.bottomBar)
        peerNameView = findViewById(R.id.peerName)
        callTimer = findViewById(R.id.callTimer)
        netStatus = findViewById(R.id.netStatus)
        waitingOverlay = findViewById(R.id.waitingOverlay)
        avatarText = findViewById(R.id.avatarText)
        waitingName = findViewById(R.id.waitingName)
        waitingHint = findViewById(R.id.waitingHint)
        waitingRoom = findViewById(R.id.waitingRoom)
        cancelButton = findViewById(R.id.cancelButton)
        micButton = findViewById(R.id.micButton)
        micIcon = findViewById(R.id.micIcon)
        micLabel = findViewById(R.id.micLabel)
        switchButton = findViewById(R.id.switchButton)
        hangupButton = findViewById(R.id.hangupButton)
        speakerButton = findViewById(R.id.speakerButton)
        speakerIcon = findViewById(R.id.speakerIcon)
        speakerLabel = findViewById(R.id.speakerLabel)
        hintOverlay = findViewById(R.id.hintOverlay)
    }

    private fun setupDefaults() {
        serverInput.setText(prefs.server)
        nameInput.setText(prefs.name.ifEmpty { Build.MODEL ?: "VCall" })
        roomInput.setText(prefs.room)
        speakerOn = prefs.speakerOn
        updateMicUi()
        updateSpeakerUi()
        waitingRoom.text = getString(R.string.waiting_room, prefs.room)
    }

    private fun setupListeners() {
        joinButton.setOnClickListener { joinRoom() }
        hangupButton.setOnClickListener { leaveCall() }
        cancelButton.setOnClickListener { leaveCall() }
        micButton.setOnClickListener { toggleMic() }
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
                    peerName = peer?.optString("name") ?: ""
                    waitingHint.text = getString(R.string.connecting_peer)
                    waitingName.text = peerName.ifEmpty { getString(R.string.call_title) }
                    avatarText.text = initialOf(peerName)
                    startOffer()
                } else {
                    showWaitingUi(getString(R.string.waiting_peer))
                }
            }

            "peer-joined" -> {
                val peer = message.optJSONObject("peer")
                peerId = peer?.optString("id")
                peerName = peer?.optString("name") ?: ""
                waitingHint.text = getString(R.string.connecting_peer)
                waitingName.text = peerName.ifEmpty { getString(R.string.call_title) }
                avatarText.text = initialOf(peerName)
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
                peerName = ""
                showWaitingUi(getString(R.string.peer_left))
                showHint("$name 已离开")
            }

            "kicked" -> {
                showHint(message.optString("reason", getString(R.string.kicked)))
                leaveCall()
            }

            "error" -> {
                val code = message.optString("code")
                val text = message.optString("message", "发生错误")
                showHint(text)
                if (code == "room_full") leaveCall()
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
        val muted = JSONObject().put("audio", !micOn).put("video", false)
        sendJson(JSONObject().put("type", "state").put("muted", muted))
    }

    /* ------------------------------ 通话状态 ------------------------------ */

    private fun onRemoteVideo() {
        if (waitingOverlay.visibility == View.VISIBLE) {
            waitingOverlay.animate().alpha(0f).setDuration(220).withEndAction {
                waitingOverlay.visibility = View.GONE
                waitingOverlay.alpha = 1f
            }.start()
        }
        topBar.visibility = View.VISIBLE
        bottomBar.visibility = View.VISIBLE
        localContainer.visibility = View.VISIBLE
        peerNameView.text = peerName.ifEmpty { getString(R.string.call_title) }
        netStatus.text = getString(R.string.network_good)
        netStatus.setTextColor(Color.parseColor("#B3FFFFFF"))

        if (!inCall) {
            inCall = true
            callStartAt = SystemClock.elapsedRealtime()
            callTimer.text = "00:00"
            handler.removeCallbacks(ticker)
            handler.post(ticker)
        }
        if (isTv) hangupButton.requestFocus()
    }

    private fun onConnectionState(state: String) {
        when (state) {
            "connected" -> {
                netStatus.text = getString(R.string.network_good)
                netStatus.setTextColor(Color.parseColor("#B3FFFFFF"))
            }
            "disconnected" -> setNetworkBad()
            "failed" -> {
                setNetworkBad()
                showHint("连接失败，请重新加入")
            }
            else -> {
            }
        }
    }

    private fun setNetworkBad() {
        netStatus.text = getString(R.string.network_bad)
        netStatus.setTextColor(Color.parseColor("#FFFF8A80"))
    }

    private fun onStats(stats: CallSession.StatsSnapshot) {
        if (inCall) {
            val bad = stats.rttMs > 350 || (stats.bitrateKbps in 1..120)
            if (bad) setNetworkBad() else {
                netStatus.text = getString(R.string.network_good)
                netStatus.setTextColor(Color.parseColor("#B3FFFFFF"))
            }
        }
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

    /* ------------------------------ 控制 ------------------------------ */

    private fun toggleMic() {
        micOn = !micOn
        session?.setMicrophoneEnabled(micOn)
        updateMicUi()
        sendState()
    }

    private fun toggleSpeaker() {
        speakerOn = !speakerOn
        prefs.speakerOn = speakerOn
        session?.setSpeakerphone(speakerOn)
        updateSpeakerUi()
    }

    private fun switchCamera() {
        val switched = session?.switchCamera() == true
        if (switched) showHint("已切换摄像头") else showHint("当前设备不支持切换摄像头")
    }

    private fun updateMicUi() {
        if (micOn) {
            micIcon.setBackgroundResource(R.drawable.bg_circle_dark)
            micIcon.imageTintList = ColorStateList.valueOf(Color.WHITE)
            micLabel.text = getString(R.string.mic_on)
        } else {
            micIcon.setBackgroundResource(R.drawable.bg_circle_light)
            micIcon.imageTintList = ColorStateList.valueOf(Color.BLACK)
            micLabel.text = getString(R.string.mic_off)
        }
    }

    private fun updateSpeakerUi() {
        speakerLabel.text = getString(if (speakerOn) R.string.speaker else R.string.earpiece)
        if (speakerOn) {
            speakerIcon.setBackgroundResource(R.drawable.bg_circle_dark)
            speakerIcon.imageTintList = ColorStateList.valueOf(Color.WHITE)
        } else {
            speakerIcon.setBackgroundResource(R.drawable.bg_circle_light)
            speakerIcon.imageTintList = ColorStateList.valueOf(Color.BLACK)
        }
    }

    /* ------------------------------ 界面切换 ------------------------------ */

    private fun showSetup() {
        setupPanel.visibility = View.VISIBLE
        callPanel.visibility = View.GONE
    }

    private fun showCallUi() {
        setupPanel.visibility = View.GONE
        callPanel.visibility = View.VISIBLE
        topBar.visibility = View.GONE
        bottomBar.visibility = View.GONE
        localContainer.visibility = View.GONE
        waitingOverlay.visibility = View.VISIBLE
        waitingOverlay.alpha = 1f
        netStatus.text = getString(R.string.network_checking)
        callTimer.text = "00:00"
        peerNameView.text = getString(R.string.call_title)
        waitingName.text = getString(R.string.call_title)
        waitingHint.text = getString(R.string.waiting_peer)
        waitingRoom.text = getString(R.string.waiting_room, currentRoom)
        avatarText.text = initialOf(deviceName)
        micOn = true
        updateMicUi()
        updateSpeakerUi()
        if (isTv) cancelButton.requestFocus()
    }

    private fun showWaitingUi(hint: String) {
        inCall = false
        callStartAt = 0
        handler.removeCallbacks(ticker)
        topBar.visibility = View.GONE
        bottomBar.visibility = View.GONE
        localContainer.visibility = View.GONE
        waitingOverlay.visibility = View.VISIBLE
        waitingOverlay.alpha = 1f
        waitingHint.text = hint
        waitingName.text = peerName.ifEmpty { getString(R.string.call_title) }
        waitingRoom.text = getString(R.string.waiting_room, currentRoom)
        netStatus.text = getString(R.string.network_checking)
        callTimer.text = "00:00"
        if (isTv) cancelButton.requestFocus()
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
        peerName = ""
        selfId = ""
        waitingOverlay.alpha = 1f
        waitingOverlay.visibility = View.VISIBLE
        bottomBar.visibility = View.GONE
        topBar.visibility = View.GONE
        localContainer.visibility = View.GONE
        callTimer.text = "00:00"
        netStatus.text = getString(R.string.network_checking)
        showSetup()
        updateMicUi()
        updateSpeakerUi()
        if (isTv) joinButton.requestFocus()
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
        handler.postDelayed(hideHint, 2600)
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
        if (!hasPermissions()) {
            setupStatus.text = getString(R.string.permission_needed)
        }
        startJoin(serverInput.text.toString().trim())
    }

    override fun onBackPressed() {
        if (callPanel.visibility == View.VISIBLE) leaveCall() else super.onBackPressed()
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

    private fun initialOf(name: String): String {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return "V"
        return trimmed.substring(0, 1).uppercase()
    }

    private fun versionName(): String {
        return try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1.1.0"
        } catch (t: Throwable) {
            "1.1.0"
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
