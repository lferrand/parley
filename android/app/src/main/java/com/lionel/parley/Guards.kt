package com.lionel.parley

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Translation output validation, ported from the desktop build.
 *
 * The desktop app does not trust a 2B translator. It checks the output and
 * retries with a different prompt variant when the answer is wrong. This is
 * that pipeline, reading the same `guards.rules.json` so the two cannot drift.
 *
 * What it catches, each of which was a real observed failure:
 *   - the model replies to a question instead of translating it
 *   - it describes the text ("this sentence is a Japanese question asking...")
 *   - it drops or invents a number or an AM/PM marker
 *   - it obeys an instruction buried in the text
 *   - it answers in the wrong language or script
 *   - it collapses a sentence to a word or two
 */
class Guards private constructor(ctx: Context) {

    private val r = JSONObject(ctx.assets.open("guards.rules.json").bufferedReader().readText())

    // ---- thresholds -------------------------------------------------------
    private val th = r.getJSONObject("thresholds")
    private val maxLengthRatio = th.getDouble("maxLengthRatio")
    private val minLengthFloor = th.getInt("minLengthFloor")
    private val koreanLeakRatio = th.getDouble("koreanLeakRatio")

    // ---- compiled rule sets ----------------------------------------------
    private fun patterns(section: String): List<Regex> {
        val arr: JSONArray = r.getJSONObject(section).getJSONArray("patterns")
        return (0 until arr.length()).map { Regex(arr.getString(it), RegexOption.IGNORE_CASE) }
    }

    private val assistantTells = patterns("assistantTells")
    private val injectionPatterns = patterns("injectionPatterns")
    private val metaReferences = patterns("metaReferences")

    private val scriptTests: Map<String, Regex> = r.getJSONObject("scriptTests").let { o ->
        o.keys().asSequence()
            .filter { !it.startsWith("$") }
            .associateWith { Regex(o.getString(it)) }
    }

    private val latinLangs: Set<String> = r.getJSONObject("latinLangs")
        .getJSONArray("codes").let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }

    private val questionEndings: Map<String, Regex> = r.getJSONObject("questionEndings").let { o ->
        o.keys().asSequence()
            .filter { !it.startsWith("$") }
            .associateWith { Regex(o.getString(it)) }
    }

    private val obedience = r.getJSONObject("obedience")
    private val minSourceWords = obedience.getInt("minSourceWords")
    private val maxOutputWords = obedience.getInt("maxOutputWords")
    private val requireWhitespace = obedience.optBoolean("requireWhitespace", true)

    private val meridiemSource = Regex(r.getJSONObject("meridiem").getString("sourceHas"), RegexOption.IGNORE_CASE)
    private val meridiemOutput = Regex(r.getJSONObject("meridiem").getString("outputHas"), RegexOption.IGNORE_CASE)

    // `affirmations.latin` and `.korean` are ARRAYS, not strings — reading them
    // with getString() throws on first use and takes the whole turn down. The
    // compiled forms live in `sourceOpens`, which is exactly what is wanted here.
    /** Plural lists, for stripping, as the desktop build does. */
    private val affirmationsLatinList: List<String> =
        r.getJSONObject("affirmations").getJSONArray("latin").let { a ->
            (0 until a.length()).map { a.getString(it) }
        }
    private val affirmationsKoreanList: List<String> =
        r.getJSONObject("affirmations").getJSONArray("korean").let { a ->
            (0 until a.length()).map { a.getString(it) }
        }

    private val affirmationsLatin =
        r.getJSONObject("affirmations").getJSONObject("sourceOpens").getString("latin")
    private val affirmationsKorean =
        r.getJSONObject("affirmations").getJSONObject("sourceOpens").getString("korean")

    val promptVariants: List<String> = r.getJSONObject("prompts")
        .getJSONArray("variants").let { a -> (0 until a.length()).map { a.getString(it) } }

    // ---- helpers ---------------------------------------------------------

    private val HANGUL = Regex("[\\uAC00-\\uD7A3]")
    private val LATIN = Regex("[a-zA-Z]")

    private val SINO = mapOf(
        "한" to 1, "일" to 1, "두" to 2, "이" to 2, "세" to 3, "삼" to 3,
        "네" to 4, "사" to 4, "다섯" to 5, "오" to 5, "여섯" to 6, "육" to 6,
        "일곱" to 7, "칠" to 7, "여덟" to 8, "팔" to 8, "아홉" to 9, "구" to 9,
    )

    private val MONTHS = listOf(
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december",
    )

    /**
     * Arabic-Indic digits: ٣ is three. Gulf and Egyptian text mixes both
     * systems, and a guard that only knows ASCII reads every Arabic-Indic
     * number as missing.
     */
    fun normalizeArabicDigits(s: String): String = s
        .replace(Regex("[\\u0660-\\u0669]")) { (it.value[0].code - 0x0660).toString() }
        .replace(Regex("[\\u06F0-\\u06F9]")) { (it.value[0].code - 0x06F0).toString() }

    /**
     * LFM3 speaks Korean numerals sometimes ("세 시" = 3 o'clock), and the small
     * translator then guesses. Convert spoken numbers to digits before
     * translating so the number guard compares like with like.
     *
     * Only clock and counter positions are rewritten, which is why "이" as the
     * ordinary particle is left alone.
     */
    fun normalizeKoreanNumbers(input: String): String {
        var t = input
        t = Regex("(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열한|열두)\\s*시(?!간|작|험|도|민|장|설|청|내|인|절)")
            .replace(t) { m -> "${SINO[m.groupValues[1]] ?: m.groupValues[1]}시" }
        t = Regex("(한|두|세|네|다섯|여섯|일곱|여덟|아홉)\\s*(명|개|잔|권|번|대|층|마리|병|송이)")
            .replace(t) { m -> "${SINO[m.groupValues[1]] ?: m.groupValues[1]}${m.groupValues[2]}" }
        return t
    }

    fun digitsOf(s: String): Set<String> =
        Regex("\\d+").findAll(s).map { it.value }.toSet()

    fun quotedTokens(text: String): Set<String> {
        val out = mutableSetOf<String>()
        val quoted = Regex("[\"'“”「」『』]([^'\"“”「」『』]{1,40})[\"'“”「」『』]")
        for (m in quoted.findAll(text)) out.add(m.groupValues[1].trim().uppercase())
        return out
    }

    /** Normalise model output: drop wrappers, labels, stray quotes, leaked tokens. */
    fun clean(text: String?): String {
        var t = (text ?: "").trim()
        t = Regex("```[a-z]*\\s*", RegexOption.IGNORE_CASE).replace(t, "")
        t = t.replace("```", "").trim()

        // The model sometimes echoes the <source> fence. If anything follows the
        // closing tag, that trailing part is the answer.
        val fenced = Regex("^\\s*<source>([\\s\\S]*?)</source>\\s*([\\s\\S]*)$", RegexOption.IGNORE_CASE).find(t)
        if (fenced != null) {
            val rest = fenced.groupValues[2].trim()
            t = if (rest.isNotEmpty()) rest else fenced.groupValues[1].trim()
        }

        t = Regex("</?\\s*(source|system|assistant|user|translation|output)\\s*>", RegexOption.IGNORE_CASE)
            .replace(t, "").trim()
        t = Regex("<\\|[a-z_]+\\|>", RegexOption.IGNORE_CASE).replace(t, "").trim()

        // Strip wrapper labels, possibly repeated ("Translation: ...").
        val label = Regex(
            "^(?:translation|source|input|output text|english|korean|japanese|chinese|spanish|french|german|italian|" +
                "portuguese|dutch|polish|swedish|danish|finnish|turkish|arabic|hebrew|greek|" +
                "answer|output)\\s*[:：\\-—]\\s*",
            RegexOption.IGNORE_CASE,
        )
        repeat(3) {
            val next = label.replace(t, "").trim()
            if (next == t) return@repeat
            t = next
        }

        t = Regex("^[\"“]([\\s\\S]*)[\"”]$").replace(t, "$1").trim()

        // Trailing artifacts left by the assistant prefill.
        //
        // Measured with prefill enabled: French and German end with "</source>",
        // Spanish with "**", Korean with a stray code fence. The fence and tag
        // patterns above only fire when they appear at the start, and `looksGood`
        // rejects any output containing "**" — so a perfectly good Spanish
        // translation was discarded for a two-character tail.
        t = Regex("(?:\\*\\*|```|</?\\s*(?:source|translation|output)\\s*>)+\\s*$", RegexOption.IGNORE_CASE)
            .replace(t, "")
            .trim()

        return t
    }

    // ---- checks ----------------------------------------------------------

    fun looksGood(text: String?, targetLang: String, sourceText: String): Boolean {
        val t = (text ?: "").trim()
        if (t.isEmpty()) return false
        if (t.contains("|") || t.contains("→") || t.contains("**") || t.contains("<|")) return false
        if (Regex("\\n\\s*\\n").containsMatchIn(t)) return false   // multi-paragraph rambling
        if (t.length > maxOf(minLengthFloor, (sourceText.length * maxLengthRatio).toInt())) return false

        // Writing system must match the target language.
        scriptTests[targetLang]?.let { return it.containsMatchIn(t) }

        if (targetLang in latinLangs) {
            if (HANGUL.containsMatchIn(t)) return false
            if (!LATIN.containsMatchIn(t)) return false
            // Mostly-Korean answer is the wrong language. One stray "API" must
            // not be enough to pass.
            val korean = HANGUL.findAll(t).count()
            val latin = LATIN.findAll(t).count()
            if (korean > latin * koreanLeakRatio) return false
        }
        return true
    }

    fun keptNumbers(source: String, translated: String): Boolean {
        // Korean renders numerals as words, so compare in one alphabet first.
        val translatedNorm = normalizeArabicDigits(normalizeKoreanNumbers(translated)).lowercase()

        val srcTimes = Clock.timeMentions(source)
        if (srcTimes.isNotEmpty()) {
            val dstTimes = Clock.timeMentions(translatedNorm)
            for (t in srcTimes) if (t !in dstTimes) return false
        }

        val want = digitsOf(Clock.stripTimes(normalizeArabicDigits(source)))
        if (want.isEmpty()) return true
        val out = Clock.stripTimes(translatedNorm)
        val have = digitsOf(out)
        for (d in want) {
            if (d in have) continue
            // "10월" -> "October" is faithful, not a dropped number.
            val asMonth = d.toIntOrNull()?.let { MONTHS.getOrNull(it - 1) }
            if (asMonth != null && out.contains(asMonth)) continue
            // Arabic dual form: "2 children" is طفلان — the two IS the word.
            if (d == "2" && Regex("[\\u0600-\\u06FF]").containsMatchIn(out) &&
                Regex("\\S*(ان|ين)\\b|\\S+(ان|ين)").containsMatchIn(out)
            ) continue
            return false
        }
        return true
    }

    fun inventedMeridiem(source: String, translated: String): Boolean =
        meridiemOutput.containsMatchIn(translated.lowercase()) &&
            !meridiemSource.containsMatchIn(source.lowercase())

    fun answeredInsteadOfTranslated(out: String): Boolean =
        assistantTells.any { it.containsMatchIn(out) }

    fun isCommentary(source: String, out: String): Boolean {
        if (metaReferences.any { it.containsMatchIn(out) }) return true
        val src = source.trim()
        if (src.length >= 8) {
            val quoted = listOf("「$src」", "\"$src\"", "'$src'", "“$src”", "『$src』")
            if (quoted.any { out.contains(it) }) return true
        }
        return false
    }

    fun looksLikeObedience(source: String, out: String): Boolean {
        val bare = out.trim()
            .replace(Regex("^[\\s\"'“”「」『』]+"), "")
            .replace(Regex("[\\s\"'“”「」『』.!?。！？]+$"), "")
            .uppercase()
        if (bare.isEmpty()) return false

        for (token in quotedTokens(source)) if (bare == token) return true

        // "Yes," in front of a translated question means it answered it.
        if (Regex("[?？]").containsMatchIn(source) &&
            Regex("^($affirmationsLatin)\\b", RegexOption.IGNORE_CASE).containsMatchIn(out.trim())
        ) return true

        // "Collapsed to a word or two" only makes sense for space-delimited
        // languages. Japanese and Chinese have no spaces, so a good sentence
        // counts as one word — that false positive rejected correct output.
        if (requireWhitespace && !Regex("\\s").containsMatchIn(out.trim())) return false

        val srcWords = source.trim().split(Regex("\\s+")).count { it.isNotEmpty() }
        val outWords = out.trim().split(Regex("\\s+")).count { it.isNotEmpty() }
        return srcWords >= minSourceWords && outWords <= maxOutputWords
    }

    fun answeredAQuestion(source: String, out: String, target: String): Boolean {
        if (!Regex("[?？]").containsMatchIn(source)) return false
        val t = out.trim()
        // A reply opens by agreeing. A translated question does not.
        if (Regex("^($affirmationsLatin)\\b", RegexOption.IGNORE_CASE).containsMatchIn(t)) return true
        if (Regex("^($affirmationsKorean)[\\s,，.!！]").containsMatchIn(t)) return true
        if (Regex("[?？]").containsMatchIn(t)) return false
        questionEndings[target]?.let { if (it.containsMatchIn(t)) return false }
        return true
    }

    /**
     * Remove a conversational opener a small model adds to a translated question.
     *
     * "Can you speak slower?" comes back as "네, 좀 더 천천히 말씀드리겠습니다."
     * ("Yes, I'll speak more slowly") — a reply, not a translation. The guard
     * rejects that, so without this the retry loop burns a whole variant and often
     * ends in "rejected".
     *
     * Only for questions, and never when the source itself opens with an
     * affirmation, or "Yes, please." would lose a real word.
     */
    fun stripLeadingAffirmation(text: String, source: String): String {
        val src = source
        if (!Regex("[?？]").containsMatchIn(src)) return text
        if (Regex(affirmationsLatin, RegexOption.IGNORE_CASE).containsMatchIn(src.trim())) return text
        if (Regex(affirmationsKorean).containsMatchIn(src.trim())) return text

        var t = text
        t = Regex(
            "^(?:${affirmationsLatinList.joinToString("|")})[\\s,，.!！]+",
            RegexOption.IGNORE_CASE,
        ).replace(t, "")
        t = Regex("^(?:${affirmationsKoreanList.joinToString("|")})[\\s,，.!！]+").replace(t, "")
        return t.trim()
    }

    /**
     * Last-resort cleanup for an answer that failed every variant.
     *
     * This is what the user sees when nothing passed validation, so it must never
     * carry the model's scaffolding. `clean()` strips labels only at the start of
     * the whole string; a "**Translation:**" heading on its own line slipped
     * through and was returned verbatim — seen in German, Swedish, Danish and
     * Turkish, which is precisely the non-Korean case being reported.
     */
    fun tidyFallback(text: String, source: String): String {
        var t = text.trim()
        if (t.isEmpty()) return t

        // A line that is nothing but a language label: "**Translation:**"
        val labelOnly = Regex(
            "^\\**\\s*(translation|übersetzung|traduction|traducción|vertaling|" +
                "oversættelse|översättning|çeviri|翻译|翻訳|번역)\\s*:?\\s*\\**$",
            RegexOption.IGNORE_CASE,
        )

        // Strip an inline "Translation:" prefix — but only when the prefix carries
        // no digits. An earlier desktop version allowed 24 word characters here
        // and ate real text: "The train leaves at 7:45 AM." became "45 AM.",
        // because "The train leaves at 7" is a legitimate 24-character prefix
        // ending in a colon. A label never contains a digit, so that is the test.
        val inlineLabel = Regex(
            "^\\**\\s*(?=[^:\\d]*:)(?![^:\\d]*\\d)[^:\\d]{1,24}:\\s*\\**\\s*",
            RegexOption.IGNORE_CASE,
        )

        val scrubbed = t.split(Regex("\\n+"))
            .map { it.trim() }
            .filter { it.isNotEmpty() && !labelOnly.matches(it) }
            .map { inlineLabel.replace(it, "") }
            .filter { it.isNotEmpty() }
            .joinToString("\n")
            .trim()

        if (scrubbed.isNotEmpty()) t = scrubbed
        if (t.isEmpty()) return t

        // If it still looks like a reply, or is far longer than the source, keep
        // only the first clause: a short honest fragment beats a paragraph of
        // the model talking about the text.
        if (!answeredInsteadOfTranslated(t) && t.length <= maxOf(120, source.length * 5)) {
            return t
        }
        val firstLine = t.split(Regex("\\n+")).first().trim()
        val firstClause = firstLine.split(Regex("\\s+/\\s+|\\s+—\\s+")).first().trim()
        val candidate = firstClause.ifEmpty { firstLine }
        return if (candidate.isNotEmpty() && candidate.length < t.length) candidate else t
    }

    fun looksLikeInjection(text: String): Boolean =
        injectionPatterns.any { it.containsMatchIn(text) }

    /** Full verdict with actionable reasons, mirroring checkTranslation(). */
    fun check(out: String, targetCode: String, text: String): Pair<Boolean, List<String>> {
        val reasons = mutableListOf<String>()
        val t = out.trim()

        if (t.isEmpty()) {
            reasons.add("empty output")
        } else {
            if (!looksGood(t, targetCode, text)) {
                when {
                    t.contains("|") || t.contains("→") || t.contains("**") || t.contains("<|") ->
                        reasons.add("output contains markup or tables")
                    Regex("\\n\\s*\\n").containsMatchIn(t) ->
                        reasons.add("output was several paragraphs (model explained instead of translating)")
                    t.length > maxOf(minLengthFloor, (text.length * maxLengthRatio).toInt()) ->
                        reasons.add("output too long for the source (${t.length} chars)")
                    scriptTests[targetCode]?.containsMatchIn(t) == false ->
                        reasons.add("output was not in the target script ($targetCode)")
                    else -> reasons.add("output did not look like a translation")
                }
            }
            if (!keptNumbers(text, t)) reasons.add("a number or time from the source was lost or changed")
            if (inventedMeridiem(text, t)) reasons.add("output invented an AM/PM marker the source did not have")
            if (answeredInsteadOfTranslated(t)) reasons.add("model replied to the text instead of translating it")
            if (looksLikeObedience(text, t)) reasons.add("model followed an instruction in the text instead of translating it")
            if (answeredAQuestion(text, t, targetCode)) reasons.add("source was a question but the output was an answer, not a question")
            if (isCommentary(text, t)) reasons.add("output described or quoted the text instead of translating it")
        }
        return (reasons.isEmpty()) to reasons
    }

    /**
     * Prove the rules loaded and behave, on the device.
     *
     * Written after shipping 300 lines of validation that compiled but had never
     * executed: a getString() on a JSON array throws on first use and would have
     * taken down the first translation. Logging the outcome at startup turns that
     * class of mistake into something adb can see.
     */
    fun selfTest(): Boolean {
        return try {
            val good = check("안녕하세요, 잘 지내세요?", "ko", "Good morning, how are you?")
            // A reply instead of a translation must be rejected.
            val bad = check("I'm happy to help you with that!", "ko", "Good morning")
            val ok = good.first && !bad.first
            android.util.Log.i(
                "Parley",
                "guards selfTest=$ok good=${good.first} bad=${bad.first} reasons=${bad.second}",
            )
            ok
        } catch (t: Throwable) {
            android.util.Log.e("Parley", "guards selfTest CRASHED: ${t.message}")
            false
        }
    }

    companion object {
        @Volatile private var instance: Guards? = null

        fun get(ctx: Context): Guards = instance ?: synchronized(this) {
            instance ?: Guards(ctx.applicationContext).also { instance = it }
        }
    }
}
