package com.lionel.parley

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Continuous listening with automatic utterance segmentation, ported from the
 * desktop build's VAD.
 *
 * Push-to-talk records a fixed window: you tap, you speak, it stops whether or
 * not you finished. That is fine for trying the app and wrong for using it.
 * This watches the microphone's level and cuts a turn when you stop talking,
 * which is how a conversation actually works.
 *
 * Thresholds are the desktop's, unchanged — they were tuned against real rooms
 * and there is no reason to re-derive them for a phone microphone.
 */
object Vad {

    const val SAMPLE_RATE = 16_000

    private const val MIN_THRESHOLD = 0.012   // absolute floor, for very quiet rooms
    private const val THRESHOLD_FACTOR = 2.2  // how far above the room's noise floor counts as speech
    private const val RELEASE_FACTOR = 0.6    // hysteresis: keep going while above threshold*this
    const val DEFAULT_HANGOVER_MS = 1400     // pause tolerated mid-sentence before the turn ends
    const val DEFAULT_INTERIM_MS = 1200L     // how often a growing utterance is re-transcribed
    private const val MIN_SPEECH_MS = 300     // ignore clicks and pops
    private const val MAX_UTTERANCE_MS = 30_000
    private const val FRAME_MS = 50

    /**
     * Listen until [shouldStop] returns true, emitting one WAV per utterance.
     *
     * Suspend function: call it from an IO dispatcher. [onUtterance] is suspend so
     * the caller can hop to the main thread to update UI without capturing a
     * scope here.
     */
    /**
     * Only one listener may own the microphone.
     *
     * The effect that calls this can be cancelled, but `rec.read()` is a blocking
     * JNI call that never observes coroutine cancellation, so a restart overlaps
     * the previous loop. Two AudioRecords then contend and the newer one receives
     * digital silence — which reads as "the detector never hears anything", with
     * `speaking=false` forever and no interim passes.
     */
    @Volatile private var listening = false

    @SuppressLint("MissingPermission")
    suspend fun listen(
        onUtterance: suspend (ByteArray) -> Unit,
        onLevel: (Float) -> Unit = {},
        onInterim: suspend (ByteArray) -> Unit = {},
        interimMs: Long = DEFAULT_INTERIM_MS,
        hangoverMs: Int = DEFAULT_HANGOVER_MS,
        shouldStop: () -> Boolean = { false },
    ) {
        // The previous loop notices cancellation within one frame (~50 ms), so a
        // short wait is enough. Contending would silence the newer stream, which
        // is worse than starting a moment late.
        var waited = 0
        while (listening && waited < 1500) {
            kotlinx.coroutines.delay(50)
            waited += 50
        }
        if (listening) {
            android.util.Log.w("Parley", "vad: previous listener still holds the mic after ${waited}ms")
            return
        }
        listening = true

        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val bufSize = max(minBuf, SAMPLE_RATE / 10)

        val rec = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufSize,
        )
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            throw IllegalStateException("microphone unavailable (state ${rec.state})")
        }

        val frameSamples = SAMPLE_RATE * FRAME_MS / 1000
        val buf = ShortArray(frameSamples)

        // The room's noise floor, adapted as we listen so a fan or a quiet room
        // both work without a calibration step.
        var noiseFloor = 0.006
        var speaking = false
        var utterance = ByteArrayOutputStream()
        var speechStartAt = 0L
        var lastVoiceAt = 0L
        // Interim transcription is deliberately best-effort: it re-reads the
        // utterance so far while the speaker is still going, so words appear
        // instead of a blank screen. The desktop build does the same and notes
        // that a half-written buffer decodes fine.
        var lastInterimAt = 0L
        var interimJob: Job? = null
        var finalJob: Job? = null
        var framesRead = 0L
        var peakRms = 0.0
        var lastBeatAt = 0L

        rec.startRecording()
        // The read loop must never await an ASR request. Doing so earlier stopped
        // calling rec.read() for the duration of the request (2-4 s), so the
        // AudioRecord buffer wrapped and that speech was lost — and turn-end
        // detection could only run after the request returned, long after the
        // speaker stopped. Interim passes are launched detached instead.
        coroutineScope {
        try {
            while (isActive && !shouldStop()) {
                val n = rec.read(buf, 0, frameSamples)
                if (n <= 0) continue

                var sum = 0.0
                for (i in 0 until n) {
                    val v = buf[i] / 32768.0
                    sum += v * v
                }
                val rms = sqrt(sum / n)
                onLevel(rms.toFloat())
                framesRead++
                if (rms > peakRms) peakRms = rms

                val now = System.currentTimeMillis()

                if (now - lastBeatAt >= 5000) {
                    lastBeatAt = now
                    android.util.Log.i(
                        "Parley",
                        "vad alive: ${framesRead} frames, peak=${"%.3f".format(peakRms)}, " +
                            "speaking=$speaking, interimMs=$interimMs",
                    )
                    peakRms = 0.0
                }
                val open = max(MIN_THRESHOLD, noiseFloor * THRESHOLD_FACTOR)
                val release = open * RELEASE_FACTOR

                if (!speaking) {
                    // Track the floor only while silent, or speech drags it up
                    // and the detector goes deaf.
                    noiseFloor = noiseFloor * 0.95 + rms * 0.05

                    if (rms > open) {
                        speaking = true
                        speechStartAt = now
                        lastVoiceAt = now
                        utterance = ByteArrayOutputStream()
                        writeFrame(utterance, buf, n)
                        lastInterimAt = 0L
                    }
                    continue
                }

                writeFrame(utterance, buf, n)
                if (rms > release) lastVoiceAt = now

                // Re-transcribe the growing buffer on a timer. Cheap because the
                // caller only asks for a transcript, no translation, and skips
                // the request entirely while a real turn is still processing.
                if (speaking && now - lastInterimAt >= interimMs && now - speechStartAt >= 600) {
                    lastInterimAt = now
                    val snapshot = wav(utterance.toByteArray())
                    // One in flight at a time: more would queue behind each other
                    // on the single audio server and starve the final request.
                    if (snapshot.size > 44 && interimJob?.isActive != true) {
                        interimJob = launch(Dispatchers.IO) {
                            runCatching { onInterim(snapshot) }
                        }
                    }
                }

                val spokenMs = now - speechStartAt
                val quietMs = now - lastVoiceAt
                if (spokenMs >= MAX_UTTERANCE_MS ||
                    (quietMs >= hangoverMs && spokenMs >= MIN_SPEECH_MS)
                ) {
                    speaking = false
                    // Drop the speculative pass: the final request would otherwise
                    // sit behind it on the single audio server.
                    interimJob?.cancel()
                    interimJob = null
                    if (spokenMs >= MIN_SPEECH_MS) {
                        val wav = wav(utterance.toByteArray())
                        // Detached, exactly like the interim pass. A full turn is
                        // ASR + translation + TTS, which measured 30+ seconds here;
                        // awaiting that inside the read loop stopped calling
                        // rec.read(), so the microphone went deaf for the whole
                        // turn and nothing the user said afterwards was captured.
                        // That is what "it never stops to output" actually was.
                        if (wav.size > 44) {
                            finalJob = launch(Dispatchers.IO) {
                                runCatching { onUtterance(wav) }
                            }
                        }
                    }
                    utterance = ByteArrayOutputStream()
                }
            }
        } finally {
            runCatching { rec.stop() }
            rec.release()
            listening = false
            android.util.Log.i("Parley", "vad: stopped after $framesRead frames")
        }
        }
    }

    private fun writeFrame(out: ByteArrayOutputStream, buf: ShortArray, n: Int) {
        for (i in 0 until n) {
            out.write(buf[i].toInt() and 0xFF)
            out.write((buf[i].toInt() shr 8) and 0xFF)
        }
    }

    /** Wrap raw PCM16 mono in a RIFF header the server will accept. */
    private fun wav(pcm: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(44 + pcm.size)
        fun u32(v: Int) = out.write(
            byteArrayOf(
                (v and 0xFF).toByte(), ((v shr 8) and 0xFF).toByte(),
                ((v shr 16) and 0xFF).toByte(), ((v shr 24) and 0xFF).toByte(),
            ),
        )
        fun u16(v: Int) = out.write(byteArrayOf((v and 0xFF).toByte(), ((v shr 8) and 0xFF).toByte()))

        out.write("RIFF".toByteArray()); u32(36 + pcm.size); out.write("WAVE".toByteArray())
        out.write("fmt ".toByteArray()); u32(16); u16(1); u16(1)
        u32(SAMPLE_RATE); u32(SAMPLE_RATE * 2); u16(2); u16(16)
        out.write("data".toByteArray()); u32(pcm.size); out.write(pcm)
        return out.toByteArray()
    }
}
