package com.lionel.parley

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Palette lifted from the desktop stylesheet so the two apps look like siblings. */
private object Palette {
    val bg = Color(0xFF0F1115)
    val panel = Color(0xFF181B22)
    val text = Color(0xFFE8EAF0)
    val muted = Color(0xFF8B91A0)
    val dim = Color(0xFF6B7280)
    val accent = Color(0xFFFF6B8A)
    val blue = Color(0xFF5B8CFF)
}

class MainActivity : ComponentActivity() {

    private val perms = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            perms.launch(Manifest.permission.RECORD_AUDIO)
        }
        if (Build.VERSION.SDK_INT >= 33) perms.launch(Manifest.permission.POST_NOTIFICATIONS)

        // Engine lives behind a foreground service: a 2 GB child process is the
        // first thing reclaimed when a call arrives mid-sentence.
        startForegroundService(Intent(this, EngineService::class.java))

        setContent { ParleyApp() }
    }
}

/**
 * What Parley is doing, from the user's point of view.
 *
 * Distinct from `status`, which carries prose like "Didn't catch that". These are
 * the states that need to look *different*, because the difference between
 * listening and thinking is the difference between "speak now" and "wait".
 */
enum class Phase {
    IDLE,          // ready, nothing happening
    DOWNLOADING,   // first-run models
    STARTING,      // engines loading
    LISTENING,     // microphone hot, capturing speech
    TRANSCRIBING,  // speech → text
    TRANSLATING,   // text → target language
    SPEAKING,      // playing audio back
    ERROR,
}

data class Turn(
    val translation: String,
    val source: String,
    val targetCode: String,
    val targetName: String,
    val ms: Long,
    val verified: Boolean,
    // Kept per turn so the trace panel can explain this exchange long after it
    // happened. The desktop build does the same; a diagnostic that only exists
    // for the newest turn is useless the moment you translate again.
    val timings: Api.Timings = Api.Timings(0, 0, 0),
    val trace: List<Api.Attempt> = emptyList(),
)

@Composable
fun ParleyApp() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    var status by remember { mutableStateOf("Starting engine…") }

    // What the app is doing right now, as distinct from `status` (which is prose).
    // One string could not express "listening" vs "thinking": both rendered as the
    // same grey sentence, which is why a ten-second wait looked like a hang.
    var phase by remember { mutableStateOf(Phase.IDLE) }
    // Elapsed time within the current phase, shown so a long wait has a visible
    // counter rather than an unchanging label.
    var phaseStartedAt by remember { mutableStateOf(0L) }
    var phaseElapsed by remember { mutableStateOf(0) }
    var ready by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var level by remember { mutableStateOf(0f) }
    var turns by remember { mutableStateOf(listOf<Turn>()) }
    var targetCode by remember { mutableStateOf("ko") }
    // "auto" lets the audio model detect the spoken language; picking one sharpens
    // recognition when you already know it.
    var sourceCode by remember { mutableStateOf("auto") }
    var typed by remember { mutableStateOf("") }
    var lastMs by remember { mutableStateOf(0L) }
    var continuous by remember { mutableStateOf(false) }
    // Speaking every turn costs ~10 s of vocoder time on a long sentence, so it
    // is worth being able to turn off. Desktop calls this "auto speak".
    var autoSpeak by remember { mutableStateOf(true) }
    var showSource by remember { mutableStateOf(true) }
    var voiceGender by remember { mutableStateOf("female") }
    // Milliseconds of silence that end a turn. Desktop exposes this as "Pause".
    var pauseTolerance by remember { mutableStateOf(1400) }
    // Compose requires state to be declared before the composables that read it;
    // this was originally declared beside the Settings row, far below the header
    // button that opens it, which does not compile.
    var showModels by remember { mutableStateOf(false) }
    // Words appear here while you are still speaking, so a long utterance does
    // not land as one block after the pause.
    var liveCaption by remember { mutableStateOf("") }
    // Provisional translation of the words so far. Replaced by the real one when
    // the utterance ends, exactly as the desktop does it. Worth the extra request
    // because ASR and translation run on separate servers here (audio on the GPU,
    // text on the CPU), so the two do not queue behind each other.
    var liveTranslation by remember { mutableStateOf("") }
    // Translation of the live caption runs in its own scope and job, so it can
    // never hold up the ASR cadence.
    val interimScope = rememberCoroutineScope()
    var interimMtJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }
    var lastInterimText by remember { mutableStateOf("") }
    // Newest text awaiting translation. The translator drains this rather than
    // being restarted per snapshot.
    var pendingInterimText by remember { mutableStateOf("") }
    // Bumped to make the listening coroutine restart when the user re-enables it
    // or changes language; a plain Boolean cannot express "start again".
    var listenToken by remember { mutableStateOf(0) }

    // Drives the "2.4 s" style counter beside the phase label. Reset whenever the
    // phase changes, so the number always measures the current step.
    //
    // The wait here is real (ASR ~3 s, translation ~3 s, TTS up to 30 s), and a
    // frozen label is indistinguishable from a hang. A counter that keeps moving
    // is the cheapest possible proof that the app is still working.
    LaunchedEffect(phase, phaseStartedAt) {
        while (phase != Phase.IDLE) {
            phaseElapsed = ((System.currentTimeMillis() - phaseStartedAt) / 100) .toInt()
            kotlinx.coroutines.delay(100)
        }
        phaseElapsed = 0
    }

    // Poll readiness: the first launch downloads 2.4 GB, and the user must see
    // that rather than a frozen screen.
    LaunchedEffect(Unit) {
        while (true) {
            val e = EngineService.engine
            when {
                e == null -> { status = "Starting engine…"; phase = Phase.STARTING }
                !e.isReady() -> {
                    val dl = ModelDownloader(e)
                    val pct = (dl.bytesOnDisk() * 100L / dl.totalBytes().coerceAtLeast(1)).toInt()
                    status = "Downloading models · $pct%"; phase = Phase.DOWNLOADING; phaseStartedAt = System.currentTimeMillis()
                    ready = false
                }
                e.isRunning("audio") && e.isRunning("text") -> {
                    ready = true
                    // Only claim IDLE when no stage is actually running.
                    //
                    // This poll wakes every second and used to set phase = IDLE
                    // unconditionally, so it erased TRANSCRIBING / TRANSLATING /
                    // SPEAKING about a second after they were set. The spinner
                    // never appeared and the status line said "Ready" while the
                    // button underneath said "Working…" — two widgets disagreeing
                    // about the same moment.
                    if (phase !in setOf(
                            Phase.TRANSCRIBING, Phase.TRANSLATING,
                            Phase.SPEAKING, Phase.LISTENING,
                        )
                    ) {
                        status = "Ready · on-device"
                        phase = Phase.IDLE
                    }
                }
                else -> { status = "Starting engine…"; ready = false; phase = Phase.STARTING }
            }
            delay(1000)
        }
    }

    /**
     * Continuous listening, the desktop's default way to use Parley.
     *
     * Only one utterance is processed at a time: a queue would let the engine
     * fall minutes behind the conversation, which is worse than dropping a turn.
     * The detector keeps running, so speech during a translation is still
     * captured and simply arrives next.
     */
    // The listener runs for as long as continuous mode is on. Changing a setting
    // must not restart it — that would interrupt speech mid-turn — so the block
    // reads the latest values through these holders instead of capturing them.
    val autoSpeakNow by rememberUpdatedState(autoSpeak)
    val voiceNow by rememberUpdatedState(voiceGender)
    val pauseNow by rememberUpdatedState(pauseTolerance)

    LaunchedEffect(continuous, listenToken, ready) {
        if (!continuous || !ready) return@LaunchedEffect
        withContext(Dispatchers.IO) {
            try {
                Vad.listen(
                    onUtterance = { wav ->
                        // The final turn needs the text server; drop any speculative
                        // translation so it does not queue behind one.
                        interimMtJob?.cancel()
                        interimMtJob = null
                        lastInterimText = ""
                        pendingInterimText = ""
                        if (!busy) {
                            val e = EngineService.engine
                            if (e != null) {
                                runCatching {
                                    val api = Api(ctx, e)
                                    val r = api.translate(wav, targetCode, sourceCode)
                                    if (r.transcript.isNotBlank()) {
                                        withContext(Dispatchers.Main) {
                                            turns = listOf(
                                                Turn(
                                                    r.translation.ifBlank { "—" },
                                                    r.transcript,
                                                    r.targetLang,
                                                    r.targetName,
                                                    r.ms,
                                                    !r.unverified,
                                                    r.timings,
                                                    r.trace,
                                                ),
                                            ) + turns.take(40)
                                            lastMs = r.ms
                                            status = "Listening · on-device"; phase = Phase.LISTENING; phaseStartedAt = System.currentTimeMillis()
                                            liveCaption = ""
                                            liveTranslation = ""
                                        }
                                        if (autoSpeakNow) {
                                            AudioOut.playWav(
                                                api.speak(r.translation, targetCode, voiceNow),
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    },
                    onLevel = { l -> level = l },
                    onInterim = { wav ->
                        // ASR only. Translation is launched separately below.
                        //
                        // These used to be sequential inside one job, so while a
                        // translation was in flight the job was still marked
                        // active, the gate refused to start another pass, and no
                        // new captions were produced. The caption appeared to
                        // freeze the moment the first translation landed.
                        //
                        // They are genuinely independent here: ASR runs on the GPU
                        // audio server, translation on the CPU text server. Running
                        // them in one job serialised two things that never needed
                        // to wait for each other.
                        if (!busy) {
                            val e = EngineService.engine
                            if (e != null) {
                                val t0 = System.currentTimeMillis()
                                val text = Api(ctx, e).transcribeOnly(wav)
                                android.util.Log.i(
                                    "Parley",
                                    "interim: ${wav.size}b -> ${text.length} chars in " +
                                        "${System.currentTimeMillis() - t0}ms [${text.take(60)}]",
                                )
                                if (text.isNotBlank()) {
                                    withContext(Dispatchers.Main) { liveCaption = text }

                                    // Kick off translation for this text if one is not
                                    // already running. Deliberately *not* awaited: the
                                    // ASR pass must finish immediately so the next
                                    // snapshot can be taken.
                                    // Hand the newest text to the translator and let
                                    // it drain.
                                    //
                                    // Skipping while a job was active meant a snapshot
                                    // arriving mid-translation was dropped outright, and
                                    // if the user stopped speaking right then, that text
                                    // was never translated at all -- which is why a
                                    // translation sometimes never appeared.
                                    //
                                    // Coalescing instead: always translate the most
                                    // recent text, discarding the superseded ones. For a
                                    // live caption that is exactly right, and it also
                                    // bounds the work.
                                    pendingInterimText = text
                                    if (interimMtJob?.isActive != true) {
                                        interimMtJob = interimScope.launch(Dispatchers.IO) {
                                            while (true) {
                                                val target = pendingInterimText
                                                if (target.isBlank() || target == lastInterimText) {
                                                    return@launch
                                                }
                                                lastInterimText = target
                                                val provisional = runCatching {
                                                    Api(ctx, e)
                                                        .translateTextOnly(target, targetCode)
                                                        .translation
                                                }.getOrNull()
                                                if (!provisional.isNullOrBlank()) {
                                                    withContext(Dispatchers.Main) {
                                                        liveTranslation = provisional
                                                    }
                                                }
                                                // More text arrived while translating:
                                                // go round once more for the newest.
                                                if (pendingInterimText == target) return@launch
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    hangoverMs = pauseNow,
                    shouldStop = { false },
                )
            } catch (t: Throwable) {
                withContext(Dispatchers.Main) {
                    status = "Mic error: ${t.message?.take(50)}"; phase = Phase.ERROR
                    continuous = false
                }
            }
        }
    }

    fun run(block: suspend (Api) -> Unit) {
        if (busy || !ready) return
        busy = true
        scope.launch {
            try {
                val e = EngineService.engine ?: error("engine not started")
                // MUST be off the main thread. rememberCoroutineScope() launches
                // on Dispatchers.Main, and every Api call is a blocking
                // HttpURLConnection — so the request either trips
                // NetworkOnMainThreadException or stalls the UI before it ever
                // reaches the engine. This is why the microphone recorded fine
                // (AudioRec hops to IO itself) while no ASR request was logged and
                // nothing appeared on screen.
                withContext(Dispatchers.IO) { block(Api(ctx, e)) }
            } catch (t: Throwable) {
                android.util.Log.e("Parley", "turn failed: ${t.javaClass.simpleName}: ${t.message}")
                status = "Error: ${t.message?.take(70)}"; phase = Phase.ERROR
            } finally {
                busy = false
                level = 0f
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Palette.bg)
            .padding(horizontal = 18.dp)
            .padding(top = 44.dp, bottom = 20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // ---- header ------------------------------------------------------
        Row(verticalAlignment = Alignment.Bottom) {
            Text("Parley", color = Palette.text, fontSize = 30.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.width(10.dp))
            Text(
                if (lastMs > 0) "${lastMs} ms" else "",
                color = Palette.dim, fontSize = 12.sp,
                modifier = Modifier.padding(bottom = 5.dp),
            )
            Spacer(Modifier.weight(1f))
            if (turns.isNotEmpty()) {
                TextButton(onClick = {
                    // Newest first on screen, oldest first on the clipboard: a
                    // transcript is read in the order it was spoken.
                    val all = turns.reversed().joinToString("\n\n") {
                        "${it.source}\n${it.translation}"
                    }
                    val clip = ctx.getSystemService(android.content.ClipboardManager::class.java)
                    clip.setPrimaryClip(android.content.ClipData.newPlainText("Parley", all))
                    status = "Copied ${turns.size} turns"
                }) {
                    Text("Copy", color = Palette.muted, fontSize = 13.sp)
                }
                TextButton(onClick = { turns = emptyList(); lastMs = 0 }) {
                    Text("Clear", color = Palette.muted, fontSize = 13.sp)
                }
            }
        }

        PhaseIndicator(
            phase = phase,
            elapsedTenths = phaseElapsed,
            status = status,
            ready = ready,
        )

        // ---- language pair ----------------------------------------------
        // The desktop lets you declare what is being spoken, not only what it is
        // translated into. That matters: the ASR stage takes a language hint, and
        // without one it guesses from the audio, which is exactly where it
        // struggles most. "auto" keeps the guess.
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column {
                Text("Speaking", color = Palette.dim, fontSize = 10.5.sp)
                SourcePicker(selected = sourceCode, onSelect = { sourceCode = it })
            }

            Text("  →  ", color = Palette.dim, fontSize = 15.sp)

            Column {
                Text("Translates to", color = Palette.dim, fontSize = 10.5.sp)
                LanguagePicker(selected = targetCode, onSelect = { targetCode = it })
            }
        }

        // ---- transcript --------------------------------------------------
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (turns.isEmpty()) {
                Text(
                    "Tap the microphone and speak. The translation appears here — " +
                        "all of it on this phone.",
                    color = Palette.dim, fontSize = 13.sp,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
            for (t in turns) {
                TurnCard(t, showSource) {
                    play(
                        scope,
                        onSpeaking = { speaking ->
                            phase = if (speaking) Phase.SPEAKING else Phase.IDLE
                            phaseStartedAt = System.currentTimeMillis()
                        },
                    ) {
                        val e = EngineService.engine ?: return@play null
                        Api(ctx, e).speak(t.translation, t.targetCode, voiceGender)
                    }
                }
            }
        }

        // ---- typed input -------------------------------------------------
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = typed,
                onValueChange = { typed = it },
                placeholder = { Text("Type instead…", color = Palette.dim, fontSize = 13.sp) },
                singleLine = true,
                modifier = Modifier.weight(1f),
                shape = RoundedCornerShape(12.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = Palette.text,
                    unfocusedTextColor = Palette.text,
                    focusedBorderColor = Palette.blue.copy(alpha = 0.6f),
                    unfocusedBorderColor = Color(0xFF2A3140),
                    cursorColor = Palette.blue,
                ),
            )
            Spacer(Modifier.width(8.dp))
            Button(
                onClick = {
                    val text = typed.trim()
                    if (text.isEmpty()) return@Button
                    run { api ->
                        typed = ""
                        status = "Translating…"; phase = Phase.TRANSLATING; phaseStartedAt = System.currentTimeMillis()
                        val r = api.translateTextOnly(text, targetCode)
                        turns = listOf(
                            Turn(
                                r.translation.ifBlank { "—" }, r.transcript,
                                r.targetLang, r.targetName, r.ms, !r.unverified,
                                r.timings, r.trace,
                            )
                        ) + turns.take(40)
                        lastMs = r.ms
                        status = "Ready · on-device"; phase = Phase.IDLE; phaseStartedAt = System.currentTimeMillis()
                        play(
                            scope,
                            onSpeaking = { speaking ->
                                phase = if (speaking) Phase.SPEAKING else Phase.IDLE
                                phaseStartedAt = System.currentTimeMillis()
                            },
                        ) { api.speak(r.translation, targetCode) }
                    }
                },
                enabled = ready && !busy && typed.isNotBlank(),
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Palette.blue.copy(alpha = 0.22f),
                    contentColor = Color(0xFFD6E2FF),
                    // Explicit: the default disabled content colour vanished
                    // against this panel and made the button look broken rather
                    // than simply inactive.
                    disabledContainerColor = Color(0xFF1E2430),
                    disabledContentColor = Color(0xFF5C6472),
                ),
            ) { Text("Send", fontSize = 13.sp) }
        }

        // ---- settings (mirrors the desktop's chip row) --------------------
        var showSettings by remember { mutableStateOf(false) }

        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(
                onClick = { showSettings = !showSettings },
                contentPadding = PaddingValues(horizontal = 0.dp, vertical = 4.dp),
            ) {
                Text(
                    if (showSettings) "Settings  ▾" else "Settings  ▸",
                    color = Palette.muted, fontSize = 12.5.sp,
                )
            }
            TextButton(
                onClick = { showModels = true },
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
            ) {
                Text("Models", color = Palette.muted, fontSize = 12.5.sp)
            }
            Spacer(Modifier.weight(1f))
            // Keep the most consequential state visible even when collapsed.
            Text(
                buildString {
                    append(if (autoSpeak) "auto-speak" else "manual speak")
                    if (!showSource) append(" · source hidden")
                    if (voiceGender == "male") append(" · male voice")
                },
                color = Palette.dim, fontSize = 11.sp,
            )
        }

        if (showSettings) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                SettingSwitch(
                    label = "Speak translations",
                    hint = "Off means tap Speak on a card instead",
                    checked = autoSpeak,
                    onChange = { autoSpeak = it },
                )
                SettingSwitch(
                    label = "Show source text",
                    hint = "The original words under each translation",
                    checked = showSource,
                    onChange = { showSource = it },
                )
                SettingChoice(
                    label = "Voice",
                    options = listOf("female" to "Female", "male" to "Male"),
                    selected = voiceGender,
                    onSelect = { voiceGender = it },
                )
                SettingChoice(
                    label = "Pause before a turn ends",
                    options = listOf("800" to "Short", "1400" to "Normal", "2200" to "Long"),
                    selected = pauseTolerance.toString(),
                    onSelect = { pauseTolerance = it.toInt() },
                )
            }
            Spacer(Modifier.height(2.dp))
        }

        // ---- continuous listening toggle ---------------------------------
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(
                checked = continuous,
                onCheckedChange = { on ->
                    continuous = on
                    listenToken += 1
                    status = if (on) "Listening · on-device" else "Ready · on-device"
                },
                enabled = ready,
                colors = SwitchDefaults.colors(
                    checkedThumbColor = Color.White,
                    checkedTrackColor = Palette.accent,
                    uncheckedThumbColor = Palette.muted,
                    uncheckedTrackColor = Color(0xFF2A3140),
                ),
            )
            Spacer(Modifier.width(10.dp))
            Column {
                Text(
                    "Continuous listening",
                    color = if (ready) Palette.text else Palette.dim,
                    fontSize = 13.5.sp,
                )
                Text(
                    "Cuts each turn when you pause",
                    color = Palette.dim, fontSize = 11.sp,
                )
            }
        }

        // ---- live caption -----------------------------------------------
        // Words appear while you are still talking. The desktop build places this
        // directly under the microphone for the same reason: it is feedback about
        // the microphone, not part of the transcript yet.
        if (liveCaption.isNotBlank()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Palette.panel, RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(liveCaption, color = Palette.blue, fontSize = 13.sp)
                // Provisional translation, dimmed and italic-adjacent so it reads
                // as "not final yet". Replaced by the real card when you stop.
                if (liveTranslation.isNotBlank()) {
                    Text(
                        liveTranslation,
                        color = Palette.text.copy(alpha = 0.75f),
                        fontSize = 15.sp,
                    )
                }
            }
        }

        // ---- mic ---------------------------------------------------------
        // The desktop puts a circular button on the stage with a label under it,
        // rather than a full-width bar. Matched here so the two apps read the
        // same way, and because a circle reads as "hold to talk" at a glance.
        Column(
            modifier = Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                modifier = Modifier
                    .size(84.dp)
                    .clip(CircleShape)
                    .background(
                        if (continuous) Palette.panel
                        else if (!ready) Palette.accent.copy(alpha = 0.35f)
                        else Palette.accent
                    )
                    .clickable(enabled = ready && (continuous || !busy)) {
                        if (continuous) {
                            // Hands-free mode owns the microphone; this stops it.
                            continuous = false
                            listenToken += 1
                            status = "Ready · on-device"; phase = Phase.IDLE; phaseStartedAt = System.currentTimeMillis()
                            liveCaption = ""
                            liveTranslation = ""
                            return@clickable
                        }
                        run { api ->
                            status = "Listening…"; phase = Phase.LISTENING; phaseStartedAt = System.currentTimeMillis()
                            val wav = withContext(Dispatchers.IO) {
                                AudioRec.record(
                                    durationMs = 7_000,
                                    onLevel = { l -> level = l },
                                    // Interim captions belong to the input path, not
                                    // to continuous mode. They were only wired into
                                    // the VAD, so tapping the mic showed nothing until
                                    // the fixed window closed. The desktop shows them
                                    // for both.
                                    onSnapshot = { partial ->
                                        val e2 = EngineService.engine
                                        if (e2 != null && !busy) {
                                            val text = Api(ctx, e2).transcribeOnly(partial)
                                            if (text.isNotBlank()) {
                                                scope.launch(Dispatchers.Main) { liveCaption = text }
                                            }
                                        }
                                    },
                                )
                            }
                            status = "Transcribing…"; phase = Phase.TRANSCRIBING; phaseStartedAt = System.currentTimeMillis()
                            val r = api.translate(wav, targetCode, sourceCode)
                            if (r.transcript.isBlank()) {
                                status = "Didn't catch that"; phase = Phase.IDLE
                            } else {
                                turns = listOf(
                                    Turn(
                                        r.translation.ifBlank { "—" }, r.transcript,
                                        r.targetLang, r.targetName, r.ms, !r.unverified,
                                        r.timings, r.trace,
                                    ),
                                ) + turns.take(40)
                                lastMs = r.ms
                                status = "Ready · on-device"; phase = Phase.IDLE; phaseStartedAt = System.currentTimeMillis()
                                play(
                                    scope,
                                    onSpeaking = { speaking ->
                                        phase = if (speaking) Phase.SPEAKING else Phase.IDLE
                                        phaseStartedAt = System.currentTimeMillis()
                                    },
                                ) { api.speak(r.translation, targetCode, voiceGender) }
                            }
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                // A real icon, not an emoji: the emoji font renders in its own
                // colours and ignores the tint, which looked wrong inside a pink
                // circle. material-icons-extended is already a dependency.
                Icon(
                    imageVector = if (continuous) Icons.Filled.Stop else Icons.Filled.Mic,
                    contentDescription = if (continuous) "Stop listening" else "Start listening",
                    tint = if (continuous) Palette.text else Color.White,
                    modifier = Modifier.size(34.dp),
                )
            }

            Spacer(Modifier.height(8.dp))

            // Derived from the same phase as the indicator above, so the two can
            // never disagree. They did: the header said "Translating" while this
            // said "Working…", which reads as two different jobs.
            Text(
                when {
                    continuous -> "Listening — tap to stop"
                    !ready -> "Waiting for engine"
                    phase == Phase.TRANSCRIBING -> "Hearing you…"
                    phase == Phase.TRANSLATING -> "Translating…"
                    phase == Phase.SPEAKING -> "Speaking…"
                    busy -> "Working…"
                    else -> "Tap to speak"
                },
                color = Palette.muted,
                fontSize = 12.5.sp,
            )

            // Level meter: the desktop shows a thin bar under the mic, not a
            // percentage, because the number itself is meaningless to a speaker.
            if (level > 0.01f && (continuous || busy)) {
                Spacer(Modifier.height(6.dp))
                Box(
                    modifier = Modifier
                        .width(120.dp)
                        .height(3.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(Color(0xFF2A3140)),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth(level.coerceIn(0f, 1f))
                            .fillMaxHeight()
                            .background(Palette.accent),
                    )
                }
            }
        }

        if (showModels) {
            ModelsDialog(onClose = { showModels = false })
        }
    }
}

/**
 * What is on disk, and what to do about it.
 *
 * The splash explains the first download and then disappears forever. If a model
 * is later deleted or left half-written by an interrupted download, the only
 * symptom is that boot fails with nothing to look at. This is that look — the
 * desktop build has the same panel for the same reason.
 */
@Composable
private fun ModelsDialog(onClose: () -> Unit) {
    val ctx = LocalContext.current
    val engine = EngineService.engine
    val reports = remember {
        engine?.let { ModelDownloader(it).report() } ?: emptyList()
    }
    val total = reports.sumOf { it.bytes }
    val onDisk = reports.sumOf { it.onDisk }

    AlertDialog(
        onDismissRequest = onClose,
        containerColor = Palette.panel,
        title = { Text("Models", color = Palette.text) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "${mb(onDisk)} of ${mb(total)} on disk",
                    color = Palette.muted, fontSize = 12.sp,
                )
                LinearProgressIndicator(
                    progress = {
                        if (total > 0) (onDisk.toFloat() / total).coerceIn(0f, 1f) else 0f
                    },
                    modifier = Modifier.fillMaxWidth(),
                    color = Palette.accent,
                    trackColor = Color(0xFF2A3140),
                )
                for (r in reports) {
                    Column {
                        Text(r.name, color = Palette.text, fontSize = 11.5.sp)
                        Text(
                            when (r.state) {
                                "ready" -> "ready · ${mb(r.bytes)}"
                                "partial" -> "paused at ${r.percent}% · resumes"
                                "truncated" -> "incomplete · will restart"
                                else -> "missing"
                            },
                            color = when (r.state) {
                                "ready" -> Palette.blue
                                "missing", "truncated" -> Palette.accent
                                else -> Palette.muted
                            },
                            fontSize = 11.sp,
                        )
                    }
                }
                if (!engine?.isReady().let { it == true }) {
                    Text(
                        "Open the app with a connection and the download resumes automatically.",
                        color = Palette.dim, fontSize = 11.sp,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onClose) { Text("Done", color = Palette.text) }
        },
    )
}

private fun mb(bytes: Long): String = "${bytes / 1_000_000} MB"

@Composable
private fun TurnCard(t: Turn, showSource: Boolean, onSpeak: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Card(
        colors = CardDefaults.cardColors(containerColor = Palette.panel),
        shape = RoundedCornerShape(13.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(t.targetName, color = Palette.blue, fontSize = 11.sp)
                Spacer(Modifier.width(8.dp))
                Text("${t.ms} ms", color = Palette.dim, fontSize = 11.sp)
                if (!t.verified) {
                    Spacer(Modifier.width(8.dp))
                    // Honest about it: every prompt variant failed validation, so
                    // this is the least-bad attempt rather than a checked one.
                    Text("unverified", color = Palette.accent, fontSize = 11.sp)
                }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onSpeak, contentPadding = PaddingValues(0.dp)) {
                    Text("Speak", color = Palette.muted, fontSize = 12.sp)
                }
            }
            Spacer(Modifier.height(6.dp))
            Text(t.translation, color = Palette.text, fontSize = 18.sp)
            if (showSource) {
                Spacer(Modifier.height(5.dp))
                Text(t.source, color = Palette.muted, fontSize = 13.sp)
            }

            // How this was produced. Collapsed by default: a translator should
            // not open on a diagnostic panel, but when an answer looks wrong
            // there has to be somewhere to look that is not logcat.
            if (t.trace.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                TextButton(
                    onClick = { expanded = !expanded },
                    contentPadding = PaddingValues(0.dp),
                ) {
                    Text(
                        if (expanded) "Hide details" else "How this was produced",
                        color = Palette.dim, fontSize = 11.5.sp,
                    )
                }
                if (expanded) {
                    TraceView(t)
                }
            }
        }
    }
}

/**
 * The trace panel, modelled on the desktop build's "How this was produced".
 *
 * Two things it is for: showing where the time went, and showing *why* a
 * translation was rejected. The second is the one that matters — a 2B model
 * produces bad answers often enough that "it just looks wrong" is not a
 * usable report.
 */
@Composable
private fun TraceView(t: Turn) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        TraceRow("total", "${t.timings.totalMs} ms")
        if (t.timings.asrMs > 0) TraceRow("speech → text", "${t.timings.asrMs} ms")
        if (t.timings.translateMs > 0) TraceRow("translation", "${t.timings.translateMs} ms")
        TraceRow("input", t.source.take(120))

        for (a in t.trace) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 2.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        a.stage,
                        color = Palette.muted, fontSize = 11.sp,
                        modifier = Modifier.weight(1f),
                    )
                    Text("${a.ms} ms", color = Palette.dim, fontSize = 10.5.sp)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        if (a.ok) "accepted" else "rejected",
                        color = if (a.ok) Palette.blue else Palette.accent,
                        fontSize = 10.5.sp,
                    )
                }
                if (a.preview.isNotBlank()) {
                    Text(
                        a.preview.take(160) + if (a.chars > 160) "…" else "",
                        color = Palette.text, fontSize = 11.sp,
                    )
                }
                for (r in a.reasons) {
                    Text("· $r", color = Palette.dim, fontSize = 10.5.sp)
                }
            }
        }
    }
}

@Composable
private fun TraceRow(key: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(key, color = Palette.dim, fontSize = 10.5.sp, modifier = Modifier.width(96.dp))
        Text(value, color = Palette.muted, fontSize = 10.5.sp)
    }
}

/**
 * The phase indicator: what Parley is doing, and for how long.
 *
 * The point of this component is that its states must be *distinguishable at a
 * glance*, because the user's next action differs between them:
 *
 *   listening    -> keep talking
 *   transcribing -> stop talking, we have your words
 *   translating  -> wait a moment
 *   speaking     -> listen to the answer
 *
 * A single grey sentence ("Ready · on-device") could not express any of that, so
 * every wait looked like a hang.
 */
@Composable
private fun PhaseIndicator(phase: Phase, elapsedTenths: Int, status: String, ready: Boolean) {
    val label = when (phase) {
        Phase.IDLE -> status
        Phase.DOWNLOADING -> "Downloading models"
        Phase.STARTING -> "Starting engine"
        Phase.LISTENING -> "Listening"
        Phase.TRANSCRIBING -> "Transcribing speech"
        Phase.TRANSLATING -> "Translating"
        Phase.SPEAKING -> "Speaking"
        Phase.ERROR -> status
    }

    // A dot for the quiet states, a moving spinner for the working ones. The
    // difference between a static dot and a turning ring is readable out of the
    // corner of an eye, which is the whole purpose.
    val working = phase in setOf(
        Phase.DOWNLOADING, Phase.STARTING, Phase.TRANSCRIBING, Phase.TRANSLATING,
    )
    val live = phase == Phase.LISTENING

    val tint = when (phase) {
        Phase.ERROR -> Palette.accent
        Phase.LISTENING -> Palette.accent
        Phase.SPEAKING -> Palette.blue
        Phase.IDLE -> if (ready) Palette.muted else Palette.blue
        else -> Palette.blue
    }

    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier.size(14.dp),
            contentAlignment = Alignment.Center,
        ) {
            when {
                working -> CircularProgressIndicator(
                    modifier = Modifier.size(11.dp),
                    strokeWidth = 1.5.dp,
                    color = tint,
                )
                // A filled dot that pulses is the conventional "recording" signal;
                // it is distinct from a spinner without needing to be read.
                live -> Box(
                    modifier = Modifier
                        .size(9.dp)
                        .background(tint, CircleShape),
                )
                else -> Box(
                    modifier = Modifier
                        .size(7.dp)
                        .background(tint.copy(alpha = 0.55f), CircleShape),
                )
            }
        }

        Spacer(Modifier.width(8.dp))

        Text(label, color = tint, fontSize = 12.5.sp)

        // Elapsed time, only while working. Shown as tenths under a second so the
        // number visibly moves: a timer stuck on "0 s" is worse than none.
        if (working && elapsedTenths > 0) {
            Spacer(Modifier.width(8.dp))
            Text(
                if (elapsedTenths < 10) "${elapsedTenths / 10.0}".take(3) + " s"
                else "${elapsedTenths / 10} s",
                color = Palette.dim,
                fontSize = 11.5.sp,
            )
        }
    }
}

@Composable
private fun SettingSwitch(label: String, hint: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f)) {
            Text(label, color = Palette.text, fontSize = 13.sp)
            Text(hint, color = Palette.dim, fontSize = 10.5.sp)
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Color.White,
                checkedTrackColor = Palette.accent,
                uncheckedThumbColor = Palette.muted,
                uncheckedTrackColor = Color(0xFF2A3140),
            ),
        )
    }
}

@Composable
private fun SettingChoice(
    label: String,
    options: List<Pair<String, String>>,
    selected: String,
    onSelect: (String) -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Text(label, color = Palette.text, fontSize = 13.sp, modifier = Modifier.weight(1f))
        options.forEach { (value, text) ->
            TextButton(
                onClick = { onSelect(value) },
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
            ) {
                Text(
                    text,
                    color = if (value == selected) Palette.accent else Palette.muted,
                    fontSize = 12.sp,
                )
            }
        }
    }
}

/**
 * Source-language picker: the language being spoken.
 *
 * Leads with "Auto-detect" because that is the honest default — the audio model
 * reports what it hears. Choosing a language is an optimisation, not a
 * requirement, and hiding that would make the app feel like it needs setup.
 */
@Composable
private fun SourcePicker(selected: String, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val label = if (selected == "auto") "Auto-detect" else Languages.byCode(selected).native

    Box {
        TextButton(onClick = { open = true }) {
            Text(label, color = Palette.text, fontSize = 15.sp)
            Text("  ▾", color = Palette.muted, fontSize = 13.sp)
        }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            modifier = Modifier.heightIn(max = 380.dp),
        ) {
            DropdownMenuItem(
                text = { Text("Auto-detect", fontSize = 15.sp) },
                onClick = { onSelect("auto"); open = false },
            )
            for (l in Languages.all) {
                DropdownMenuItem(
                    text = {
                        Row {
                            Text(l.native, fontSize = 15.sp)
                            Spacer(Modifier.width(10.dp))
                            Text(l.label, color = Palette.muted, fontSize = 12.sp)
                        }
                    },
                    onClick = { onSelect(l.code); open = false },
                )
            }
        }
    }
}

@Composable
private fun LanguagePicker(selected: String, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val current = Languages.byCode(selected)

    Box {
        TextButton(onClick = { open = true }) {
            Text("${current.native}", color = Palette.text, fontSize = 15.sp)
            Text("  ▾", color = Palette.muted, fontSize = 13.sp)
        }
        DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            modifier = Modifier.heightIn(max = 380.dp),
        ) {
            for (l in Languages.all) {
                DropdownMenuItem(
                    text = {
                        Row {
                            Text(l.native, fontSize = 15.sp)
                            Spacer(Modifier.width(10.dp))
                            Text(l.label, color = Palette.muted, fontSize = 12.sp)
                        }
                    },
                    onClick = { onSelect(l.code); open = false },
                )
            }
        }
    }
}

/**
 * Fire-and-forget speech.
 *
 * Plays the whole WAV once it has been generated, rather than streaming.
 *
 * Streaming was tried and reverted: this vocoder emits small chunks with gaps
 * between them, so MODE_STREAM playback produced audible stutter and drops —
 * unusable in practice even though the first sound arrived sooner. Waiting for
 * a complete file gives continuous audio, which matters more than starting
 * early.
 *
 * The real fix for the wait is faster generation (GPU offload), not trickling.
 * Errors are logged rather than swallowed: a silent catch here previously turned
 * a NetworkOnMainThreadException into "no audio returned".
 */
private fun play(
    scope: kotlinx.coroutines.CoroutineScope,
    onSpeaking: (Boolean) -> Unit = {},
    fetch: suspend () -> ByteArray?,
) {
    scope.launch {
        val data = try {
            withContext(Dispatchers.IO) { fetch() }
        } catch (t: Throwable) {
            android.util.Log.e("Parley", "TTS fetch failed: ${t.javaClass.simpleName}: ${t.message}")
            null
        }
        if (data == null) {
            android.util.Log.w("Parley", "TTS: no audio returned")
            return@launch
        }
        android.util.Log.i("Parley", "TTS: ${data.size} bytes (complete file)")
        // Announce playback: the vocoder wait happens *before* this, so without a
        // distinct "speaking" state the user sees "translating" right up until
        // sound starts, and cannot tell whether audio is still coming.
        onSpeaking(true)
        try {
            withContext(Dispatchers.IO) { AudioOut.playWav(data) }
        } finally {
            onSpeaking(false)
        }
    }
}
