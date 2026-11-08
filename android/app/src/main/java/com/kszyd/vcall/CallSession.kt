package com.kszyd.vcall

import android.content.Context
import android.media.AudioManager
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera1Enumerator
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.RendererCommon
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

/**
 * 单路 1:1 WebRTC 会话封装：采集、推流、拉流与统计。
 */
class CallSession(
    private val context: Context,
    private val app: VCallApp,
    private val localRenderer: SurfaceViewRenderer,
    private val remoteRenderer: SurfaceViewRenderer
) {

    data class StatsSnapshot(
        val width: Int,
        val height: Int,
        val fps: Int,
        val rttMs: Int,
        val bitrateKbps: Int
    )

    var onIceCandidate: ((IceCandidate) -> Unit)? = null
    var onRemoteStream: (() -> Unit)? = null
    var onConnectionState: ((String) -> Unit)? = null
    var onStats: ((StatsSnapshot) -> Unit)? = null
    var onError: ((String) -> Unit)? = null

    private var peerConnection: PeerConnection? = null
    private var videoCapturer: CameraVideoCapturer? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private var surfaceHelper: SurfaceTextureHelper? = null

    private val pendingCandidates = mutableListOf<IceCandidate>()
    private var iceServers: List<PeerConnection.IceServer> = emptyList()

    private var frontCamera = true
    private var hasVideo = false
    private var released = false

    private var lastBytes = 0L
    private var lastStatsAt = 0L

    private val audioManager: AudioManager
        get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    /* ------------------------------ 初始化 ------------------------------ */

    fun initRenderers() {
        localRenderer.init(app.eglBase.eglBaseContext, null)
        localRenderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
        localRenderer.setEnableHardwareScaler(true)
        localRenderer.setMirror(true)
        localRenderer.setZOrderMediaOverlay(true)

        remoteRenderer.init(app.eglBase.eglBaseContext, null)
        remoteRenderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
        remoteRenderer.setEnableHardwareScaler(true)
        remoteRenderer.setMirror(false)
    }

    fun setIceServers(servers: List<PeerConnection.IceServer>) {
        iceServers = servers
    }

    /**
     * 启动本地采集。返回是否成功启动了摄像头。
     */
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
            capturer.startCapture(1280, 720, 30)
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
            // 部分老设备 Camera2 不可用，回退到 Camera1
        }
        try {
            val enumerator = Camera1Enumerator(true)
            val name = pickCamera(enumerator.deviceNames, front) { enumerator.isFrontFacing(it) }
            if (name != null) return enumerator.createCapturer(name, null)
        } catch (ignored: Throwable) {
        }
        return null
    }

    private fun pickCamera(
        names: Array<String>,
        front: Boolean,
        isFront: (String) -> Boolean
    ): String? {
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

    /* ------------------------------ 连接管理 ------------------------------ */

    fun createPeerConnection() {
        closePeerConnection()
        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            iceTransportsType = PeerConnection.IceTransportsType.ALL
        }
        val pc = app.factory.createPeerConnection(config, observer)
        if (pc == null) {
            onError?.invoke("无法创建通话连接")
            return
        }
        peerConnection = pc
        val streamId = "vcall-stream"
        audioTrack?.let { pc.addTrack(it, listOf(streamId)) }
        videoTrack?.let { pc.addTrack(it, listOf(streamId)) }
    }

    fun createOffer(onSdp: (String?) -> Unit) {
        val pc = peerConnection ?: return onSdp(null)
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "true"))
        }
        pc.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(sdp: SessionDescription?) {
                if (sdp == null) return onSdp(null)
                pc.setLocalDescription(object : SimpleSdpObserver() {
                    override fun onSetSuccess() = onSdp(sdp.description)
                    override fun onSetFailure(error: String?) = onSdp(null)
                }, sdp)
            }

            override fun onCreateFailure(error: String?) = onSdp(null)
        }, constraints)
    }

    fun handleOffer(sdp: String, onAnswer: (String?) -> Unit) {
        val pc = peerConnection ?: return onAnswer(null)
        pc.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() {
                pc.createAnswer(object : SimpleSdpObserver() {
                    override fun onCreateSuccess(answer: SessionDescription?) {
                        if (answer == null) return onAnswer(null)
                        pc.setLocalDescription(object : SimpleSdpObserver() {
                            override fun onSetSuccess() = onAnswer(answer.description)
                            override fun onSetFailure(error: String?) = onAnswer(null)
                        }, answer)
                    }

                    override fun onCreateFailure(error: String?) = onAnswer(null)
                }, MediaConstraints())
                flushPendingCandidates()
            }

            override fun onSetFailure(error: String?) {
                onError?.invoke("处理来电失败：$error")
                onAnswer(null)
            }
        }, SessionDescription(SessionDescription.Type.OFFER, sdp))
    }

    fun handleAnswer(sdp: String) {
        val pc = peerConnection ?: return
        pc.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() = flushPendingCandidates()
            override fun onSetFailure(error: String?) = onError?.invoke("设置应答失败：$error")
        }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
    }

    fun addIceCandidate(candidateJson: JSONObject) {
        val candidate = IceCandidate(
            candidateJson.optString("sdpMid"),
            candidateJson.optInt("sdpMLineIndex", 0),
            candidateJson.optString("candidate")
        )
        val pc = peerConnection ?: return
        if (candidate.sdpMid.isNullOrEmpty() && candidate.sdp.isEmpty()) return
        if (pc.remoteDescription == null) {
            pendingCandidates.add(candidate)
        } else {
            pc.addIceCandidate(candidate)
        }
    }

    private fun flushPendingCandidates() {
        val pc = peerConnection ?: return
        val iterator = pendingCandidates.iterator()
        while (iterator.hasNext()) {
            val candidate = iterator.next()
            pc.addIceCandidate(candidate)
            iterator.remove()
        }
    }

    fun closePeerConnection() {
        pendingCandidates.clear()
        try {
            peerConnection?.close()
        } catch (ignored: Throwable) {
        }
        try {
            peerConnection?.dispose()
        } catch (ignored: Throwable) {
        }
        peerConnection = null
        try {
            remoteRenderer.clearImage()
        } catch (ignored: Throwable) {
        }
        lastBytes = 0
        lastStatsAt = 0
    }

    /* ------------------------------ 控制 ------------------------------ */

    fun setMicrophoneEnabled(enabled: Boolean) {
        audioTrack?.setEnabled(enabled)
    }

    fun setVideoEnabled(enabled: Boolean) {
        videoTrack?.setEnabled(enabled)
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

    /* ------------------------------ 统计 ------------------------------ */

    fun pollStats() {
        val pc = peerConnection ?: return
        pc.getStats { report ->
            var width = 0
            var height = 0
            var fps = 0
            var rtt = 0
            var bytes = 0L
            for (stats in report.statsMap.values) {
                when (stats.type) {
                    "inbound-rtp" -> {
                        if ((stats.members["kind"] as? String) == "video" ||
                            stats.members.containsKey("frameWidth")
                        ) {
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
        closePeerConnection()

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
        } catch (ignored: Throwable) {
        }
        try {
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
        try {
            remoteRenderer.release()
        } catch (ignored: Throwable) {
        }
        restoreAudio()
    }

    /* ------------------------------ 回调 ------------------------------ */

    private val observer = object : PeerConnection.Observer {
        override fun onSignalingChange(newState: PeerConnection.SignalingState?) {
        }

        override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState?) {
            when (newState) {
                PeerConnection.IceConnectionState.CONNECTED -> onConnectionState?.invoke("connected")
                PeerConnection.IceConnectionState.DISCONNECTED -> onConnectionState?.invoke("disconnected")
                PeerConnection.IceConnectionState.FAILED -> onConnectionState?.invoke("failed")
                PeerConnection.IceConnectionState.CLOSED -> onConnectionState?.invoke("closed")
                else -> {
                }
            }
        }

        override fun onIceConnectionReceivingChange(receiving: Boolean) {
        }

        override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState?) {
        }

        override fun onIceCandidate(candidate: IceCandidate?) {
            candidate?.let { onIceCandidate?.invoke(it) }
        }

        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {
        }

        override fun onAddStream(stream: MediaStream?) {
            val track = stream?.videoTracks?.firstOrNull()
            if (track != null) {
                track.addSink(remoteRenderer)
                onRemoteStream?.invoke()
            }
        }

        override fun onRemoveStream(stream: MediaStream?) {
        }

        override fun onDataChannel(dataChannel: DataChannel?) {
        }

        override fun onRenegotiationNeeded() {
        }

        override fun onAddTrack(receiver: RtpReceiver?, mediaStreams: Array<out MediaStream>?) {
            val track = receiver?.track()
            if (track is VideoTrack) {
                track.addSink(remoteRenderer)
                onRemoteStream?.invoke()
            }
        }

        override fun onTrack(transceiver: RtpTransceiver?) {
            val track = transceiver?.receiver?.track()
            if (track is VideoTrack) {
                track.addSink(remoteRenderer)
                onRemoteStream?.invoke()
            }
        }
    }

    open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription?) {
        }

        override fun onSetSuccess() {
        }

        override fun onCreateFailure(error: String?) {
        }

        override fun onSetFailure(error: String?) {
        }
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

        fun buildIceServers(raw: JSONArray?): List<PeerConnection.IceServer> = parseIceServers(raw)
    }
}
