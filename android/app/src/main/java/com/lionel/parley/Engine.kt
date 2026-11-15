package com.lionel.parley

import android.content.Context
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Owns the llama-server child processes.
 *
 * Two servers, not one, for the same reason the desktop build uses two: the
 * Audio model is a much better recogniser than the Omni model, but Omni is the
 * better translator. Collapsing them into one was measured and withdrawn
 * (Omni returned "7465분" for "칠 시 사십오 분" on 5 of 5 runs).
 *
 * The binary ships as `libllama-server.so` inside jniLibs. Android 10+ forbids
 * exec() from the app's data directory, but nativeLibraryDir is exempt — that
 * is why the executable is disguised as a library rather than stored in assets.
 */
class Engine(private val ctx: Context) {

    data class Slot(val name: String, val port: Int, val model: File, val mmproj: File?)

    private val procs = mutableMapOf<String, Process>()

    /**
     * Servers already listening on their port when we booted.
     *
     * A force-stop of the app does not reliably take its child processes with
     * it, so the ports can still be bound by an engine from a previous install.
     * Spawning another one then fails instantly on "address in use", the new
     * process dies, `isRunning` reports false forever, and the UI stays disabled
     * with no error anywhere — which reads to the user as "the app does nothing".
     */
    private val adopted = mutableSetOf<String>()

    /** Where the extracted, executable copy of the engine lives. */
    private fun serverBin(): File = File(ctx.applicationInfo.nativeLibraryDir, "libllama-server.so")

    /** Model files live app-private: 2.2 GB is too large for assets. */
    fun modelsDir(): File = File(ctx.filesDir, "models").apply { mkdirs() }

    val audioModel: File get() = File(modelsDir(), "LFM3-Audio-2B-Q4_K_M.gguf")
    val audioMmproj: File get() = File(modelsDir(), "mmproj-LFM3-Audio-2B-Q4_K_M.gguf")
    val textModel: File get() = File(modelsDir(), "LFM3-Omni-2B-Q4_K_M.gguf")

    fun isReady(): Boolean =
        audioModel.length() > 1000L * 1000 * 1000 * 0.98 &&
        textModel.length() > 1000L * 1000 * 1000 * 0.98 &&
        audioMmproj.exists()

    fun isRunning(name: String): Boolean =
        name in adopted || procs[name]?.isAlive == true

    /**
     * Start one engine. `-ngl 0` keeps it on the CPU: phones have no CUDA, and
     * Vulkan on a mid-range Adreno is slower than plain NEON for this size of
     * model. Context is 4096 rather than the desktop's 8192 — every KB of KV
     * cache comes out of the same RAM the model needs.
     */
    fun start(slot: Slot, threads: Int = 4, gpu: Boolean = false, log: (String) -> Unit): Boolean {
        if (isRunning(slot.name)) return true

        // Already answering? Take ownership instead of fighting for the port.
        if (awaitHealthy(slot.port, 2_000)) {
            adopted.add(slot.name)
            log("[${slot.name}] adopting engine already listening on ${slot.port}")
            return true
        }

        val bin = serverBin()
        if (!bin.exists()) { log("engine missing at ${bin.absolutePath}"); return false }
        if (!slot.model.exists()) { log("model missing: ${slot.model.name}"); return false }

        val cmd = mutableListOf(
            bin.absolutePath,
            "-m", slot.model.absolutePath,
            "--port", slot.port.toString(),
            "--host", "127.0.0.1",
            "-c", "4096",
            // 99 = every layer on the GPU. The Windows/macOS builds do this
            // unconditionally; here the Vulkan/Mali path can fail on some
            // driver states, so EngineService retries with gpu=false.
            "-ngl", if (gpu) "99" else "0",
            // Cap threads explicitly. Left to itself each server takes every
            // core, so two of them spawn ~52 threads on a 9-core phone and
            // spend more time contending than computing. Measured: 0.24-0.51
            // tok/s with defaults.
            "-t", threads.toString(),
            "--jinja",
            "--no-webui",
        )
        slot.mmproj?.let { if (it.exists()) cmd += listOf("--mmproj", it.absolutePath) }

        return try {
            val pb = ProcessBuilder(cmd)
                .directory(ctx.filesDir)
                .redirectErrorStream(true)
            // LD_LIBRARY_PATH so the sibling libllama.so / libggml*.so resolve.
            pb.environment()["LD_LIBRARY_PATH"] = ctx.applicationInfo.nativeLibraryDir
            pb.environment()["TMPDIR"] = ctx.cacheDir.absolutePath

            // Hide Vulkan from CPU-only servers.
            //
            // The engine binary now carries the Vulkan backend, and it enumerates
            // devices at startup whether or not -ngl asks for them. With the Mali
            // driver present that turns a 3-second translation into a 60-120 second
            // hang — measured: same binary, -ngl 0, hangs; with this env var set,
            // 2.9 s and 28 tok/s. So the translator must not see the GPU at all.
            if (!gpu) pb.environment()["GGML_VK_VISIBLE_DEVICES"] = "none"
            val p = pb.start()
            procs[slot.name] = p
            Thread {
                p.inputStream.bufferedReader().forEachLine { log("[${slot.name}] $it") }
            }.apply { isDaemon = true }.start()
            log("[${slot.name}] started with gpu=$gpu (ngl=${if (gpu) 99 else 0})")
            true
        } catch (e: Exception) {
            log("spawn failed: ${e.message}")
            false
        }
    }

    /**
     * True while the process for this slot is alive.
     *
     * Used right after spawning on the GPU path: a bad Mali driver kills the
     * server within a second or two, and waiting the full health timeout would
     * turn a 3-second fallback into a 3-minute stall.
     */
    fun alive(name: String): Boolean = name in adopted || procs[name]?.isAlive == true

    fun stopAll() {
        procs.values.forEach { runCatching { it.destroy() } }
        procs.clear()
    }

    /** Poll /health until the server answers or the deadline passes. */
    fun awaitHealthy(port: Int, timeoutMs: Long = 180_000): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            try {
                val c = URL("http://127.0.0.1:$port/health").openConnection() as HttpURLConnection
                c.connectTimeout = 2000
                c.readTimeout = 2000
                if (c.responseCode == 200) {
                    val body = c.inputStream.bufferedReader().readText()
                    if (!body.contains("loading", ignoreCase = true)) return true
                }
            } catch (_: Exception) { /* still starting */ }
            Thread.sleep(500)
        }
        return false
    }
}
