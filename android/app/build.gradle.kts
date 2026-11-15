plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Gradle's Kotlin DSL exposes `java` as the JavaPluginExtension, which shadows
// the java package — so java.util.Properties() does not resolve. Import it.
import java.util.Properties

// Signing credentials live outside the build file so the repository can be
// shared without the key. Absent file => debug-only builds, which is the
// correct default for anyone who is not the release owner.
val keystoreProps = Properties()
run {
    val f = rootProject.file("keystore.properties")
    // `load(it)` inside `apply` resolves against the Properties receiver only
    // by luck; naming it explicitly avoids the Kotlin scoping ambiguity.
    if (f.exists()) f.inputStream().use { stream -> keystoreProps.load(stream) }
}

android {
    namespace = "com.lionel.parley"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.lionel.parley"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // arm64 only: the models need a 64-bit address space, and every device
        // that can hold a 2 GB server process is arm64 anyway.
        ndk { abiFilters += "arm64-v8a" }
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Shrinking is off deliberately for now: R8 on a Kotlin+Compose
            // project this small saves ~2 MB, and a rule that strips a
            // reflection-used class costs a day to diagnose.
            if (keystoreProps.isNotEmpty()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }

    /**
     * The engine is a *binary*, not a library.
     *
     * Android 10+ forbids exec() from app storage, so shipping llama-server in
     * assets and running it does not work. Files under jniLibs are extracted
     * to nativeLibraryDir, which is executable — that is the supported way to
     * ship a native executable in an APK. Hence `useLegacyPackaging = true`:
     * without it the libs stay compressed inside the APK and are never written
     * to disk.
     */
    packaging {
        jniLibs {
            useLegacyPackaging = true
            keepDebugSymbols += "**/*.so"
        }
    }
    sourceSets["main"].jniLibs.srcDirs("src/main/jniLibs")
}

dependencies {
    val compose = "1.7.5"
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.ui:ui:$compose")
    implementation("androidx.compose.material3:material3:1.3.1")
    implementation("androidx.compose.material:material-icons-extended:$compose")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
