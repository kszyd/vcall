package com.kszyd.vcall

import android.content.Context
import android.content.res.Configuration
import android.media.AudioManager
import android.os.SystemClock
import android.widget.GridLayout
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera1Enumerator
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RendererCommon
import org.webrtc.RtpParameters
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

/**
 * 多人 Mesh 会话：每个对端一条 PeerConnection 与一个画面。
 */
class CallSession(
    private val context: Context,
    private val app: VCallApp,
    private val localRenderer: SurfaceViewRenderer,
    private val grid: GridLayout
) {

    data class StatsSnapshot(
        val width: Int,
        val height: Int,
        val fps: Int,
        val rttMs: Int,
        val bitrateKbps: Int
    )

    private class PeerEntry(
        val id: String,
        val name: String,
        val pc: PeerConnection,
        val renderer: SurfaceViewRenderer
    )

    var onIceCandidate: ((peerId: String, candidate: IceCandidate) -> Unit)? = null
    var onPeerConnected: ((peerId: String) -> Unit)? = null
    var onStats: ((StatsSnapshot) -> Unit)? = null
    var onError: ((String) -> Unit)? = null

    private val peers = LinkedHashMap<String, PeerEntry>()
    private var videoCapturer: CameraVideoCapturer? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var surfaceHelper: SurfaceTextureHelper? = null

    private var iceServers: List<PeerConnection.IceServer> = emptyList()
    private var frontCamera = true
    private var hasVideo = false
    private var released = false
    private var lastBytes = 0L
    private var lastStatsAt = 0L

    private val audioManager: AudioManager
        get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    val peerCount: Int
        get() = peers.size

    /* ------------------------------ 初始化 ------------------------------ */

    fun initRenderers() {
        localRenderer.init(app.eglBase.eglBaseContext, null)
        localRenderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
        localRenderer.setEnableHardwareScaler(true)
        localRenderer.setMirror(true)
        localRenderer.setZOrderMediaOverlay(true)
    }

    fun setIceServers(servers: List<PeerConnection.IceServer>) {
        iceServers = servers
    }

    fun startLocalMedia(): Boolean {
        if (released) return false
        startVideoCapture()
        startAudio()
        return hasVideo
    }

    private fun startVideoCapture() {
        val capturer = createCapturer(frontCamera) ?: run {
            hasVideo = false
            return
        }
        try {
            surfaceHelper = SurfaceTextureHelper.create("VCallCapture", app.eglBase.eglBaseContext)
            val source = app.factory.createVideoSource(capturer.isScreencast)
            videoSource = source
            val track = app.factory.createVideoTrack("VCallVideo0", source)
            track.setEnabled(true)
            track.addSink(localRenderer)
            videoTrack = track
            capturer.initialize(surfaceHelper, context, source.capturerObserver)
            // 优先 1080p，WebRTC 会按设备实际支持选择最接近的采集格式
            capturer.startCapture(1920, 1080, 30)
            try {
                source.adaptOutputFormat(1920, 1080, 30)
            } catch (ignored: Throwable) {
            }
            videoCapturer = capturer
            hasVideo = true
        } catch (t: Throwable) {
            hasVideo = false
            onError?.invoke("摄像头启动失败：${t.message}")
            try {
                capturer.dispose()
            } catch (ignored: Throwable) {
            }
        }
    }

    private fun createCapturer(front: Boolean): CameraVideoCapturer? {
        try {
            val enumerator = Camera2Enumerator(context)
            val name = pickCamera(enumerator.deviceNames, front) { enumerator.isFrontFacing(it) }
            if (name != null) return enumerator.createCapturer(name, null)
        } catch (ignored: Throwable) {
        }
        try {
            val enumerator = Camera1Enumerator(true)
            val name = pickCamera(enumerator.deviceNames, front) { enumerator.isFrontFacing(it) }
            if (name != null) return enumerator.createCapturer(name, null)
        } catch (ignored: Throwable) {
        }
        return null
    }

    private fun pickCamera(names: Array<String>, front: Boolean, isFront: (String) -> Boolean): String? {
        if (names.isEmpty()) return null
        val preferred = names.firstOrNull { if (front) isFront(it) else !isFront(it) }
        return preferred ?: names.first()
    }

    private fun startAudio() {
        try {
            val source = app.factory.createAudioSource(MediaConstraints())
            audioSource = source
            audioTrack = app.factory.createAudioTrack("VCallAudio0", source)
        } catch (t: Throwable) {
            onError?.invoke("麦克风启动失败：${t.message}")
        }
    }

    /* ------------------------------ 对端管理 ------------------------------ */

    fun ensurePeer(peerId: String, name: String): PeerConnection {
        peers[peerId]?.let { return it.pc }

        val renderer = SurfaceViewRenderer(context)
        renderer.init(app.eglBase.eglBaseContext, null)
        renderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
        renderer.setEnableHardwareScaler(true)
        renderer.setMirror(false)

        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        val pc = app.factory.createPeerConnection(config, observerFor(peerId, name, renderer))
            ?: throw IllegalStateException("无法创建通话连接")

        val streamId = "vcall-stream"
        audioTrack?.let { pc.addTrack(it, listOf(streamId)) }
        videoTrack?.let { pc.addTrack(it, listOf(streamId)) }

        val entry = PeerEntry(peerId, name, pc, renderer)
        peers[peerId] = entry
        relayout()
        return pc
    }

    private fun observerFor(peerId: String, name: String, renderer: SurfaceViewRenderer): PeerConnection.Observer {
        return object : PeerConnection.Observer {
            override fun onSignalingChange(newState: PeerConnection.SignalingState?) {}

            override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState?) {
                if (newState == PeerConnection.IceConnectionState.CONNECTED) {
                    onPeerConnected?.invoke(peerId)
                }
            }

            override fun onIceConnectionReceivingChange(receiving: Boolean) {}

            override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState?) {}

            override fun onIceCandidate(candidate: IceCandidate?) {
                candidate?.let { onIceCandidate?.invoke(peerId, it) }
            }

            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}

            override fun onAddStream(stream: MediaStream?) {
                val track = stream?.videoTracks?.firstOrNull()
                if (track != null) track.addSink(renderer)
            }

            override fun onRemoveStream(stream: MediaStream?) {}

            override fun onDataChannel(dataChannel: DataChannel?) {}

            override fun onRenegotiationNeeded() {}

            override fun onAddTrack(receiver: RtpReceiver?, mediaStreams: Array<out MediaStream>?) {
                val track = receiver?.track()
                if (track is VideoTrack) track.addSink(renderer)
            }

            override fun onTrack(transceiver: RtpTransceiver?) {
                val track = transceiver?.receiver?.track()
                if (track is VideoTrack) track.addSink(renderer)
            }
        }
    }

    /**
     * 把视频码率上限提到 12 Mbps 并给出起始码率，配合 WebRTC 带宽自适应：
     * 带宽充足时按 1080p 高码率发送，不足时自动降码率/帧率。
     */
    private fun tuneSdp(sdp: String): String {
        val lines = sdp.split("\r\n").toMutableList()
        val index = lines.indexOfFirst { it.startsWith("m=video") }
        if (index >= 0 && !lines.getOrNull(index + 1).orEmpty().startsWith("b=")) {
            lines.add(index + 1, "b=AS:12000")
        }

        var inVideo = false
        for (i in lines.indices) {
            val line = lines[i]
            if (line.startsWith("m=video")) {
                inVideo = true
            } else if (line.startsWith("m=")) {
                inVideo = false
            } else if (inVideo && line.startsWith("a=fmtp:") && !line.contains("x-google-max-bitrate")) {
                lines[i] = line + ";x-google-max-bitrate=12000;x-google-min-bitrate=500;x-google-start-bitrate=3000"
            }
        }
        return lines.joinToString("\r\n")
    }

    /**
     * 画质优先：带宽不足时保持分辨率、先降帧率；同时放开编码码率上限。
     * 需在 SDP 协商完成后调用。
     */
    private fun applyVideoParams(pc: PeerConnection) {
        try {
            val sender = pc.senders.firstOrNull { it.track()?.kind() == "video" } ?: return
            val params = sender.parameters ?: return
            params.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
            params.encodings?.forEach { encoding ->
                encoding.maxBitrateBps = 12_000_000
                encoding.minBitrateBps = 500_000
                encoding.maxFramerate = 30
            }
            sender.setParameters(params)
        } catch (ignored: Throwable) {
        }
    }

    fun createOffer(peerId: String, name: String, onSdp: (String?) -> Unit) {
        val pc = try {
            ensurePeer(peerId, name)
        } catch (t: Throwable) {
            onError?.invoke(t.message ?: "创建连接失败")
            onSdp(null)
            return
        }
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "true"))
        }
        pc.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(sdp: SessionDescription?) {
                if (sdp == null) return onSdp(null)
                val tuned = SessionDescription(sdp.type, tuneSdp(sdp.description))
                pc.setLocalDescription(object : SimpleSdpObserver() {
                    override fun onSetSuccess() {
                        applyVideoParams(pc)
                        onSdp(tuned.description)
                    }

                    override fun onSetFailure(error: String?) = onSdp(null)
                }, tuned)
            }

            override fun onCreateFailure(error: String?) = onSdp(null)
        }, constraints)
    }

    fun handleOffer(peerId: String, name: String, sdp: String, onAnswer: (String?) -> Unit) {
        val pc = try {
            ensurePeer(peerId, name)
        } catch (t: Throwable) {
            onError?.invoke(t.message ?: "创建连接失败")
            onAnswer(null)
            return
        }
        pc.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() {
                pc.createAnswer(object : SimpleSdpObserver() {
                    override fun onCreateSuccess(answer: SessionDescription?) {
                        if (answer == null) return onAnswer(null)
                        val tuned = SessionDescription(answer.type, tuneSdp(answer.description))
                        pc.setLocalDescription(object : SimpleSdpObserver() {
                            override fun onSetSuccess() {
                                applyVideoParams(pc)
                                onAnswer(tuned.description)
                            }

                            override fun onSetFailure(error: String?) = onAnswer(null)
                        }, tuned)
                    }

                    override fun onCreateFailure(error: String?) = onAnswer(null)
                }, MediaConstraints())
            }

            override fun onSetFailure(error: String?) {
                onError?.invoke("处理来电失败：$error")
                onAnswer(null)
            }
        }, SessionDescription(SessionDescription.Type.OFFER, sdp))
    }

    fun handleAnswer(peerId: String, sdp: String) {
        val entry = peers[peerId] ?: return
        entry.pc.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetFailure(error: String?) {
                onError?.invoke("设置应答失败：$error")
            }
        }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }

    fun addIceCandidate(peerId: String, candidateJson: JSONObject) {
        val entry = peers[peerId] ?: return
        val candidate = IceCandidate(
            candidateJson.optString("sdpMid"),
            candidateJson.optInt("sdpMLineIndex", 0),
            candidateJson.optString("candidate")
        )
        if (candidate.sdpMid.isNullOrEmpty() && candidate.sdp.isEmpty()) return
        try {
            entry.pc.addIceCandidate(candidate)
        } catch (ignored: Throwable) {
        }
    }

    fun closePeer(peerId: String) {
        val entry = peers.remove(peerId) ?: return
        try {
            entry.pc.close()
            entry.pc.dispose()
        } catch (ignored: Throwable) {
        }
        try {
            entry.renderer.release()
        } catch (ignored: Throwable) {
        }
        grid.removeView(entry.renderer)
        relayout()
    }

    fun closeAll() {
        for (id in peers.keys.toList()) closePeer(id)
    }

    private fun relayout() {
        val entries = peers.values.toList()
        val count = entries.size
        val portrait = context.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
        val cols: Int
        val rows: Int
        when {
            count <= 1 -> {
                cols = 1
                rows = 1
            }
            count == 2 -> {
                cols = if (portrait) 1 else 2
                rows = if (portrait) 2 else 1
            }
            count <= 4 -> {
                cols = 2
                rows = 2
            }
            else -> {
                cols = 3
                rows = 2
            }
        }

        grid.removeAllViews()
        grid.columnCount = cols
        grid.rowCount = rows
        entries.forEachIndexed { index, entry ->
            val row = if (cols == 1) index else index / cols
            val col = if (cols == 1) 0 else index % cols
            val params = GridLayout.LayoutParams()
            params.width = 0
            params.height = 0
            params.rowSpec = GridLayout.spec(row, 1f)
            params.columnSpec = GridLayout.spec(col, 1f)
            params.setMargins(2, 2, 2, 2)
            grid.addView(entry.renderer, params)
        }
    }

    /* ------------------------------ 控制 ------------------------------ */

    fun setMicrophoneEnabled(enabled: Boolean) {
        audioTrack?.setEnabled(enabled)
    }

    fun switchCamera(): Boolean {
        val capturer = videoCapturer ?: return false
        return try {
            capturer.switchCamera(null)
            frontCamera = !frontCamera
            localRenderer.setMirror(frontCamera)
            true
        } catch (t: Throwable) {
            false
        }
    }

    fun setSpeakerphone(on: Boolean) {
        try {
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            audioManager.isSpeakerphoneOn = on
        } catch (ignored: Throwable) {
        }
    }

    fun restoreAudio() {
        try {
            audioManager.isSpeakerphoneOn = false
            audioManager.mode = AudioManager.MODE_NORMAL
        } catch (ignored: Throwable) {
        }
    }

    fun pollStats() {
        val entry = peers.values.firstOrNull() ?: return
        entry.pc.getStats { report ->
            var width = 0
            var height = 0
            var fps = 0
            var rtt = 0
            var bytes = 0L
            for (stats in report.statsMap.values) {
                when (stats.type) {
                    "inbound-rtp" -> {
                        if ((stats.members["kind"] as? String) == "video" || stats.members.containsKey("frameWidth")) {
                            width = (stats.members["frameWidth"] as? Number)?.toInt() ?: width
                            height = (stats.members["frameHeight"] as? Number)?.toInt() ?: height
                            fps = (stats.members["framesPerSecond"] as? Number)?.toInt() ?: fps
                            bytes = (stats.members["bytesReceived"] as? Number)?.toLong() ?: bytes
                        }
                    }
                    "candidate-pair" -> {
                        val state = stats.members["state"] as? String
                        val selected = stats.members["selected"] as? Boolean
                        if (state == "succeeded" || selected == true) {
                            val value = (stats.members["currentRoundTripTime"] as? Number)?.toDouble() ?: 0.0
                            if (value > 0) rtt = (value * 1000).toInt()
                        }
                    }
                }
            }
            val now = SystemClock.elapsedRealtime()
            var kbps = 0
            if (lastStatsAt > 0 && now > lastStatsAt && bytes >= lastBytes) {
                kbps = (((bytes - lastBytes) * 8) / (now - lastStatsAt)).toInt()
            }
            lastBytes = bytes
            lastStatsAt = now
            if (width > 0 || rtt > 0 || kbps > 0) {
                onStats?.invoke(StatsSnapshot(width, height, fps, rtt, kbps))
            }
        }
    }

    /* ------------------------------ 释放 ------------------------------ */

    fun release() {
        if (released) return
        released = true
        closeAll()
        try {
            videoCapturer?.stopCapture()
        } catch (ignored: Throwable) {
        }
        try {
            videoCapturer?.dispose()
        } catch (ignored: Throwable) {
        }
        videoCapturer = null
        try {
            videoTrack?.removeSink(localRenderer)
            videoTrack?.dispose()
        } catch (ignored: Throwable) {
        }
        videoTrack = null
        try {
            videoSource?.dispose()
        } catch (ignored: Throwable) {
        }
        videoSource = null
        try {
            surfaceHelper?.dispose()
        } catch (ignored: Throwable) {
        }
        surfaceHelper = null
        try {
            audioTrack?.dispose()
        } catch (ignored: Throwable) {
        }
        audioTrack = null
        try {
            audioSource?.dispose()
        } catch (ignored: Throwable) {
        }
        audioSource = null
        try {
            localRenderer.release()
        } catch (ignored: Throwable) {
        }
        restoreAudio()
    }

    open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription?) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) {}
        override fun onSetFailure(error: String?) {}
    }

    companion object {
        fun parseIceServers(array: JSONArray?): List<PeerConnection.IceServer> {
            val result = mutableListOf<PeerConnection.IceServer>()
            if (array == null) return result
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                val urlsValue = item.opt("urls")
                val urls = mutableListOf<String>()
                when (urlsValue) {
                    is JSONArray -> for (i in 0 until urlsValue.length()) {
                        urlsValue.optString(i).takeIf { it.isNotEmpty() }?.let { urls.add(it) }
                    }
                    is String -> if (urlsValue.isNotEmpty()) urls.add(urlsValue)
                }
                val username = item.optString("username", "")
                val credential = item.optString("credential", "")
                for (url in urls) {
                    val builder = PeerConnection.IceServer.builder(url)
                    if (username.isNotEmpty()) builder.setUsername(username)
                    if (credential.isNotEmpty()) builder.setPassword(credential)
                    result.add(builder.createIceServer())
                }
            }
            return result
        }
    }
}
