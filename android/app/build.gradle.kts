// The Android app — TASK-049. A WebView over the same server and renderer the Windows
// build runs, with Node itself inside the APK (nodejs-mobile) so the tablet is the whole
// store. Nothing in src/ or public/ is copied by hand: the build stages them.

import java.io.FileOutputStream
import java.net.URI
import java.security.MessageDigest
import java.util.Properties
import java.util.zip.ZipFile

plugins {
    id("com.android.application")
}

/** The repository root: android/ sits inside it, beside src/, public/ and node_modules/. */
val repoRoot: File = rootDir.parentFile

// ── The Node runtime for Android ────────────────────────────────────────────────
// nodejs-mobile's build of Node 18.20.4, one libnode.so per ABI plus Node's headers.
// Downloaded once into app/libnode/ (git-ignored) and checked against its hash, so a
// build never runs against a runtime nobody reviewed.
val libnodeVersion = "18.20.4"
val libnodeSha256 = "bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af"
val libnodeUrl = "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/" +
    "v$libnodeVersion/nodejs-mobile-v$libnodeVersion-android.zip"
val libnodeDir: File = file("libnode")

fun sha256Of(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buffer = ByteArray(1 shl 16)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

/**
 * Fetched while Gradle configures the project, not in a task: Android Studio runs CMake
 * during sync, before any task, and CMake needs node.h and libnode.so to exist by then.
 * It happens once — after that the folder is there and this returns at the first line.
 */
fun ensureLibnode() {
    if (File(libnodeDir, "bin/arm64-v8a/libnode.so").exists() && File(libnodeDir, "include/node/node.h").exists()) return
    val zip = layout.buildDirectory.file("downloads/nodejs-mobile-v$libnodeVersion-android.zip").get().asFile
    if (!zip.exists() || sha256Of(zip) != libnodeSha256) {
        zip.parentFile.mkdirs()
        logger.lifecycle("Downloading the Node runtime for Android: $libnodeUrl")
        URI(libnodeUrl).toURL().openStream().use { input -> FileOutputStream(zip).use { input.copyTo(it) } }
    }
    val actual = sha256Of(zip)
    if (actual != libnodeSha256) {
        zip.delete()
        throw GradleException("${zip.name}: SHA-256 is $actual, expected $libnodeSha256. Refusing to build with it.")
    }
    ZipFile(zip).use { archive ->
        for (entry in archive.entries()) {
            val out = File(libnodeDir, entry.name).canonicalFile
            require(out.path.startsWith(libnodeDir.canonicalPath)) { "Unsafe path in ${zip.name}: ${entry.name}" }
            if (entry.isDirectory) { out.mkdirs(); continue }
            out.parentFile.mkdirs()
            archive.getInputStream(entry).use { input -> FileOutputStream(out).use { input.copyTo(it) } }
        }
    }
}

ensureLibnode()

// ── The server and the renderer, as the APK's assets ───────────────────────────
// src/ (without its tests), public/, the production node_modules and android/node's
// entry point — see scripts/stage-node-project.js. Needs Node and an `npm install` in
// the repository root, which a developer of this project already has.
val nodeAssets = layout.buildDirectory.dir("generated/nodejs-assets")

val stageNodeProject = tasks.register<Exec>("stageNodeProject") {
    workingDir = rootDir
    commandLine("node", "scripts/stage-node-project.js", nodeAssets.get().asFile.absolutePath)
    inputs.dir(File(repoRoot, "src"))
    inputs.dir(File(repoRoot, "public"))
    inputs.dir(File(rootDir, "node"))
    inputs.file(File(rootDir, "scripts/stage-node-project.js"))
    inputs.file(File(repoRoot, "package.json"))
    inputs.file(File(repoRoot, "package-lock.json"))
    outputs.dir(nodeAssets)
}

/** versionName from package.json, so the tablet and the Windows build say the same thing. */
val appVersion: String = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(File(repoRoot, "package.json").readText())?.groupValues?.get(1) ?: "0.0.0"

android {
    namespace = "store.chachisoftware.pos"
    compileSdk = 36
    ndkVersion = "28.2.13676358"

    defaultConfig {
        // Play Console registered the app as store.chachisoftware.pharmacypos, and a Play
        // package name never changes. The Java package and namespace stay .pos: the native
        // entry points are named after them, and Play never sees them.
        applicationId = "store.chachisoftware.pharmacypos"
        // Android 8.0. Every tablet sold as a POS in the last several years is newer.
        minSdk = 26
        targetSdk = 36
        versionCode = 11
        versionName = appVersion

        ndk {
            // arm64-v8a is every current tablet; x86_64 is the emulator; armeabi-v7a is
            // the 32-bit hardware a budget Android 8–10 tablet still ships with.
            //
            // **All three, because an ABI that is not here is not a device that installs
            // late — it is a device that never sees the app at all.** Google Play filters
            // its listing by the native platforms in the upload, so a 32-bit tablet is
            // shown "item not found" rather than an incompatibility it could act on. That
            // is indistinguishable, from the tablet, from never having published.
            //
            // It costs no device anything. `bundleRelease` (README.md) splits the bundle
            // per ABI, so a tablet downloads its own libnode.so (~57–63 MB) and not the
            // others. A plain `assembleRelease` APK does carry all three, which is a
            // reason to ship the bundle to Play rather than the APK.
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
        externalNativeBuild {
            cmake {
                arguments += listOf(
                    "-DANDROID_STL=c++_shared",
                    "-DLIBNODE_DIR=${libnodeDir.absolutePath.replace("\\", "/")}",
                    "-DBETTER_SQLITE3_DIR=${File(repoRoot, "node_modules/better-sqlite3").absolutePath.replace("\\", "/")}",
                )
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets {
        getByName("main") {
            // libnode.so is prebuilt, so it is packaged as a jniLib rather than built.
            jniLibs.directories.add("libnode/bin")
            assets.directories.add(nodeAssets.get().asFile.absolutePath)
        }
    }

    packaging {
        jniLibs {
            // Extracted to nativeLibraryDir on install, because Node loads the SQLite
            // addon by path (AGRIVET_SQLITE_ADDON) and a path needs a file.
            useLegacyPackaging = true
        }
    }

    // A release build is signed with the store's own key when android/keystore.properties
    // exists (see README.md); otherwise only the debug build is installable.
    val keystoreFile = File(rootDir, "keystore.properties")
    if (keystoreFile.exists()) {
        val props = Properties().apply { keystoreFile.inputStream().use { load(it) } }
        signingConfigs {
            create("release") {
                storeFile = File(rootDir, props.getProperty("storeFile"))
                storePassword = props.getProperty("storePassword")
                keyAlias = props.getProperty("keyAlias")
                keyPassword = props.getProperty("keyPassword")
            }
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("release")
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// TASK-069: Google's code scanner. Play services shows its own camera screen and returns only
// the code read, so the app needs no camera of its own on a phone that has Play services.
dependencies {
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}

tasks.named("preBuild") {
    dependsOn(stageNodeProject)
}
