package com.lionel.parley

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64

/**
 * Drives the two local llama-server instances.
 *
 * Same wire protocol as the desktop build, and the same validation loop. The
 * parts that look odd here are all measured behaviour, not preference; each
 * notes what it is protecting against.
 */
class Api(ctx: Context, private val engine: Engine) {

    /**
     * One model attempt, recorded for the trace panel.
     *
     * The desktop build keeps these so a bad translation can be explained rather
     * than merely noticed: which prompt variant ran, what came back, and which
     * guard rejected it. Without it the only visible symptom is "the answer is
     * wrong", which is not something anyone can act on.
     */
    data class Attempt(
        val stage: String,
        val ms: Long,
        val ok: Boolean,
        val preview: String,
        val chars: Int,
        val reasons: List<String>,
    )

    data class Timings(val asrMs: Long, val translateMs: Long, val totalMs: Long)

    data class Result(
        val transcript: String,
        val translation: String,
        val targetLang: String,
        val targetName: String,
        val ms: Long,
        val attempts: Int,
        val variant: Int,
        val timings: Timings = Timings(0, 0, 0),
        val trace: List<Attempt> = emptyList(),
        /** True when every prompt variant failed validation. */
        val unverified: Boolean = false,
    )

    private val guards = Guards.get(ctx)

    private val audioPort = 8793
    private val textPort = 8795

    /**
     * Speech in, translation out.
     *
     * @param targetCode one of the codes in `Languages`
     */
    fun translate(
        wav: ByteArray,
        targetCode: String = "ko",
        sourceCode: String = "auto",
        onStage: (String) -> Unit = {},
    ): Result {
        val t0 = System.currentTimeMillis()
        val target = Languages.byCode(targetCode)

        val trace = mutableListOf<Attempt>()

        onStage("transcribing")
        val tAsr = System.currentTimeMillis()
        val transcript = transcribe(wav, sourceCode)
        val asrMs = System.currentTimeMillis() - tAsr

        trace += Attempt(
            stage = "speech → text",
            ms = asrMs,
            ok = transcript.isNotBlank(),
            preview = transcript.take(200),
            chars = transcript.length,
            reasons = if (transcript.isBlank()) listOf("model returned nothing for this audio") else emptyList(),
        )

        if (transcript.isBlank()) {
            android.util.Log.w("Parley", "ASR returned BLANK - nothing to translate")
            val now = System.currentTimeMillis() - t0
            return Result(
                "", "", targetCode, target.name, now, 0, 0,
                Timings(asrMs, 0, now), trace, unverified = true,
            )
        }

        android.util.Log.i("Parley", "ASR transcript=[${transcript.take(120)}] (${transcript.length} chars)")

        onStage("translating")
        val tMt = System.currentTimeMillis()
        val mt = translateText(transcript, targetCode, trace, sourceCode)
        val mtMs = System.currentTimeMillis() - tMt

        android.util.Log.i("Parley", "MT out=[${mt.text.take(120)}] attempts=${mt.attempts} variant=${mt.variant}")
        val total = System.currentTimeMillis() - t0
        return Result(
            transcript = transcript,
            translation = mt.text,
            targetLang = targetCode,
            targetName = target.name,
            ms = total,
            attempts = mt.attempts,
            variant = mt.variant,
            timings = Timings(asrMs, mtMs, total),
            trace = trace,
            unverified = mt.variant == guards.promptVariants.lastIndex && mt.attempts > 1,
        )
    }

    /** Text only: used by the typed-input path. */
    fun translateTextOnly(
        text: String,
        targetCode: String,
        onStage: (String) -> Unit = {},
    ): Result {
        val t0 = System.currentTimeMillis()
        val target = Languages.byCode(targetCode)
        onStage("translating")
        val trace = mutableListOf<Attempt>()
        val mt = translateText(text, targetCode, trace, "auto")
        val total = System.currentTimeMillis() - t0
        return Result(
            transcript = text,
            translation = mt.text,
            targetLang = targetCode,
            targetName = target.name,
            ms = total,
            attempts = mt.attempts,
            variant = mt.variant,
            timings = Timings(0, total, total),
            trace = trace,
            unverified = mt.variant == guards.promptVariants.lastIndex && mt.attempts > 1,
        )
    }

    // ---------------------------------------------------------------- ASR

    /**
     * Speech → text.
     *
     * Message shape matters and is *not* symmetric with translation: the audio
     * stage wants a system instruction plus a user turn that carries nothing but
     * the audio. Putting the instruction inline as a text part made the model
     * describe the recording ("A child is speaking and then a bird is
     * chirping") instead of transcribing it.
     */
    private fun transcribe(wav: ByteArray, sourceCode: String): String {
        val sys = if (sourceCode == "auto" || sourceCode.isBlank()) {
            "Perform ASR."
        } else {
            "Perform ASR in ${Languages.byCode(sourceCode).name}."
        }
        val b64 = Base64.getEncoder().encodeToString(wav)

        val body = JSONObject().apply {
            put("messages", JSONArray().apply {
                put(JSONObject().apply { put("role", "system"); put("content", sys) })
                put(JSONObject().apply {
                    put("role", "user")
                    put("content", JSONArray().apply {
                        put(JSONObject().apply {
                            put("type", "input_audio")
                            put("input_audio", JSONObject().apply {
                                put("data", b64)
                                put("format", "wav")
                            })
                        })
                    })
                })
            })
            put("temperature", 0)
            put("max_tokens", 128)
        }

        return guards.clean(textOf(post("$audioPort/v1/chat/completions", body)))
    }

    /**
     * Transcript only — no translation, no validation, no trace.
     *
     * Used by interim captions while the speaker is still talking. Deliberately
     * minimal: the desktop build notes that these calls are frequent, so doing
     * less per call is the difference between words appearing smoothly and the
     * engine falling behind the conversation.
     *
     * Failures are swallowed by the caller; interim text is a courtesy, not a
     * result.
     */
    fun transcribeOnly(wav: ByteArray, sourceCode: String = "auto"): String =
        try {
            transcribe(wav, sourceCode)
        } catch (t: Throwable) {
            android.util.Log.w("Parley", "interim ASR failed: ${t.javaClass.simpleName}")
            ""
        }

    // -------------------------------------------------------- translation

    private data class Mt(val text: String, val attempts: Int, val variant: Int)

    /**
     * Translate with validation and retries, mirroring the desktop pipeline.
     *
     * The retry is not defensive padding: a 2B translator gets questions,
     * numbers and commentary wrong often enough that shipping the first answer
     * would mean shipping visible mistakes. Each variant is a different wording
     * of the same instruction, tried in order until one passes.
     *
     * 16 tokens is deliberate. The chat template emits a hidden reasoning block
     * and strips it from the output but still spends the tokens; at 18 tok/s
     * that block is most of the latency. Measured on device: 16 tokens -> 1.55 s,
     * 512 tokens -> over three minutes.
     */
    private fun translateText(
        source: String,
        targetCode: String,
        trace: MutableList<Attempt>? = null,
        sourceCode: String = "auto",
    ): Mt {
        val target = Languages.byCode(targetCode)
        // Name the language being translated FROM. The desktop does this; passing
        // a placeholder instead is what made non-Korean targets fail: variant 3
        // became "Translate the source language to French", which gives the model
        // no instruction at all, so the guard rejected the reply.
        val srcName = Languages.name(Languages.detect(source, sourceCode))
        val variants = guards.promptVariants
        var last = ""
        var attempt = 0

        // Instruction injection is rare but must not be translated as if it were
        // content; it also gets the careful path rather than the fast one.
        val injection = guards.looksLikeInjection(source)

        // Desktop order: the subtitle framing (3) before the injection-resistant
        // wording (2); when instruction-shaped input is suspected, lead with 2.
        val order = if (injection) listOf(2, 0, 3, 1) else listOf(0, 1, 3, 2)
            .filter { it < variants.size }

        for (v in order) {
            attempt += 1
            // Desktop shape exactly: the instruction is a *system* message and
            // the payload is fenced in <source> tags in a single user turn.
            //
            // I first wrote this as two consecutive user messages, which is not
            // the same request at all — the model saw the instruction as part of
            // the conversation and answered it rather than translating. The
            // distinction only matters because the guard then rejects the reply,
            // so the symptom is "slow and flaky" rather than "wrong shape".
            val systemPrompt = variants[v]
                .replace("{src}", srcName)
                .replace("{dst}", target.name)

            val body = JSONObject().apply {
                put("messages", JSONArray().apply {
                    put(JSONObject().apply { put("role", "system"); put("content", systemPrompt) })
                    put(JSONObject().apply { put("role", "user"); put("content", fence(source)) })
                    // Assistant prefill: skips the model's hidden reasoning block and,
                    // measured on device, suppresses the "Source:" label it otherwise
                    // emits before the translation.
                    //
                    // Without this, French and German returned
                    //   "Source:\nOù se trouve la gare la plus proche ?"
                    // and the guard rejected it for containing markup. Korean never
                    // showed the problem, which is why it looked language-specific.
                    put(JSONObject().apply { put("role", "assistant"); put("content", "\n\n") })
                })
                put("temperature", 0)
                // 16 tokens is deliberate: the chat template emits a hidden
                // reasoning block, strips it from the output, and still charges
                // for the tokens. Measured on device: 16 -> 1.55 s, 512 -> 195 s.
                put("max_tokens", if (injection) 96 else 24)
            }

            val tVariant = System.currentTimeMillis()
            val raw = try {
                textOf(post("$textPort/v1/chat/completions", body))
            } catch (e: Exception) {
                // A failed variant is a rejected attempt, not a crash. Desktop
                // breaks out and returns what it has rather than throwing.
                if (v == order.last()) break
                continue
            }

            val cleaned = guards.clean(raw)
            // Verdict on the raw answer (desktop does the same), output with any
            // leading affirmation removed — "네, ..." in front of a translated
            // question is a reply, and reads wrong even when the sense survives.
            val out = guards.stripLeadingAffirmation(cleaned, source)
            last = out
            val elapsed = System.currentTimeMillis() - tVariant

            val (ok, reasons) = guards.check(cleaned, targetCode, source)
            trace?.add(
                Attempt(
                    stage = "translation, wording #${v + 1}",
                    ms = elapsed,
                    ok = ok,
                    preview = out.take(200),
                    chars = out.length,
                    reasons = reasons,
                ),
            )
            if (ok) return Mt(out, attempt, v)
        }

        // Every variant failed. Return a scrubbed best attempt rather than
        // nothing: an imperfect translation beats an empty bubble, and the caller
        // marks it unverified. Scrubbing matters because this is what the user
        // sees when everything went wrong, so it must never show "**Translation:**"
        // or the model's commentary.
        return Mt(guards.tidyFallback(last, source), attempt, variants.lastIndex)
    }

    // ---------------------------------------------------------------- TTS

    /**
     * Synthesise speech. Returns a WAV file (the route's default format).
     *
     * Field names matter and match the desktop build exactly:
     *
     *  - `voice` selects the speaker ("female" / "male"), NOT `gender`.
     *  - `lang` is a bare ISO code ("ko"), stripped from bcp47. Sending
     *    "korean" happens to be accepted but produces a different rendering —
     *    measured: 69 KB vs 77 KB for the same French sentence.
     *
     * Both were verified against the running server rather than assumed.
     */
    fun speak(text: String, langCode: String = "ko", voice: String = "female"): ByteArray? {
        if (text.isBlank()) return null
        val lang = Languages.byCode(langCode).bcp47.substringBefore("-").lowercase()
        val v = if (voice == "male") "male" else "female"
        return try {
            val bytes = postBytes(
                "$audioPort/tts",
                JSONObject().apply {
                    put("input", text.take(4000))
                    put("voice", v)
                    put("lang", lang)
                },
            )
            android.util.Log.i("Parley", "TTS: ${bytes.size} bytes lang=$lang voice=$v")
            bytes
        } catch (t: Throwable) {
            // Never swallow silently again: this exception is the entire story of
            // why a user hears nothing.
            android.util.Log.e("Parley", "TTS failed lang=$lang: ${t.javaClass.simpleName}: ${t.message}")
            null
        }
    }

    /**
     * Open a streaming TTS request.
     *
     * The full-file version of this call blocks for 12-36 s because the vocoder
     * runs on CPU, but the engine emits its first audio after ~4.8 s. Streaming
     * lets playback start then, which is the difference between an app that
     * feels broken and one that feels slow-but-working.
     *
     * The caller owns the stream and must close it.
     */
    fun speakStream(text: String, langCode: String = "ko"): java.io.InputStream? {
        if (text.isBlank()) return null
        val lang = Languages.byCode(langCode).ttsLang
        return try {
            val c = URL("http://127.0.0.1:$audioPort/tts").openConnection() as HttpURLConnection
            c.requestMethod = "POST"
            c.connectTimeout = 10_000
            c.readTimeout = 300_000
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use {
                it.write(
                    JSONObject().apply {
                        put("input", text)
                        put("lang", lang)
                        put("stream", true)
                    }.toString().toByteArray(),
                )
            }
            if (c.responseCode !in 200..299) {
                android.util.Log.e("Parley", "TTS stream HTTP ${c.responseCode}")
                return null
            }
            c.inputStream
        } catch (t: Throwable) {
            android.util.Log.e("Parley", "TTS stream failed: ${t.javaClass.simpleName}: ${t.message}")
            null
        }
    }

    // ------------------------------------------------------------- plumbing

    /**
     * Fence the payload so the model cannot mistake its contents for
     * instructions. The desktop build has hit the same need at the same 8000
     * character cut-off.
     */
    private fun fence(text: String): String {
        val cleaned = text.trim().take(8000)
        return "<source>\n$cleaned\n</source>"
    }

    private fun textOf(o: JSONObject): String =
        o.optJSONArray("choices")
            ?.optJSONObject(0)
            ?.optJSONObject("message")
            ?.optString("content")
            ?: ""

    private fun post(path: String, body: JSONObject): JSONObject =
        JSONObject(String(postBytes(path, body), Charsets.UTF_8))

    private fun postBytes(path: String, body: JSONObject): ByteArray {
        val url = URL("http://127.0.0.1:$path")
        val c = url.openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.connectTimeout = 10_000
        // Long on purpose: model load happens on the first request, and a short
        // read timeout turns a slow start into a fake "engine failure".
        c.readTimeout = 300_000
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        if (c.responseCode !in 200..299) {
            val err = c.errorStream?.bufferedReader()?.readText().orEmpty()
            throw RuntimeException("HTTP ${c.responseCode}: ${err.take(300)}")
        }
        return c.inputStream.use { it.readBytes() }
    }
}
