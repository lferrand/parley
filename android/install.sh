#!/bin/bash
# Install Parley on a connected Android device and stream its logs.
#
# Written because the first thing worth knowing on a new device is whether the
# engine survives model load. Filtering logcat to the app's own PID is the
# difference between a readable trace and a wall of system noise.
set -euo pipefail

export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
ADB="$ANDROID_HOME/platform-tools/adb"
APK="${1:-app/build/outputs/apk/debug/app-debug.apk}"

if ! "$ADB" get-state >/dev/null 2>&1; then
    echo "No device. Enable USB debugging, plug in, and accept the RSA prompt."
    "$ADB" devices -l
    exit 1
fi

echo "== device =="
"$ADB" shell getprop ro.product.model
"$ADB" shell getprop ro.build.version.release
echo "== RAM =="
"$ADB" shell cat /proc/meminfo | head -1

echo "== installing =="
"$ADB" install -r -g "$APK"

echo "== clearing old log, launching =="
PID=$("$ADB" shell pidof com.lionel.parley || true)
[ -n "$PID" ] && "$ADB" shell am force-stop com.lionel.parley
"$ADB" logcat -c
"$ADB" shell am start -n com.lionel.parley/.MainActivity

sleep 2
echo "== streaming logs (Ctrl-C to stop) =="
echo "   watch for: 'engine missing', 'spawn failed', 'Audio engine failed'"
"$ADB" logcat -v time | grep --line-buffered -iE "parley|llama|ggml|AndroidRuntime|lowmemorykiller|killing"
