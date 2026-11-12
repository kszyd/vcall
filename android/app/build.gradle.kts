plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.kszyd.vcall"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.kszyd.vcall"
        minSdk = 23
        targetSdk = 34
        versionCode = 18
        versionName = "2.10.1"

        // 覆盖绝大多数手机与电视盒子；x86 模拟器如需调试可自行添加
        // -Pcompat=1 构建 32 位兼容包（仅 armeabi-v7a，so 解压安装），用于老旧盒子
        ndk {
            val compat = (project.findProperty("compat") as String?) == "1"
            abiFilters += if (compat) listOf("armeabi-v7a") else listOf("armeabi-v7a", "arm64-v8a")
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // 使用 debug 签名，保证 APK 可直接安装并覆盖升级
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = "1.8"
    }

    packaging {
        resources {
            excludes += setOf(
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE",
                "META-INF/LICENSE.txt",
                "META-INF/NOTICE",
                "META-INF/NOTICE.txt",
                "META-INF/*.kotlin_module"
            )
        }
        jniLibs {
            useLegacyPackaging = (project.findProperty("compat") as String?) == "1"
        }
    }

    buildFeatures {
        viewBinding = false
        buildConfig = true
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.webrtc.android)
    implementation(libs.okhttp)
}
