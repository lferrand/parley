package com.lionel.parley

/**
 * The 18 locales the audio model speaks, ported from the desktop build's
 * LANGUAGES table so both apps offer the same set.
 *
 * `ttsLang` is what the server's /tts route expects in its `lang` field — a bare
 * language code, not a composite voice name. `bcp47` is for Android's own
 * speech fallbacks and for display.
 */
data class Lang(
    val code: String,
    val name: String,
    val label: String,
    val native: String,
    val ttsLang: String,
    val bcp47: String,
)

object Languages {

    val all: List<Lang> = listOf(
        Lang("ko", "Korean", "Korean", "한국어", "korean", "ko-KR"),
        Lang("en", "English", "English", "English", "american-english", "en-US"),
        Lang("en-GB", "English", "English (UK)", "English (UK)", "british-english", "en-GB"),
        Lang("ja", "Japanese", "Japanese", "日本語", "japanese", "ja-JP"),
        Lang("zh", "Chinese", "Chinese", "中文", "chinese", "zh-CN"),
        Lang("es", "Spanish", "Spanish", "Español", "spanish", "es-ES"),
        Lang("fr", "French", "French", "Français", "french", "fr-FR"),
        Lang("de", "German", "German", "Deutsch", "german", "de-DE"),
        Lang("it", "Italian", "Italian", "Italiano", "italian", "it-IT"),
        Lang("pt", "Portuguese", "Portuguese", "Português", "portuguese", "pt-PT"),
        Lang("nl", "Dutch", "Dutch", "Nederlands", "dutch", "nl-NL"),
        Lang("pl", "Polish", "Polish", "Polski", "polish", "pl-PL"),
        Lang("sv", "Swedish", "Swedish", "Svenska", "swedish", "sv-SE"),
        Lang("da", "Danish", "Danish", "Dansk", "danish", "da-DK"),
        Lang("fi", "Finnish", "Finnish", "Suomi", "finnish", "fi-FI"),
        Lang("tr", "Turkish", "Turkish", "Türkçe", "turkish", "tr-TR"),
        Lang("ar", "Arabic", "Arabic", "العربية", "arabic", "ar-SA"),
        Lang("he", "Hebrew", "Hebrew", "עברית", "hebrew", "he-IL"),
        Lang("el", "Greek", "Greek", "Ελληνικά", "greek", "el-GR"),
    )

    private val byCodeMap = all.associateBy { it.code }

    fun byCode(code: String?): Lang = byCodeMap[code] ?: all.first()

    /**
     * Which language is this text written in?
     *
     * Ported from the desktop build's detectSourceLang, same order of checks:
     * script first, because Hangul/kana/Han/Arabic/Hebrew/Greek are unambiguous,
     * and the hint only decides Latin input, which many languages share.
     *
     * This exists because the translation prompt names the source language. It
     * used to be hardcoded as "the source language", which malformed every prompt
     * template ("Translate the source language to French") and is why non-Korean
     * targets produced output the guards then rejected.
     */
    fun detect(text: String?, hint: String = "auto"): String {
        val t = text ?: ""
        if (Regex("[\uAC00-\uD7A3\u3130-\u318F]").containsMatchIn(t)) return "ko"
        if (Regex("[\u3040-\u30FF]").containsMatchIn(t)) return "ja"      // kana: unambiguously Japanese
        if (Regex("[\u4E00-\u9FFF]").containsMatchIn(t)) return "zh"      // Han without kana
        if (Regex("[\u0600-\u06FF]").containsMatchIn(t)) return "ar"
        if (Regex("[\u0590-\u05FF]").containsMatchIn(t)) return "he"
        if (Regex("[\u0370-\u03FF]").containsMatchIn(t)) return "el"

        // Latin script is shared by many languages, so trust the hint.
        if (hint.isNotBlank() && hint != "auto" && hint != "ko" && byCodeMap.containsKey(hint)) {
            return hint
        }
        return "en"
    }

    /** English name for a code, for use inside a prompt. */
    fun name(code: String): String = byCode(code).name
}
