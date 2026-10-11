plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Passed by scripts/build-drivers.sh. The version is never written into native/ files:
// that would change sourceHash, which the version is derived from.
val rneVersion = (findProperty("rneVersion") as String?) ?: "0.0.0-dev"
val rneVersionCode = ((findProperty("rneVersionCode") as String?) ?: "1").toInt()

android {
    namespace = "dev.rneye.server"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.rneye.server"
        minSdk = 24
        targetSdk = 36
        versionCode = rneVersionCode
        versionName = rneVersion
        testApplicationId = "dev.rneye.server.test"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "RNE_VERSION", "\"$rneVersion\"")
        manifestPlaceholders["rneVersion"] = rneVersion
        manifestPlaceholders["rneVersionCode"] = rneVersionCode.toString()
    }
    signingConfigs {
        getByName("debug") {
            storeFile = rootProject.file("rneye.keystore")
            storePassword = "rneye-public"
            keyAlias = "rneye"
            keyPassword = "rneye-public"
        }
    }
    buildTypes { getByName("debug") { signingConfig = signingConfigs.getByName("debug") } }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint { abortOnError = false; checkReleaseBuilds = false }
    // AGP gives the test APK no versionName/versionCode, and it rejects manifest placeholders
    // in those attributes. scripts/build-drivers.sh therefore generates a test manifest with
    // literal values outside native/ (in .cache/drivers) and passes its path here.
    (findProperty("rneTestManifest") as String?)?.let { sourceSets.getByName("androidTest").manifest.srcFile(it) }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    // The app APK is Java only and has no dependencies. Everything below is test-APK only.
    androidTestImplementation("org.jetbrains.kotlin:kotlin-stdlib:2.2.10")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
