package com.lionel.parley

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream

/**
 * Microphone capture straight to 16 kHz mono WAV.
 *
 * The desktop build pipes the browser's webm/opus through ffmpeg to get exactly
 * this format. Android can record it natively, so there is no ffmpeg here and
 * no decode step — one less 130 MB binary in the APK.
 *
 * 16 kHz mono is what the audio model was trained on. Recording at 44.1 kHz and
 * resampling would add latency for no accuracy gain.
 */
object AudioRec {

    const val SAMPLE_RATE = 16_000

    @SuppressLint("MissingPermission")
    /**
     * @param onSnapshot called every [snapshotMs] with the audio captured so far,
     *        already wrapped as WAV. Used for interim captions in tap-to-speak
     *        mode, which previously showed nothing at all until the fixed window
     *        closed — the desktop behaves the same way for both input paths.
     */
    fun record(
        durationMs: Int = 8_000,
        onLevel: (Float) -> Unit = {},
        snapshotMs: Long = 1_200,
        onSnapshot: ((ByteArray) -> Unit)? = null,
    ): ByteArray {
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        val bufSize = maxOf(minBuf, SAMPLE_RATE * 2)

        val rec = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufSize
        )
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            throw IllegalStateException("microphone unavailable (state ${rec.state})")
        }

        val pcm = ByteArrayOutputStream()
        val buf = ShortArray(bufSize / 2)
        var lastSnapshotAt = 0L
        rec.startRecording()
        try {
            val end = System.currentTimeMillis() + durationMs
            while (System.currentTimeMillis() < end) {
                val n = rec.read(buf, 0, buf.size)
                if (n > 0) {
                    var peak = 0
                    for (i in 0 until n) {
                        val v = kotlin.math.abs(buf[i].toInt())
                        if (v > peak) peak = v
                        pcm.write(buf[i].toInt() and 0xFF)
                        pcm.write((buf[i].toInt() shr 8) and 0xFF)
                    }
                    onLevel(peak / 32768f)

                    val now = System.currentTimeMillis()
                    if (onSnapshot != null && now - lastSnapshotAt >= snapshotMs) {
                        lastSnapshotAt = now
                        val partial = pcm.toByteArray()
                        if (partial.size > 32_000) {
                            onSnapshot(wav(partial))
                        }
                    }
                }
            }
        } finally {
            runCatching { rec.stop() }
            rec.release()
        }

        val bytes = pcm.toByteArray()
        // If the platform is silencing the microphone (foreground-service type
        // missing, or an app-op denial) the buffer arrives full of zeros. Without
        // this line the symptom is "nothing happens" and the cause is invisible.
        var maxAmp = 0
        var i = 0
        while (i + 1 < bytes.size) {
            val v = ((bytes[i + 1].toInt() shl 8) or (bytes[i].toInt() and 0xFF)).toShort().toInt()
            val a = kotlin.math.abs(v)
            if (a > maxAmp) maxAmp = a
            i += 2
        }
        android.util.Log.i(
            "Parley",
            "record: ${bytes.size} bytes, peak=$maxAmp ${if (maxAmp < 200) "== SILENT (mic denied or silenced)" else "ok"}",
        )
        return wav(bytes)
    }

    /** Wrap raw PCM16 mono in a RIFF header the server will accept. */
    fun wav(pcm: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(44 + pcm.size)
        val byteRate = SAMPLE_RATE * 2

        fun u32(v: Int) {
            out.write(v and 0xFF); out.write((v shr 8) and 0xFF)
            out.write((v shr 16) and 0xFF); out.write((v shr 24) and 0xFF)
        }
        fun u16(v: Int) {
            out.write(v and 0xFF); out.write((v shr 8) and 0xFF)
        }

        out.write("RIFF".toByteArray()); u32(36 + pcm.size); out.write("WAVE".toByteArray())
        out.write("fmt ".toByteArray()); u32(16); u16(1); u16(1)
        u32(SAMPLE_RATE); u32(byteRate); u16(2); u16(16)
        out.write("data".toByteArray()); u32(pcm.size); out.write(pcm)
        return out.toByteArray()
    }
}
