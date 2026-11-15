package com.lionel.parley

import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * First-run model download.
 *
 * 2.4 GB across three files. They cannot ride in the APK — Play caps a base
 * module at 200 MB and an AAB at 4 GB, but a 2.4 GB download against an install
 * would be hostile on mobile data. So the app ships the engine and fetches the
 * weights, exactly like the desktop build.
 *
 * Resumable: a phone on a train loses the connection, and restarting 1.1 GB
 * from zero is the difference between a usable app and an abandoned one.
 */
class ModelDownloader(private val engine: Engine) {

    data class Item(val name: String, val repo: String, val bytes: Long)

    val items = listOf(
        Item("LFM3-Audio-2B-Q4_K_M.gguf", "LiquidAI/LFM3-Audio-2B-GGUF", 1_099_626_016),
        Item("mmproj-LFM3-Audio-2B-Q4_K_M.gguf", "LiquidAI/LFM3-Audio-2B-GGUF", 172_418_048),
        Item("LFM3-Omni-2B-Q4_K_M.gguf", "LiquidAI/LFM3-Omni-2B-GGUF", 1_099_630_080),
    )

    fun totalBytes(): Long = items.sumOf { it.bytes }

    /**
     * Describe what is actually on disk, for the Models panel.
     *
     * Ported from the desktop build, which distinguishes four states because
     * "missing" alone is not actionable:
     *
     *   ready      full file present
     *   partial    a `.part` sits there from an interrupted download; resumes
     *   truncated  file exists but is short and there is no `.part` to resume
     *   missing    neither
     *
     * The difference matters: telling someone to "download it again" when a
     * resume would work is the kind of detail that makes an app feel careless.
     */
    data class Report(
        val name: String,
        val bytes: Long,
        val onDisk: Long,
        val state: String,
        val percent: Int,
    )

    fun report(): List<Report> {
        val dir = engine.modelsDir()
        return items.map { item ->
            val dest = File(dir, item.name)
            val part = File(dir, item.name + ".part")
            val have = if (dest.exists()) dest.length() else -1L
            val partBytes = if (part.exists()) part.length() else -1L

            val state = when {
                have >= item.bytes * 0.98 -> "ready"
                partBytes >= 0 -> "partial"
                have >= 0 -> "truncated"
                else -> "missing"
            }
            // A paused download has no completed file, so measuring progress from
            // `have` reports 0% while 400 MB sit on disk. Whichever holds data wins.
            val present = maxOf(maxOf(have, 0L), maxOf(partBytes, 0L))
            Report(
                name = item.name,
                bytes = item.bytes,
                onDisk = present,
                state = state,
                percent = ((present * 100) / item.bytes).toInt().coerceIn(0, 100),
            )
        }
    }

    fun bytesOnDisk(): Long = items.sumOf { item ->
        val f = File(engine.modelsDir(), item.name)
        val part = File(engine.modelsDir(), item.name + ".part")
        maxOf(if (f.exists()) f.length() else 0L, if (part.exists()) part.length() else 0L)
    }

    /**
     * Download everything that is missing or short. Returns true when all three
     * files are complete.
     */
    fun ensureAll(
        onProgress: (done: Long, total: Long, label: String) -> Unit,
        isCancelled: () -> Boolean = { false },
    ): Boolean {
        val dir = engine.modelsDir()
        var done = 0L
        for (item in items) {
            if (isCancelled()) return false
            val dest = File(dir, item.name)
            if (dest.length() >= item.bytes * 0.98) { done += item.bytes; continue }

            val ok = fetch(item, dest) { written ->
                onProgress(done + written, totalBytes(), item.name)
            }
            if (!ok) return false
            done += item.bytes
        }
        return engine.isReady()
    }

    /** One file, resuming from `.part` when the server honours Range. */
    private fun fetch(item: Item, dest: File, onBytes: (Long) -> Unit): Boolean {
        val part = File(dest.absolutePath + ".part")
        var have = if (part.exists()) part.length() else 0L
        if (have >= item.bytes) { part.delete(); have = 0 }

        val url = URL(
            "https://huggingface.co/${item.repo}/resolve/main/" +
            java.net.URLEncoder.encode(item.name, "UTF-8") + "?download=true"
        )
        val c = url.openConnection() as HttpURLConnection
        c.connectTimeout = 20_000
        c.readTimeout = 60_000
        c.instanceFollowRedirects = true
        if (have > 0) c.setRequestProperty("Range", "bytes=$have-")

        val code = c.responseCode
        if (code !in 200..299 && code != 206) return false

        // Range ignored: the server resent the whole file, so start clean rather
        // than appending a second copy onto the existing bytes.
        var written = have
        val append = have > 0 && code == 206
        if (have > 0 && code == 200) { part.delete(); written = 0 }

        c.inputStream.use { input ->
            java.io.FileOutputStream(part, append).use { out ->
                val buf = ByteArray(256 * 1024)
                var lastReport = 0L
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    out.write(buf, 0, n)
                    written += n
                    if (written - lastReport > 2_000_000) {
                        lastReport = written
                        onBytes(written)
                    }
                }
            }
        }
        onBytes(written)

        // A closed socket looks like success. Promote only a complete file, or a
        // truncated model is renamed into place and fails to load with no reason.
        if (part.length() < item.bytes * 0.98) return false
        return part.renameTo(dest)
    }
}
