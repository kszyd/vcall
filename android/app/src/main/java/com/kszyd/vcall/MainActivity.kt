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
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection
import org.webrtc.SurfaceViewRenderer

/**
 * 仿微信通讯录的视频通话：
 * 登录 -> 在线终端列表 -> 点选呼叫 / 多人呼叫 -> 来电接听 -> 通话
 */
class MainActivity : AppCompatActivity(), SignalingClient.Listener {

    private data class Terminal(
        val id: String,
        val name: String,
        val platform: String,
        val isTv: Boolean,
        val state: String
    )

    private lateinit var prefs: AppPrefs
    private lateinit var app: VCallApp
    private val handler = Handler(Looper.getMainLooper())

    private var signaling: SignalingClient? = null
    private var session: CallSession? = null

    private var selfId = ""
    private var selfName = ""
    private var iceServers: List<PeerConnection.IceServer> = emptyList()
    private var isTv = false

    private var terminals: List<Terminal> = emptyList()
    private val selected = linkedSetOf<String>()
    private val peerNames = mutableMapOf<String, String>()

    private var callId: String? = null
    private var inCall = false
    private var callStartAt = 0L
    private var micOn = true
    private var speakerOn = true

    private var incomingCallId: String? = null

    private lateinit var loginPanel: View
    private lateinit var directoryPanel: View
    private lateinit var callPanel: View
    private lateinit var incomingPanel: View

    private lateinit var serverInput: EditText
    private lateinit var nameInput: EditText
    private lateinit var joinButton: Button
    private lateinit var setupStatus: TextView
    private lateinit var announcementText: TextView

    private lateinit var myAvatar: TextView
    private lateinit var myName: TextView
    private lateinit var myState: TextView
    private lateinit var logoutButton: Button
    private lateinit var searchInput: EditText
    private lateinit var callSelectedButton: Button
    private lateinit var listHead: TextView
    private lateinit var terminalList: LinearLayout
    private lateinit var emptyHint: TextView

    private lateinit var remoteGrid: GridLayout
    private lateinit var localRenderer: SurfaceViewRenderer
    private lateinit var localContainer: View
    private lateinit var callTitle: TextView
    private lateinit var callTimer: TextView
    private lateinit var netStatus: TextView
    private lateinit var micButton: View
    private lateinit var micIcon: ImageView
    private lateinit var micLabel: TextView
    private lateinit var switchButton: View
    private lateinit var hangupButton: View
    private lateinit var speakerButton: View
    private lateinit var speakerIcon: ImageView
    private lateinit var speakerLabel: TextView
    private lateinit var hintOverlay: TextView

    private lateinit var incomingAvatar: TextView
    private lateinit var incomingName: TextView
    private lateinit var incomingHint: TextView
    private lateinit var rejectButton: Button
    private lateinit var acceptButton: Button

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
        showLogin()

        if (isTv) joinButton.requestFocus()
    }

    private fun bindViews() {
        loginPanel = findViewById(R.id.loginPanel)
        directoryPanel = findViewById(R.id.directoryPanel)
        callPanel = findViewById(R.id.callPanel)
        incomingPanel = findViewById(R.id.incomingPanel)

        serverInput = findViewById(R.id.serverInput)
        nameInput = findViewById(R.id.nameInput)
        joinButton = findViewById(R.id.joinButton)
        setupStatus = findViewById(R.id.setupStatus)
        announcementText = findViewById(R.id.announcementText)

        myAvatar = findViewById(R.id.myAvatar)
        myName = findViewById(R.id.myName)
        myState = findViewById(R.id.myState)
        logoutButton = findViewById(R.id.logoutButton)
        searchInput = findViewById(R.id.searchInput)
        callSelectedButton = findViewById(R.id.callSelectedButton)
        listHead = findViewById(R.id.listHead)
        terminalList = findViewById(R.id.terminalList)
        emptyHint = findViewById(R.id.emptyHint)

        remoteGrid = findViewById(R.id.remoteGrid)
        localRenderer = findViewById(R.id.localRenderer)
        localContainer = findViewById(R.id.localContainer)
        callTitle = findViewById(R.id.callTitle)
        callTimer = findViewById(R.id.callTimer)
        netStatus = findViewById(R.id.netStatus)
        micButton = findViewById(R.id.micButton)
        micIcon = findViewById(R.id.micIcon)
        micLabel = findViewById(R.id.micLabel)
        switchButton = findViewById(R.id.switchButton)
        hangupButton = findViewById(R.id.hangupButton)
        speakerButton = findViewById(R.id.speakerButton)
        speakerIcon = findViewById(R.id.speakerIcon)
        speakerLabel = findViewById(R.id.speakerLabel)
        hintOverlay = findViewById(R.id.hintOverlay)

        incomingAvatar = findViewById(R.id.incomingAvatar)
        incomingName = findViewById(R.id.incomingName)
        incomingHint = findViewById(R.id.incomingHint)
        rejectButton = findViewById(R.id.rejectButton)
        acceptButton = findViewById(R.id.acceptButton)
    }

    private fun setupDefaults() {
        serverInput.setText(prefs.server)
        nameInput.setText(prefs.name.ifEmpty { Build.MODEL ?: "VCall" })
        speakerOn = prefs.speakerOn
        updateMicUi()
        updateSpeakerUi()
    }

    private fun setupListeners() {
        joinButton.setOnClickListener { login() }
        logoutButton.setOnClickListener { logout() }
        callSelectedButton.setOnClickListener { inviteSelected() }
        searchInput.addTextChangedListenerSimple { renderTerminals() }
        micButton.setOnClickListener { toggleMic() }
        switchButton.setOnClickListener { switchCamera() }
        speakerButton.setOnClickListener { toggleSpeaker() }
        hangupButton.setOnClickListener { hangup() }
        acceptButton.setOnClickListener { acceptCall() }
        rejectButton.setOnClickListener { rejectCall() }
    }

    private fun EditText.addTextChangedListenerSimple(onChange: () -> Unit) {
        addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = onChange()
            override fun afterTextChanged(s: android.text.Editable?) {}
        })
    }

    /* ------------------------------ 登录 ------------------------------ */

    private fun login() {
        val server = serverInput.text.toString().trim()
        val name = nameInput.text.toString().trim()
        if (server.isEmpty()) {
            setupStatus.text = getString(R.string.server_invalid)
            serverInput.requestFocus()
            return
        }
        if (name.isEmpty()) {
            setupStatus.text = getString(R.string.name_invalid)
            nameInput.requestFocus()
            return
        }

        prefs.server = server
        prefs.name = name
        selfName = name

        if (!hasPermissions()) {
            ActivityCompat.requestPermissions(this, REQUIRED_PERMISSIONS, REQUEST_PERMISSIONS)
            return
        }
        connect(server)
    }

    private fun connect(server: String) {
        joinButton.isEnabled = false
        joinButton.text = getString(R.string.joining)
        setupStatus.text = getString(R.string.connecting_server)
        signaling?.close()
        val url = SignalingClient.normalizeUrl(server)
        signaling = SignalingClient(this).also { it.connect(url) }
    }

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
                put("type", "register")
                put("name", selfName)
                put("deviceId", prefs.deviceId)
                put("device", device)
            }
            signaling?.send(message)
        }
    }

    override fun onSignalingMessage(message: JSONObject) {
        runOnUiThread { handle(message) }
    }

    override fun onSignalingClosed(code: Int, reason: String) {
        runOnUiThread {
            joinButton.isEnabled = true
            joinButton.text = getString(R.string.join_room)
            if (inCall || callId != null) {
                toast(getString(R.string.state_disconnected))
                exitCall()
            }
        }
    }

    override fun onSignalingFailure(error: Throwable) {
        runOnUiThread {
            joinButton.isEnabled = true
            joinButton.text = getString(R.string.join_room)
            setupStatus.text = "无法连接服务器：${error.message ?: "网络错误"}"
        }
    }

    /* ------------------------------ 消息 ------------------------------ */

    private fun handle(message: JSONObject) {
        when (message.optString("type")) {
            "welcome" -> {
                iceServers = CallSession.parseIceServers(message.optJSONArray("iceServers"))
                val announcement = message.optString("announcement", "")
                if (announcement.isNotEmpty()) {
                    announcementText.text = announcement
                    announcementText.visibility = View.VISIBLE
                }
            }

            "registered" -> {
                val self = message.optJSONObject("self")
                selfId = self?.optString("id") ?: ""
                prefs.deviceId = selfId
                myName.text = self?.optString("name") ?: selfName
                myAvatar.text = initialOf(selfName)
                myState.text = getString(R.string.my_id, selfId)
                joinButton.isEnabled = true
                joinButton.text = getString(R.string.join_room)
                setupStatus.text = ""
                showDirectory()
            }

            "directory" -> {
                val list = message.optJSONArray("terminals") ?: JSONArray()
                val parsed = mutableListOf<Terminal>()
                for (i in 0 until list.length()) {
                    val item = list.optJSONObject(i) ?: continue
                    parsed.add(
                        Terminal(
                            id = item.optString("id"),
                            name = item.optString("name"),
                            platform = item.optString("platform", "android"),
                            isTv = item.optBoolean("isTv", false),
                            state = item.optString("state", "idle")
                        )
                    )
                }
                terminals = parsed
                selected.retainAll(parsed.map { it.id }.toSet())
                renderTerminals()
            }

            "call-created" -> {
                callId = message.optString("callId")
                peerNames.clear()
                parseMembers(message.optJSONArray("members"))
                enterCall(getString(R.string.waiting_peer))
            }

            "call-incoming" -> showIncoming(message)

            "call-joined" -> {
                callId = message.optString("callId")
                enterCall(getString(R.string.state_in_call))
                val members = message.optJSONArray("members") ?: JSONArray()
                for (i in 0 until members.length()) {
                    val member = members.optJSONObject(i) ?: continue
                    val id = member.optString("id")
                    val name = member.optString("name")
                    peerNames[id] = name
                    session?.createOffer(id, name) { sdp ->
                        if (sdp != null) {
                            sendJson(
                                JSONObject()
                                    .put("type", "offer")
                                    .put("to", id)
                                    .put("callId", callId)
                                    .put("sdp", sdp)
                            )
                        }
                    }
                }
                updateCallTitle()
            }

            "call-member-joined" -> {
                val member = message.optJSONObject("member")
                if (member != null) {
                    peerNames[member.optString("id")] = member.optString("name")
                    showHint("${member.optString("name")} 已加入")
                }
                updateCallTitle()
            }

            "call-member-left" -> {
                val id = message.optString("id")
                session?.closePeer(id)
                peerNames.remove(id)
                updateCallTitle()
                showHint("${message.optString("name", "对方")} 已离开")
            }

            "call-ended" -> {
                toast(getString(R.string.call_ended))
                exitCall()
            }

            "call-cancelled" -> {
                hideIncoming()
                val reason = message.optString("reason")
                if (reason == "timeout") getString(R.string.call_timeout) else getString(R.string.call_cancelled))
                if ((session?.peerCount ?: 0) == 0) exitCall()
            }

            "call-rejected" -> {
                toast("${message.optString("name", "对方")} ${getString(R.string.call_rejected)}")
                if ((session?.peerCount ?: 0) == 0) exitCall()
            }

            "call-timeout" -> toast("${message.optString("name", "对方")} ${getString(R.string.call_timeout)}")

            "call-failed" -> toast(getString(R.string.target_busy))

            "offer" -> {
                val from = message.optString("from")
                val name = peerNames[from] ?: "对方"
                prepareSession()
                session?.handleOffer(from, name, message.optString("sdp")) { answer ->
                    if (answer != null) {
                        sendJson(
                            JSONObject()
                                .put("type", "answer")
                                .put("to", from)
                                .put("callId", callId)
                                .put("sdp", answer)
                        )
                    }
                }
                updateCallTitle()
            }

            "answer" -> session?.handleAnswer(message.optString("from"), message.optString("sdp"))

            "ice" -> {
                val from = message.optString("from")
                val candidate = message.optJSONObject("candidate")
                if (candidate != null) session?.addIceCandidate(from, candidate)
            }

            "kicked" -> {
                toast(getString(R.string.kicked))
                logout()
            }

            "error" -> {
                val text = message.optString("message", "发生错误")
                toast(text)
                if (message.optString("code") == "busy") hideIncoming()
            }

            "pong" -> {}
        }
    }

    private fun parseMembers(array: JSONArray?) {
        if (array == null) return
        for (i in 0 until array.length()) {
            val member = array.optJSONObject(i) ?: continue
            peerNames[member.optString("id")] = member.optString("name")
        }
    }

    /* ------------------------------ 通讯录 ------------------------------ */

    private fun showLogin() {
        loginPanel.visibility = View.VISIBLE
        directoryPanel.visibility = View.GONE
        callPanel.visibility = View.GONE
        incomingPanel.visibility = View.GONE
    }

    private fun showDirectory() {
        loginPanel.visibility = View.GONE
        directoryPanel.visibility = View.VISIBLE
        callPanel.visibility = View.GONE
        incomingPanel.visibility = View.GONE
        renderTerminals()
    }

    private fun renderTerminals() {
        terminalList.removeAllViews()
        val keyword = searchInput.text.toString().trim().lowercase()
        val filtered = terminals.filter { keyword.isEmpty() || it.name.lowercase().contains(keyword) }
        listHead.text = "${getString(R.string.online_terminals)} ${terminals.size}"
        emptyHint.visibility = if (filtered.isEmpty()) View.VISIBLE else View.GONE
        callSelectedButton.isEnabled = selected.isNotEmpty()

        val inflater = LayoutInflater.from(this)
        for (terminal in filtered) {
            val item = inflater.inflate(R.layout.item_terminal, terminalList, false)
            val avatar = item.findViewById<TextView>(R.id.avatarText)
            val nameView = item.findViewById<TextView>(R.id.nameText)
            val tvTag = item.findViewById<TextView>(R.id.tvTag)
            val stateTag = item.findViewById<TextView>(R.id.stateTag)
            val subView = item.findViewById<TextView>(R.id.subText)
            val checkBox = item.findViewById<CheckBox>(R.id.selectBox)

            avatar.text = initialOf(terminal.name)
            nameView.text = terminal.name
            tvTag.visibility = if (terminal.isTv) View.VISIBLE else View.GONE
            stateTag.visibility = if (terminal.state != "idle") View.VISIBLE else View.GONE
            stateTag.text = if (terminal.state == "busy") "通话中" else "响铃中"
            subView.text = "${if (terminal.platform == "web") "网页" else "手机"} · ID ${terminal.id}"

            checkBox.isChecked = selected.contains(terminal.id)
            checkBox.setOnCheckedChangeListener { _, checked ->
                if (checked) selected.add(terminal.id) else selected.remove(terminal.id)
                callSelectedButton.isEnabled = selected.isNotEmpty()
            }

            item.setOnClickListener {
                if (terminal.state != "idle") {
                    toast(getString(R.string.target_busy))
                    return@setOnClickListener
                }
                if (selected.isNotEmpty()) {
                    if (selected.contains(terminal.id)) selected.remove(terminal.id) else selected.add(terminal.id)
                    renderTerminals()
                } else {
                    invite(listOf(terminal.id))
                }
            }
            terminalList.addView(item)
        }

        if (isTv && terminalList.childCount > 0) {
            terminalList.getChildAt(0).requestFocus()
        }
    }

    private fun inviteSelected() {
        if (selected.isEmpty()) {
            toast("请先勾选终端")
            return
        }
        invite(selected.toList())
    }

    private fun invite(targets: List<String>) {
        if (targets.isEmpty()) return
        sendJson(
            JSONObject()
                .put("type", "call-invite")
                .put("targets", JSONArray(targets))
                .put("video", true)
        )
        selected.clear()
        renderTerminals()
    }

    /* ------------------------------ 来电 ------------------------------ */

    private fun showIncoming(message: JSONObject) {
        val from = message.optJSONObject("from")
        incomingCallId = message.optString("callId")
        incomingName.text = from?.optString("name") ?: "对方"
        incomingAvatar.text = initialOf(from?.optString("name") ?: "V")
        incomingHint.text = getString(if (message.optBoolean("group")) R.string.incoming_group else R.string.incoming_hint)
        incomingPanel.visibility = View.VISIBLE
        if (isTv) acceptButton.requestFocus()
    }

    private fun hideIncoming() {
        incomingPanel.visibility = View.GONE
    }

    private fun acceptCall() {
        val id = incomingCallId ?: return
        sendJson(JSONObject().put("type", "call-accept").put("callId", id))
        hideIncoming()
        callId = id
        enterCall(getString(R.string.connecting_peer))
    }

    private fun rejectCall() {
        val id = incomingCallId ?: return
        sendJson(JSONObject().put("type", "call-reject").put("callId", id))
        incomingCallId = null
        hideIncoming()
    }

    /* ------------------------------ 通话 ------------------------------ */

    private fun prepareSession() {
        if (session != null) return
        val created = CallSession(this, app, localRenderer, remoteGrid)
        created.initRenderers()
        created.setIceServers(iceServers)
        created.setSpeakerphone(speakerOn)
        created.onIceCandidate = { peerId, candidate -> sendIce(peerId, candidate) }
        created.onPeerConnected = { runOnUiThread { updateCallTitle() } }
        created.onStats = { stats -> runOnUiThread { onStats(stats) } }
        created.onError = { message -> runOnUiThread { showHint(message) } }
        session = created

        if (!created.startLocalMedia()) {
            showHint(getString(R.string.no_camera))
        }
    }

    private fun enterCall(title: String) {
        prepareSession()
        loginPanel.visibility = View.GONE
        directoryPanel.visibility = View.GONE
        incomingPanel.visibility = View.GONE
        callPanel.visibility = View.VISIBLE
        callTitle.text = title
        localContainer.visibility = View.VISIBLE
        netStatus.text = getString(R.string.network_checking)
        if (!inCall) {
            inCall = true
            callStartAt = SystemClock.elapsedRealtime()
            callTimer.text = "00:00"
            handler.removeCallbacks(ticker)
            handler.post(ticker)
        }
        updateMicUi()
        updateSpeakerUi()
        if (isTv) hangupButton.requestFocus()
    }

    private fun updateCallTitle() {
        if (callPanel.visibility != View.VISIBLE) return
        val others = session?.peerCount ?: 0
        callTitle.text = if (others > 0) getString(R.string.call_members, others + 1) else getString(R.string.waiting_peer)
    }

    private fun exitCall() {
        callId = null
        inCall = false
        callStartAt = 0
        handler.removeCallbacks(ticker)
        session?.closeAll()
        updateMicUi()
        showDirectory()
        callTimer.text = "00:00"
        netStatus.text = getString(R.string.network_checking)
        callTitle.text = getString(R.string.call_title)
    }

    private fun hangup() {
        val id = callId
        if (id != null) sendJson(JSONObject().put("type", "call-leave").put("callId", id))
        exitCall()
    }

    private fun sendIce(peerId: String, candidate: IceCandidate) {
        val payload = JSONObject().apply {
            put("type", "ice")
            put("to", peerId)
            put("callId", callId)
            put("candidate", JSONObject().apply {
                put("sdpMid", candidate.sdpMid ?: "")
                put("sdpMLineIndex", candidate.sdpMLineIndex)
                put("candidate", candidate.sdp)
            })
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

    private fun onStats(stats: CallSession.StatsSnapshot) {
        val bad = stats.rttMs > 350 || (stats.bitrateKbps in 1..120)
        netStatus.text = getString(if (bad) R.string.network_bad else R.string.network_good)
        netStatus.setTextColor(Color.parseColor(if (bad) "#FFFF8A80" else "#B3FFFFFF"))

        sendJson(
            JSONObject()
                .put("type", "stats")
                .put("rtt", stats.rttMs)
                .put("bitrate", stats.bitrateKbps * 1000)
                .put("width", stats.width)
                .put("height", stats.height)
                .put("fps", stats.fps)
        )
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
        if (session?.switchCamera() == true) showHint("已切换摄像头")
        else showHint("当前设备不支持切换摄像头")
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

    private fun logout() {
        val id = callId
        if (id != null) sendJson(JSONObject().put("type", "call-leave").put("callId", id))
        callId = null
        inCall = false
        handler.removeCallbacks(ticker)
        signaling?.close()
        signaling = null
        session?.release()
        session = null
        peerNames.clear()
        terminals = emptyList()
        selected.clear()
        terminalList.removeAllViews()
        showLogin()
        if (isTv) joinButton.requestFocus()
    }

    /* ------------------------------ 工具 ------------------------------ */

    private fun hasPermissions(): Boolean = REQUIRED_PERMISSIONS.all {
        ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_PERMISSIONS) return
        if (!hasPermissions()) setupStatus.text = getString(R.string.permission_needed)
        connect(serverInput.text.toString().trim())
    }

    override fun onBackPressed() {
        when {
            incomingPanel.visibility == View.VISIBLE -> rejectCall()
            callPanel.visibility == View.VISIBLE -> hangup()
            directoryPanel.visibility == View.VISIBLE -> logout()
            else -> super.onBackPressed()
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

    private fun initialOf(name: String): String {
        val trimmed = name.trim()
        return if (trimmed.isEmpty()) "V" else trimmed.substring(0, 1).uppercase()
    }

    private fun versionName(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "2.0.0"
    } catch (t: Throwable) {
        "2.0.0"
    }

    private fun formatDuration(seconds: Long): String {
        val minutes = seconds / 60
        val remain = seconds % 60
        return String.format("%02d:%02d", minutes, remain)
    }

    private fun showHint(text: String) {
        if (text.isEmpty()) return
        hintOverlay.text = text
        hintOverlay.visibility = View.VISIBLE
        handler.removeCallbacks(hideHint)
        handler.postDelayed(hideHint, 2600)
    }

    private fun toast(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
    }

    private val hideHint = Runnable { hintOverlay.visibility = View.GONE }

    companion object {
        private const val REQUEST_PERMISSIONS = 1001
        private val REQUIRED_PERMISSIONS = arrayOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO
        )
    }
}
