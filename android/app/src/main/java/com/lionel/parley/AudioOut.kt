package com.lionel.parley

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack

/**
 * Plays whatever the /tts route returned.
 *
 * The route's default is a full WAV file, not raw samples, and its `pcm`
 * variant is float32 little-endian — not 16-bit. Writing either straight into a
 * PCM16 track produces a burst of noise then silence, which reads as "TTS is
 * broken" rather than "the header was not parsed".
 *
 * So walk the RIFF chunk list and configure the track from what the file says.
 */
object AudioOut {

    fun playWav(data: ByteArray?) {
        if (data == null) { android.util.Log.w("Parley", "TTS: null audio"); return }
        if (data.size < 44) { android.util.Log.w("Parley", "TTS: tiny payload ${data.size}b"); return }

        val isWav = data[0] == 'R'.code.toByte() && data[1] == 'I'.code.toByte() &&
            data[2] == 'F'.code.toByte() && data[3] == 'F'.code.toByte()

        var pcm = data
        var sampleRate = 24_000
        var channels = 1
        var encoding = AudioFormat.ENCODING_PCM_16BIT

        if (isWav) {
            var pos = 12
            var dataOff = -1
            var dataLen = 0
            while (pos + 8 <= data.size) {
                val id = String(data, pos, 4, Charsets.US_ASCII)
                val sz = (data[pos + 4].toInt() and 0xFF) or
                    ((data[pos + 5].toInt() and 0xFF) shl 8) or
                    ((data[pos + 6].toInt() and 0xFF) shl 16) or
                    ((data[pos + 7].toInt() and 0xFF) shl 24)

                if (id == "fmt " && pos + 24 <= data.size) {
                    val fmt = (data[pos + 8].toInt() and 0xFF) or ((data[pos + 9].toInt() and 0xFF) shl 8)
                    channels = (data[pos + 10].toInt() and 0xFF) or ((data[pos + 11].toInt() and 0xFF) shl 8)
                    sampleRate = (data[pos + 12].toInt() and 0xFF) or
                        ((data[pos + 13].toInt() and 0xFF) shl 8) or
                        ((data[pos + 14].toInt() and 0xFF) shl 16) or
                        ((data[pos + 15].toInt() and 0xFF) shl 24)
                    val bits = (data[pos + 22].toInt() and 0xFF) or ((data[pos + 23].toInt() and 0xFF) shl 8)
                    encoding = when {
                        fmt == 3 && bits == 32 -> AudioFormat.ENCODING_PCM_FLOAT
                        bits == 8 -> AudioFormat.ENCODING_PCM_8BIT
                        else -> AudioFormat.ENCODING_PCM_16BIT
                    }
                }
                if (id == "data") {
                    dataOff = pos + 8
                    dataLen = minOf(sz, data.size - dataOff)
                    break
                }
                // Chunks are word-aligned: an odd size carries a pad byte.
                pos += 8 + sz + (sz and 1)
            }
            if (dataOff < 0) return
            pcm = data.copyOfRange(dataOff, dataOff + dataLen)
        } else {
            // No header: the server sent its `pcm` variant, float32 LE mono.
            encoding = AudioFormat.ENCODING_PCM_FLOAT
        }

        if (pcm.isEmpty()) { android.util.Log.w("Parley", "TTS: empty pcm"); return }
        val channelMask = if (channels > 1) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO

        val track = try {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(encoding)
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelMask)
                        .build(),
                )
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(pcm.size)
                .build()
        } catch (t: Throwable) {
            android.util.Log.e("Parley", "TTS: AudioTrack build failed: ${t.javaClass.simpleName}: ${t.message}")
            return
        }

        try {
            // Trim to whole frames: a partial trailing frame is rejected and
            // leaves the buffer short.
            val bytesPerFrame = (if (encoding == AudioFormat.ENCODING_PCM_FLOAT) 4 else 2) * channels
            val usable = pcm.size - (pcm.size % bytesPerFrame)
            if (usable <= 0) { android.util.Log.w("Parley", "TTS: no whole frames"); return }
            val wrote = track.write(pcm, 0, usable)
            android.util.Log.i(
                "Parley",
                "TTS: wrote=$wrote/$usable enc=$encoding rate=$sampleRate ch=$channels " +
                    "state=${track.state} playstate=${track.playState}",
            )
            track.play()
            val frames = usable / bytesPerFrame
            Thread.sleep((frames.toLong() * 1000 / sampleRate) + 150)
        } catch (t: Throwable) {
            android.util.Log.e("Parley", "TTS: playback failed: ${t.javaClass.simpleName}: ${t.message}")
        } finally {
            runCatching { track.release() }
        }
    }
// (object continues below: playWavStream lives here so callers use one name)

/**
 * Play a WAV stream while it is still being generated.
 *
 * Measured on a Pixel 8 Pro: the TTS vocoder runs on the CPU and produces about
 * one second of speech per twelve seconds of compute. A short sentence costs
 * 12 s of waiting, a long one 36 s. But the engine emits its first audio after
 * ~4.8 s regardless of length, so streaming turns "wait 36 s, then hear it" into
 * "start hearing at 5 s and keep playing".
 *
 * A MODE_STREAM track accepts PCM as it arrives. The RIFF header is parsed from
 * the front of the stream and discarded; everything after it is samples.
 */
fun playWavStream(input: java.io.InputStream?) {
    if (input == null) {
        android.util.Log.w("Parley", "TTS stream: none")
        return
    }

    var sampleRate = 24_000
    var channels = 1
    var encoding = AudioFormat.ENCODING_PCM_16BIT

    try {
        // --- read forward until the `data` chunk starts -------------------
        // Chunks before it describe the format; the bytes after are PCM. We
        // cannot know the header length in advance because encoders insert
        // LIST/fact chunks, so walk rather than assume 44 bytes.
        var header = ByteArray(0)
        var payloadAt = -1

        while (header.size < 8192 && payloadAt < 0) {
            val b = input.read()
            if (b < 0) break
            header += b.toByte()

            if (header.size < 12) continue

            var pos = 12
            while (pos + 8 <= header.size) {
                val id = String(header, pos, 4, Charsets.US_ASCII)
                val sz = (header[pos + 4].toInt() and 0xFF) or
                    ((header[pos + 5].toInt() and 0xFF) shl 8) or
                    ((header[pos + 6].toInt() and 0xFF) shl 16) or
                    ((header[pos + 7].toInt() and 0xFF) shl 24)

                if (id == "fmt " && pos + 24 <= header.size) {
                    val fmt = (header[pos + 8].toInt() and 0xFF) or ((header[pos + 9].toInt() and 0xFF) shl 8)
                    channels = (header[pos + 10].toInt() and 0xFF) or ((header[pos + 11].toInt() and 0xFF) shl 8)
                    sampleRate = (header[pos + 12].toInt() and 0xFF) or
                        ((header[pos + 13].toInt() and 0xFF) shl 8) or
                        ((header[pos + 14].toInt() and 0xFF) shl 16) or
                        ((header[pos + 15].toInt() and 0xFF) shl 24)
                    val bits = (header[pos + 22].toInt() and 0xFF) or
                        ((header[pos + 23].toInt() and 0xFF) shl 8)
                    encoding = when {
                        fmt == 3 && bits == 32 -> AudioFormat.ENCODING_PCM_FLOAT
                        bits == 8 -> AudioFormat.ENCODING_PCM_8BIT
                        else -> AudioFormat.ENCODING_PCM_16BIT
                    }
                }

                if (id == "data") {
                    payloadAt = pos + 8
                    break
                }
                if (sz < 0 || sz > header.size) break   // header not fully here yet
                pos += 8 + sz + (sz and 1)
            }
        }

        if (payloadAt < 0) {
            android.util.Log.w("Parley", "TTS stream: no data chunk in first ${header.size} bytes")
            return
        }

        val bytesPerFrame = (if (encoding == AudioFormat.ENCODING_PCM_FLOAT) 4 else 2) * channels
        val track = makeStreamTrack(sampleRate, channels, encoding, bytesPerFrame) ?: return

        try {
            track.play()
            var total = 0L

            // Whatever PCM already arrived rides on this same track, so the first
            // fraction of a second is not dropped and there is no seam.
            val leftover = header.copyOfRange(payloadAt, header.size)
            val usableLeft = leftover.size - (leftover.size % bytesPerFrame)
            if (usableLeft > 0) {
                track.write(leftover, 0, usableLeft)
                total += usableLeft
            }

            var carry = leftover.size - usableLeft
            val buf = ByteArray(16 * 1024)
            if (carry > 0) System.arraycopy(leftover, usableLeft, buf, 0, carry)

            while (true) {
                val n = input.read(buf, carry, buf.size - carry)
                if (n <= 0) break
                val avail = carry + n
                val usable = avail - (avail % bytesPerFrame)
                if (usable <= 0) {
                    carry = avail
                    continue
                }
                track.write(buf, 0, usable)
                total += usable
                carry = avail - usable
                if (carry > 0) System.arraycopy(buf, usable, buf, 0, carry)
            }

            // Let the buffered tail drain before releasing, or the last word is cut.
            track.stop()
            android.util.Log.i("Parley", "TTS stream: played $total bytes @ ${sampleRate}Hz enc=$encoding")
        } finally {
            runCatching { track.release() }
        }
    } catch (t: Throwable) {
        android.util.Log.e("Parley", "TTS stream failed: ${t.javaClass.simpleName}: ${t.message}")
    }
}

private fun makeStreamTrack(
    sampleRate: Int,
    channels: Int,
    encoding: Int,
    bytesPerFrame: Int,
): AudioTrack? = try {
    AudioTrack.Builder()
        .setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        .setAudioFormat(
            AudioFormat.Builder()
                .setEncoding(encoding)
                .setSampleRate(sampleRate)
                .setChannelMask(if (channels > 1) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO)
                .build(),
        )
        .setTransferMode(AudioTrack.MODE_STREAM)
        .setBufferSizeInBytes(bytesPerFrame * sampleRate / 2)   // half a second of slack
        .build()
} catch (t: Throwable) {
    android.util.Log.e("Parley", "TTS stream: track build failed: ${t.message}")
    null
}
}
