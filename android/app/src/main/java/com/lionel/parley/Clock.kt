package com.lionel.parley

/**
 * Clock-time canonicalisation, ported from the desktop build's clock.mjs.
 *
 * "3 PM" is 15h in French, 15 Uhr in German, 15:00 in Italian, 오후 3시 in
 * Korean. All correct, none sharing a digit with the source. Comparing glyphs
 * reads each as a lost number, rejects a good translation, and burns a retry.
 *
 * So compare *moments*: every clock mention becomes minutes since midnight.
 *
 * One scanner produces both the set of moments and the text with those spans
 * blanked out, so detection and stripping cannot disagree about which forms
 * exist.
 */
object Clock {

    private val MERIDIEM = mapOf(
        "오전" to "am", "오후" to "pm",
        "午前" to "am", "午後" to "pm",
        "上午" to "am", "下午" to "pm",
        "ص" to "am", "م" to "pm",
    )

    private const val MER = "(오전|오후|午前|午後|上午|下午)"

    private fun to24(hour: Int, meridiem: String): Int {
        val h = hour % 12
        return if (meridiem == "pm") h + 12 else h
    }

    private class Pass(val re: Regex, val take: (MatchResult) -> Int)

    /**
     * Ordered passes. Each blanks what it matched so later passes cannot
     * double-count the same span.
     */
    private val PASSES: List<Pass> = listOf(
        // 오후 3시 30분 / 午後3時 / 下午3点
        Pass(Regex("$MER\\s*(\\d{1,2})(?:\\s*[:.]\\s*(\\d{2}))?\\s*(?:시|時|点|點)(?:\\s*(\\d{1,2}))?\\s*분?")) { m ->
            val mer = MERIDIEM[m.groupValues[1]] ?: "am"
            val hour = to24(m.groupValues[2].toInt(), mer)
            val mins = m.groupValues.getOrNull(3)?.takeIf { it.isNotEmpty() }
                ?: m.groupValues.getOrNull(4)?.takeIf { it.isNotEmpty() }
            hour * 60 + (mins?.toInt() ?: 0)
        },
        // 3 PM / 7:45 am / 3p.m.
        Pass(Regex("(\\d{1,2})(?:[:.](\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)(?![a-z])", RegexOption.IGNORE_CASE)) { m ->
            val mer = if (m.groupValues[3].startsWith("p", ignoreCase = true)) "pm" else "am"
            to24(m.groupValues[1].toInt(), mer) * 60 + (m.groupValues[2].toIntOrNull() ?: 0)
        },
        // Arabic spells the meridiem out: "الساعة 3 مساءً" (3 in the evening).
        Pass(Regex("(\\d{1,2})(?:[:.](\\d{2}))?\\s*(مساءً|مساء|صباحاً|صباح|ظهراً|ظهر|ليلاً|ليلة)")) { m ->
            val evening = Regex("^(مساء|ظهر|ليل)").containsMatchIn(m.groupValues[3])
            to24(m.groupValues[1].toInt(), if (evening) "pm" else "am") * 60 + (m.groupValues[2].toIntOrNull() ?: 0)
        },
        // French: 7h45. Must precede the bare "15h" pass or "7h45" reads as 7:00.
        Pass(Regex("(?<!\\d)(\\d{1,2})\\s*h\\s*(\\d{2})(?!\\d)", RegexOption.IGNORE_CASE)) { m ->
            (m.groupValues[1].toInt() % 24) * 60 + m.groupValues[2].toInt()
        },
        // 15h / 15 Uhr / 15 uur
        Pass(Regex("(\\d{1,2})(?:[:.](\\d{2}))?\\s*(?:h(?![a-z])|uhr\\b|uur\\b)", RegexOption.IGNORE_CASE)) { m ->
            (m.groupValues[1].toInt() % 24) * 60 + (m.groupValues[2].toIntOrNull() ?: 0)
        },
        // Scandinavian "kl. 15" / "kl 15.30"
        Pass(Regex("\\bkl\\.?\\s*(\\d{1,2})(?:[:.](\\d{2}))?", RegexOption.IGNORE_CASE)) { m ->
            (m.groupValues[1].toInt() % 24) * 60 + (m.groupValues[2].toIntOrNull() ?: 0)
        },
        // Bare H:MM, last so "3:30 PM" is already consumed.
        Pass(Regex("(?<!\\d)(\\d{1,2}):(\\d{2})(?!\\d)")) { m ->
            (m.groupValues[1].toInt() % 24) * 60 + m.groupValues[2].toInt()
        },
    )

    /** @return pair of (moments in minutes since midnight, text with them blanked) */
    fun scan(text: String?): Pair<Set<Int>, String> {
        var rest = text ?: ""
        val minutes = mutableSetOf<Int>()

        for (pass in PASSES) {
            rest = pass.re.replace(rest) { m ->
                runCatching { pass.take(m) }.getOrNull()?.let { minutes.add(it) }
                // Blank the span, preserving length so nothing else shifts.
                " ".repeat(m.value.length)
            }
        }
        return minutes to rest
    }

    fun timeMentions(text: String?): Set<Int> = scan(text).first

    fun stripTimes(text: String?): String = scan(text).second
}
