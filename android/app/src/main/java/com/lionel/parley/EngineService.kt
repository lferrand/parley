package com.lionel.parley

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * Keeps the engine alive while the app is backgrounded.
 *
 * A 1.5 GB child process is exactly what Android reclaims first when memory
 * tightens. Without this, taking a phone call mid-sentence tears down the
 * server and the next utterance pays a 40-second model load. The ongoing
 * notification is the price of staying resident, and it is honest about it.
 */
class EngineService : Service() {

    companion object {
        const val CHANNEL = "parley_engine"
        const val NOTIF_ID = 41
        @Volatile var engine: Engine? = null
    }

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_ID, buildNotification("Preparing…"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val ctx = applicationContext
        if (engine == null) engine = Engine(ctx)

        Thread {
            val e = engine ?: return@Thread
            val api = Api(ctx, e)
            try {
                if (!e.isReady()) {
                    update("Downloading models")
                    val dl = ModelDownloader(e)
                    val ok = dl.ensureAll({ done, total, label ->
                        val pct = if (total > 0) (done * 100 / total) else 0
                        update("Downloading $pct% · ${label.take(28)}")
                    })
                    if (!ok) { update("Download failed — open the app"); return@Thread }
                }

                // TWO models, as on the desktop.
                //
                // I previously collapsed this to one because two models pushed
                // 5.1 GB into swap and generation fell to 0.24-0.51 tok/s. That
                // verdict was measured against a build with KleidiAI DISABLED,
                // so the kernels were the problem, not the memory. Re-measured
                // with optimised kernels on the same Pixel 8 Pro:
                //
                //   one model  (Audio-2B translating): 4.5 s,  6.9 tok/s
                //   two models (Audio-2B + Omni):      1.55 s, 18.0 tok/s
                //
                // Omni is simply a far better translator. With KleidiAI it is
                // also three times faster. Both fit; the earlier conclusion was
                // wrong and is corrected here rather than defended.
                // Run the translation guards' self-test before the engines start.
                // It costs microseconds and it is the only evidence, on-device,
                // that the shipped rules parse and that a reply-instead-of-
                // translation is actually rejected.
                Guards.get(ctx).selfTest()

                // GPU first, CPU on failure.
                //
                // The Vulkan backend puts every layer on the Mali-G715 and is
                // the only real lever left on speech latency, because the TTS
                // vocoder is CPU-bound and dominates a turn. But a bad driver
                // state kills the server within a second or two, so probe
                // liveness immediately rather than waiting out the full health
                // timeout - that turns a 3-second fallback into a 3-minute stall.
                // Per-stage backend choice, because the two stages disagree.
                //
                // Measured on the Mali-G715 (same sentences, same build):
                //
                //   TTS   "네."        11.7 s (CPU) ->  3.1 s (GPU)   3.8x faster
                //   TTS   long sentence 36.5 s     -> 10.3 s         3.5x faster
                //   MT    prefill       32.8 tok/s -> 18.8 tok/s     SLOWER
                //   MT    generate      15.0 tok/s -> 14.9 tok/s     same
                //
                // The vocoder is where the seconds live, and the GPU is far
                // better at it. Prefill is matmul-heavy and the Mali driver is
                // worse than KleidiAI's CPU kernels at that shape, so putting
                // translation on the GPU would slow it down. Hence: audio on
                // GPU, translator on CPU.
                update("Starting speech engine")
                val audioOk = startWithFallback(
                    e, Engine.Slot("audio", 8793, e.audioModel, e.audioMmproj),
                    preferGpu = true,
                )
                if (!audioOk) { update("Audio engine failed to start"); return@Thread }

                update("Starting translator")
                val textOk = startWithFallback(
                    e, Engine.Slot("text", 8795, e.textModel, null),
                    preferGpu = false,
                )
                if (!textOk) { update("Text engine failed to start"); return@Thread }

                android.util.Log.i("Parley", "engines ready: audio=${e.isRunning("audio")} text=${e.isRunning("text")}")
                update("Ready")
                // Warm the translator once: the first real request otherwise
                // pays graph-instantiation cost on top of the user's waiting.
                runCatching { api.translateTextOnly("warm up", "ko") }
            } catch (t: Throwable) {
                update("Engine error: ${t.message?.take(60)}")
            }
        }.start()

        return START_STICKY
    }

    /**
     * Start a slot on the GPU, falling back to CPU if the driver refuses.
     *
     * Returns true when the engine answers. Logs which backend won so the
     * choice is visible from adb rather than inferred from speed.
     */
    private fun startWithFallback(e: Engine, slot: Engine.Slot, preferGpu: Boolean): Boolean {
        val log: (String) -> Unit = { android.util.Log.i("Parley", it) }

        if (!preferGpu) {
            // Straight to CPU: measured faster for this stage on this device.
            if (e.start(slot, gpu = false, log = log) && e.awaitHealthy(slot.port, 240_000)) {
                android.util.Log.i("Parley", "[${slot.name}] running on CPU (chosen: faster for this stage)")
                return true
            }
            return false
        }

        if (e.start(slot, gpu = true, log = log)) {
            // A Vulkan init failure kills the process almost immediately, so a
            // short liveness check distinguishes "crashing" from "still loading".
            Thread.sleep(2_500)
            if (e.alive(slot.name)) {
                if (e.awaitHealthy(slot.port, 180_000)) {
                    android.util.Log.i("Parley", "[${slot.name}] running on GPU")
                    return true
                }
            }
            android.util.Log.w("Parley", "[${slot.name}] GPU backend failed, retrying on CPU")
            e.stopAll()
            Thread.sleep(1_000)
        }

        if (e.start(slot, gpu = false, log = log) && e.awaitHealthy(slot.port, 240_000)) {
            android.util.Log.i("Parley", "[${slot.name}] running on CPU")
            return true
        }
        return false
    }

    private fun buildNotification(text: String): Notification {
        val mgr = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL, "Parley engine", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL)
            .setContentTitle("Parley")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    private fun update(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification(text))
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        engine?.stopAll()
        engine = null
        super.onDestroy()
    }
}

/** Tiny helpers used to warm the pipeline. */
object Fixtures {
    /** 0.3 s of digital silence, enough to exercise the request path. */
    fun silenceWav(): ByteArray {
        val samples = (16_000 * 0.3).toInt()
        val pcm = ByteArray(samples * 2)
        val out = java.io.ByteArrayOutputStream(44 + pcm.size)
        fun u32(v: Int) = out.write(byteArrayOf(
            (v and 0xFF).toByte(), ((v shr 8) and 0xFF).toByte(),
            ((v shr 16) and 0xFF).toByte(), ((v shr 24) and 0xFF).toByte()))
        fun u16(v: Int) = out.write(byteArrayOf((v and 0xFF).toByte(), ((v shr 8) and 0xFF).toByte()))
        out.write("RIFF".toByteArray()); u32(36 + pcm.size); out.write("WAVE".toByteArray())
        out.write("fmt ".toByteArray()); u32(16); u16(1); u16(1)
        u32(16_000); u32(32_000); u16(2); u16(16)
        out.write("data".toByteArray()); u32(pcm.size); out.write(pcm)
        return out.toByteArray()
    }
}
