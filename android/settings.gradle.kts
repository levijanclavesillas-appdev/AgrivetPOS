// Chachi Pharmacy POS for Android — TASK-049, a standalone store on the tablet.
// Build instructions: android/README.md.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "ChachiPharmacyPOS"
include(":app")
