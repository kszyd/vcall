package com.kszyd.vcall

import android.app.Application
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory

/**
 * 全局持有 EglBase 与 PeerConnectionFactory，避免多次初始化导致崩溃。
 */
class VCallApp : Application() {

    lateinit var eglBase: EglBase
        private set

    lateinit var factory: PeerConnectionFactory
        private set

    override fun onCreate() {
        super.onCreate()
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(this)
                .setEnableInternalTracer(false)
                .setFieldTrials("")
                .createInitializationOptions()
        )
        eglBase = EglBase.create()
        val encoderFactory = DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true)
        val decoderFactory = DefaultVideoDecoderFactory(eglBase.eglBaseContext)
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .setOptions(PeerConnectionFactory.Options())
            .createPeerConnectionFactory()
    }
}
