plugins {
    `kotlin-dsl`
}

gradlePlugin {
    plugins {
        create("pluginsForCoolKids") {
            id = "rust"
            implementationClass = "RustPlugin"
        }
    }
}

repositories {
    google()
    // Avoid the release-asset redirect for the Gradle Kotlin DSL compiler.
    maven("https://maven-central.storage-download.googleapis.com/maven2/") {
        content { includeVersion("org.jetbrains.kotlin", "kotlin-compiler-embeddable", "2.3.21") }
    }
    mavenCentral()
}

dependencies {
    compileOnly(gradleApi())
    implementation("com.android.tools.build:gradle:9.3.1")
}

