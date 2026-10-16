# VST effects

The EQ popover has a **VST** tab. On launch, Puros scans the system and user
`Library/Audio/Plug-Ins/VST` and `VST3` folders. The tab lists installed
bundles with search and refresh controls. Choose one from the list, or use
**Choose file** for a bundle elsewhere. Then enable, reorder, or remove it.
Use **GUI** on a stack item to open the plug-in's own macOS editor window.
Changes made there are sent to the active effect instances and saved with the
stack. **Params** opens Puros' searchable parameter panel as an alternative.
The stack is saved in app settings and restored at launch. A missing or
incompatible saved plug-in is bypassed on the next launch so playback can
continue.

Effects run after EQ and crossfeed on the PCM decode path, before the output
ring buffer. Each track
slot has its own plug-in instances. The empty or disabled rack returns without
touching PCM bytes; enabling any effect means PCM playback is no longer bit
perfect. DSD carried as DoP bypasses the entire DSP pipeline. The signal path
and format badge reflect this distinction.

The host currently accepts stereo effects with float32 replacing processing.
VST2 uses the established binary ABI; VST3 uses Steinberg's MIT licensed
interface headers bundled in `native/vendor/vst3sdk-interfaces`. The build is
offline and does not require the full SDK.

During PCM playback, the native editor attaches to the active slot's processing
instance, so its input meters receive the track's audio. Changes also reach
other prepared slots through host callbacks and controller state checks while
the window is open. Opening the GUI requires an enabled effect and an active PCM
track. Only one native
editor window is open at a time. Plug-ins that provide no compatible macOS
editor report an error in the stack. Parameter automation, preset import/export,
latency compensation, and out of process crash isolation are not implemented.
Third party plug-in code runs inside the audio process, so a faulty plug-in can
terminate playback or the app. Loaded bundles stay resident until the app exits
because several playback slots and the editor may use the same module at once.
