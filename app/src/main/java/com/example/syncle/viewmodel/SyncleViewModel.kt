package com.example.syncle.viewmodel

import android.content.Context
import androidx.compose.ui.geometry.Offset
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.syncle.data.AuthRepository
import com.example.syncle.data.DeviceIdStore
import com.example.syncle.data.LiveKitService
import com.example.syncle.data.Profile
import com.example.syncle.data.ProfileStore
import com.example.syncle.data.RoomStateReporter
import com.example.syncle.data.SnapshotApi
import com.example.syncle.domain.AvatarState
import com.example.syncle.domain.LiveKitEvent
import com.example.syncle.domain.MapConfig
import com.example.syncle.domain.MapConfigCache
import com.example.syncle.domain.PeerRegistry
import com.example.syncle.domain.PositionSyncEngine
import com.example.syncle.domain.ReconnectPolicy
import com.example.syncle.domain.SpatialAudioEngine
import com.example.syncle.domain.SyncleLog
import com.example.syncle.domain.TableMeetingController
import com.example.syncle.domain.TablePresence
import com.example.syncle.domain.UserStatus
import com.example.syncle.domain.ZonePresence
import com.example.syncle.domain.ZoneTracker
import com.example.syncle.ui.buildMeetingParticipants
import com.example.syncle.ui.state.ConnectionStatus
import com.example.syncle.ui.state.ConnectionUi
import com.example.syncle.ui.state.LocalAvatarUi
import com.example.syncle.ui.state.MeetingUi
import com.example.syncle.ui.state.SyncleUiState
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class SyncleViewModel : ViewModel() {
    val avatarState = AvatarState(initialPosition = Offset(100f, 100f))

    private val peerRegistry = PeerRegistry()
    val remotePeers = peerRegistry.observablePeers

    private val positionSync = PositionSyncEngine()
    private val spatialAudio = SpatialAudioEngine()
    private val meeting = TableMeetingController(avatarState) { liveKitService }

    private var liveKitService: LiveKitService? = null
    private var mapConfig: MapConfig? = null
    private var mapCache: MapConfigCache? = null
    private var syncJob: Job? = null
    private var lerpJob: Job? = null
    private var eventsJob: Job? = null
    private var derivedUiJob: Job? = null

    // #8: connection state lives in _uiState.value.connection (single source of
    // truth). Mutations go through updateConnection(); reads go through the
    // accessor properties below or _uiState.value.connection directly. The old
    // *Internal fields + var setters used to shadow this and forced every site
    // to remember to call pushUiState() to flush the duplicate.

    private var lastSpeakingIds: Set<String> = emptySet()

    // Set whenever local position or any input that feeds syncPresence /
    // updateSpatialAudio changes. The 20 Hz sync loop reads-and-clears this
    // and short-circuits the expensive per-peer work when the world has not
    // moved — saving CPU + bandwidth when everyone is parked. Initialized
    // true so the very first tick after connect publishes a baseline.
    private val spatialDirty = java.util.concurrent.atomic.AtomicBoolean(true)

    // Memoization for MeetingUi.participants. pushUiState() fires on every
    // 50 ms sync tick during a meeting; rebuilding the participants list
    // each time allocated ~20k MeetingParticipant per minute per peer for
    // zero visible change. Reuse the prior list reference when none of the
    // inputs feeding into buildMeetingParticipants have changed.
    private var participantsCacheKey: ParticipantsKey? = null
    private var participantsCache: List<com.example.syncle.ui.MeetingParticipant> = emptyList()

    private val _uiState = MutableStateFlow(SyncleUiState())
    val uiState: StateFlow<SyncleUiState> = _uiState.asStateFlow()

    private val authRepository = AuthRepository()
    private val snapshotApi = SnapshotApi()
    private val stateReporter = RoomStateReporter()

    // M1 zone plumbing: current zone resolution (inert until Android models
    // zones in its map config — see ZonePresence) and the boundary-crossing
    // tracker that dedups participant-attribute writes.
    private val zoneTracker = ZoneTracker()
    private var localZoneId: String? = null
    private var localZoneKind: ZonePresence.ZoneKind = ZonePresence.ZoneKind.NONE
    private var sessionUserId: String? = null
    private var sessionProfile: Profile? = null
    private var sessionRoom: String = ProfileStore.DEFAULT_ROOM
    private var sessionExpiresAt: Long = 0L
    private var lastSessionRefreshAt: Long = 0L
    private var reporterJob: Job? = null

    // #39: auto-reconnect plumbing. appContext is captured on first connect()
    // so the reconnect loop can run without holding an Activity reference.
    // userInitiatedDisconnect suppresses the retry loop when the user taps
    // Leave Room; cleared on the next manual connect().
    private var appContext: Context? = null
    private val userInitiatedDisconnect = java.util.concurrent.atomic.AtomicBoolean(false)
    private var reconnectJob: Job? = null
    private var reconnectAttempt: Int = 0
    private var lastConnectedCache: MapConfigCache? = null

    init {
        // Reactively rebuild UI whenever the peer registry or the active
        // table id changes. This is a safety net so that even if a future
        // code path forgets to call pushUiState(), the meeting room
        // participant list (which is derived from peerRegistry.snapshot()
        // and meeting.activeTableMeetingId) still stays in sync.
        derivedUiJob =
            viewModelScope.launch {
                combine(peerRegistry.revision, meeting.activeTableIdFlow) { _, _ -> Unit }
                    .collect { pushUiState() }
            }
    }

    fun setMapConfig(config: MapConfig) {
        mapConfig = config
        mapCache = MapConfigCache(config)
        pushUiState(mapReady = true)
    }

    fun getMapConfig(): MapConfig? = mapConfig

    fun getLiveKitRoom(): Room? = liveKitService?.getRoom()

    fun getLocalVideoTrack(): VideoTrack? = liveKitService?.getLocalVideoTrack()

    // Connection screen bindings — read-only views over _uiState.connection.
    val url: String get() = _uiState.value.connection.url
    val token: String get() = _uiState.value.connection.token
    val isAutoFetching: Boolean get() = _uiState.value.connection.isAutoFetching
    val connectionStatus: ConnectionStatus get() = _uiState.value.connection.status

    fun setUrl(value: String) = updateConnection { it.copy(url = value) }

    fun setToken(value: String) = updateConnection { it.copy(token = value) }

    /**
     * #46: update the nickname in the UI without persisting. Persisted on Join.
     */
    fun setNickname(value: String) =
        updateConnection {
            val trimmed = value.trim()
            val err =
                when {
                    trimmed.isEmpty() -> "Nickname required"
                    trimmed.length > ProfileStore.NICKNAME_MAX_LEN ->
                        "Max ${ProfileStore.NICKNAME_MAX_LEN} chars"
                    else -> null
                }
            it.copy(nickname = value, nicknameError = err)
        }

    /**
     * Pick a pixel-art character. The character bundles its own primary
     * color (see [ProfileStore.CHARACTERS]); selecting it updates both the
     * character id and the accent color in one go.
     */
    fun setCharacter(id: String) =
        updateConnection {
            val ch = ProfileStore.characterById(id)
            it.copy(character = ch.id, color = ch.color)
        }

    /**
     * #40: update the room name in the UI without persisting. Validation is
     * deferred until the user taps Join so they can type freely.
     */
    fun setRoom(value: String) =
        updateConnection {
            val trimmed = value.trim()
            val err =
                when {
                    trimmed.isEmpty() -> null // let placeholder handle empty
                    ProfileStore.isValidRoom(trimmed) -> null
                    else -> "Use 3-64 chars: a-z, 0-9, -"
                }
            it.copy(room = value, roomError = err)
        }

    fun reportStartupError(message: String) = updateConnection { it.copy(startupError = message) }

    private inline fun updateConnection(transform: (ConnectionUi) -> ConnectionUi) {
        _uiState.value = _uiState.value.let { s -> s.copy(connection = transform(s.connection)) }
    }

    fun autoFetchSession(context: Context) {
        if (isAutoFetching) return
        viewModelScope.launch {
            updateConnection { it.copy(isAutoFetching = true) }
            try {
                val deviceId = DeviceIdStore(context).getOrCreate()
                val store = ProfileStore(context)
                val profile = store.get()
                val room = store.getRoom()
                sessionRoom = room
                avatarState.name = profile.nickname
                sessionProfile = profile
                updateConnection {
                    it.copy(
                        room = room,
                        roomError = null,
                        nickname = profile.nickname,
                        nicknameError = null,
                        color = profile.color,
                        character = profile.character,
                    )
                }
                SyncleLog.d("Fetching session: deviceId=$deviceId nick=${profile.nickname} room=$room")
                val details =
                    authRepository.fetchSession(
                        deviceId = deviceId,
                        nickname = profile.nickname,
                        color = profile.color,
                        room = sessionRoom,
                    )
                if (details != null) {
                    sessionUserId = details.userId
                    sessionExpiresAt = details.expiresAt
                    updateConnection {
                        it.copy(url = details.serverUrl, token = details.token, startupError = null)
                    }
                    SyncleLog.d("Session fetch success userId=${details.userId} expiresAt=${details.expiresAt}")
                } else {
                    updateConnection {
                        it.copy(
                            startupError =
                                "Backend session fetch failed. Check syncle.backend_url in local.properties and that the server is reachable.",
                        )
                    }
                    SyncleLog.w("Session fetch returned null")
                }
            } catch (e: Exception) {
                SyncleLog.e("Session fetch failed", e)
                updateConnection { it.copy(startupError = "Startup Error: ${e.message}") }
            } finally {
                updateConnection { it.copy(isAutoFetching = false) }
            }
        }
    }

    fun connect(context: Context) {
        if (connectionStatus == ConnectionStatus.CONNECTING ||
            connectionStatus == ConnectionStatus.CONNECTED ||
            connectionStatus == ConnectionStatus.RECONNECTING
        ) {
            return
        }
        val cache = mapCache
        if (cache == null) {
            updateConnection {
                it.copy(
                    status = ConnectionStatus.ERROR,
                    lastConnectError = "Map not loaded yet. Wait a moment and try again.",
                )
            }
            return
        }

        // #40: persist room (validated) before connecting. If the user edited
        // the field but autoFetchSession used the old room, refetch the session.
        val store = ProfileStore(context)
        val typedRoom = _uiState.value.connection.room.trim()
        if (!ProfileStore.isValidRoom(typedRoom)) {
            updateConnection { it.copy(roomError = "Use 3-64 chars: a-z, 0-9, -") }
            return
        }
        val roomChanged = typedRoom != sessionRoom
        store.setRoom(typedRoom)
        sessionRoom = typedRoom
        updateConnection { it.copy(room = typedRoom, roomError = null) }

        // #46: persist nickname/color edits and refetch the JWT if they changed
        // (the session token carries nickname/color in its identity attributes).
        val typedNick = _uiState.value.connection.nickname.trim()
        val typedCharacter = _uiState.value.connection.character
        val typedColor = ProfileStore.characterById(typedCharacter).color
        if (!ProfileStore.isValidNickname(typedNick)) {
            updateConnection { it.copy(nicknameError = "Nickname required (max ${ProfileStore.NICKNAME_MAX_LEN})") }
            return
        }
        val priorProfile = sessionProfile
        val profileChanged =
            priorProfile == null ||
                priorProfile.nickname != typedNick ||
                priorProfile.character != typedCharacter ||
                priorProfile.color != typedColor
        if (profileChanged) {
            val updated = Profile(nickname = typedNick, color = typedColor, character = typedCharacter)
            store.update(updated)
            sessionProfile = updated
            avatarState.name = typedNick
            updateConnection { it.copy(nickname = typedNick, nicknameError = null, color = typedColor) }
        }

        appContext = context.applicationContext
        lastConnectedCache = cache
        userInitiatedDisconnect.set(false)
        reconnectJob?.cancel()
        reconnectAttempt = 0

        updateConnection { it.copy(status = ConnectionStatus.CONNECTING, lastConnectError = null) }
        viewModelScope.launch {
            // #40/#46: room or profile change means the existing JWT is for the
            // wrong identity. Refetch before attempting the LiveKit connect.
            if (roomChanged || profileChanged) {
                refreshSession(context.applicationContext)
            }
            attemptConnect(cache, isInitial = true)
        }
    }

    /**
     * Shared connect path used by both the user-initiated [connect] flow and
     * the [scheduleReconnect] retry loop. Caller is responsible for the UI
     * status transition into CONNECTING / RECONNECTING before calling.
     */
    private suspend fun attemptConnect(
        cache: MapConfigCache,
        isInitial: Boolean,
    ) {
        // Tear down any previous LiveKitService — on reconnect the old Room
        // is already dead, but disconnect() is idempotent and cheap.
        val old = liveKitService
        if (old != null) {
            liveKitService = null
            try {
                old.disconnect()
            } catch (_: Exception) {
                // best-effort
            }
        }
        val ctx = appContext ?: return
        val service = LiveKitService(ctx)
        liveKitService = service
        collectLiveKitEvents(service)

        val state = _uiState.value.connection
        val result = service.connect(state.url, state.token)
        if (result.success) {
            updateConnection {
                it.copy(
                    status = ConnectionStatus.CONNECTED,
                    lastConnectError = null,
                    reconnectAttempt = 0,
                )
            }
            reconnectAttempt = 0
            publishLocalProfileAttribute()
            seedFromSnapshot()
            if (isInitial) {
                startLoops(cache)
            }
            // Always (re)start the state reporter — token / userId may have rotated.
            startStateReporter()
            SyncleLog.d("LiveKit ${if (isInitial) "connected" else "reconnected"} (attempt=$reconnectAttempt)")
        } else {
            SyncleLog.w("LiveKit connect failed: ${result.errorMessage}")
            if (isInitial) {
                updateConnection { it.copy(status = ConnectionStatus.ERROR, lastConnectError = result.errorMessage) }
            } else {
                // Retry path: schedule another attempt with back-off.
                scheduleReconnect(reason = result.errorMessage)
            }
        }
    }

    /**
     * #39: schedule an exponential-back-off reconnect attempt. Safe to call
     * multiple times — concurrent calls are coalesced because we cancel any
     * in-flight reconnectJob first.
     */
    private fun scheduleReconnect(reason: String?) {
        if (userInitiatedDisconnect.get()) return
        val cache = lastConnectedCache ?: return
        if (appContext == null) return

        reconnectJob?.cancel()
        reconnectAttempt += 1
        val attempt = reconnectAttempt
        if (ReconnectPolicy.shouldGiveUp(attempt)) {
            updateConnection {
                it.copy(
                    status = ConnectionStatus.ERROR,
                    lastConnectError = "Reconnect gave up after ${attempt - 1} attempts. ${reason ?: ""}".trim(),
                )
            }
            SyncleLog.w("Reconnect: giving up after ${attempt - 1} attempts")
            return
        }
        val delayMs = ReconnectPolicy.delayMsForAttempt(attempt)
        SyncleLog.d("Reconnect: attempt $attempt scheduled in ${delayMs}ms (reason=$reason)")
        updateConnection {
            it.copy(
                status = ConnectionStatus.RECONNECTING,
                lastConnectError = reason,
                reconnectAttempt = attempt,
            )
        }
        reconnectJob =
            viewModelScope.launch {
                delay(delayMs)
                if (userInitiatedDisconnect.get()) return@launch
                // Refresh JWT if it's expired or within 60s of expiring.
                val now = System.currentTimeMillis()
                if (sessionExpiresAt > 0L && now >= sessionExpiresAt - 60_000L) {
                    val ctx = appContext ?: return@launch
                    SyncleLog.d("Reconnect: token expired/near-expiry, refetching session")
                    refreshSession(ctx)
                }
                attemptConnect(cache, isInitial = false)
            }
    }

    /**
     * Refresh the JWT in-place, preserving sessionRoom/profile. Throttled so a
     * persistently-failing backend (e.g. mis-signed JWTs returning 401 forever)
     * can't drive a hot loop of fetch attempts every reporter tick.
     */
    private suspend fun refreshSession(context: Context) {
        val now = System.currentTimeMillis()
        if (now - lastSessionRefreshAt < SESSION_REFRESH_MIN_INTERVAL_MS) {
            SyncleLog.d("refreshSession skipped (throttled)")
            return
        }
        lastSessionRefreshAt = now
        try {
            val deviceId = DeviceIdStore(context).getOrCreate()
            val profile = sessionProfile ?: ProfileStore(context).get()
            val details =
                authRepository.fetchSession(
                    deviceId = deviceId,
                    nickname = profile.nickname,
                    color = profile.color,
                    room = sessionRoom,
                ) ?: return
            sessionUserId = details.userId
            sessionExpiresAt = details.expiresAt
            updateConnection { it.copy(url = details.serverUrl, token = details.token) }
        } catch (e: Exception) {
            SyncleLog.w("refreshSession failed: ${e.message}")
        }
    }

    private fun collectLiveKitEvents(service: LiveKitService) {
        eventsJob?.cancel()
        eventsJob =
            viewModelScope.launch {
                service.events.collect { event ->
                    when (event) {
                        is LiveKitEvent.DataReceived -> onDataReceived(event.participantId, event.data)
                        is LiveKitEvent.ParticipantConnected -> onParticipantConnected(event.participantId, event.name, event.attributes)
                        is LiveKitEvent.ParticipantDisconnected -> onParticipantDisconnected(event.participantId)
                        is LiveKitEvent.VideoTrackSubscribed -> onVideoTrackSubscribed(event.participantId, event.track)
                        is LiveKitEvent.LocalVideoTrackChanged -> pushUiState()
                        is LiveKitEvent.ActiveSpeakersChanged -> onActiveSpeakersChanged(event.speakingIds)
                        is LiveKitEvent.ParticipantAttributesChanged -> onParticipantAttributes(event.participantId, event.attributes)
                        is LiveKitEvent.ConnectionQualityChanged -> onConnectionQualityChanged(event.participantId, event.quality)
                        is LiveKitEvent.Reconnecting -> {
                            // SDK-driven transient retry; surface it but don't tear down our state.
                            updateConnection { it.copy(status = ConnectionStatus.RECONNECTING) }
                        }
                        is LiveKitEvent.Reconnected -> {
                            reconnectAttempt = 0
                            updateConnection { it.copy(status = ConnectionStatus.CONNECTED, lastConnectError = null) }
                        }
                        is LiveKitEvent.Disconnected -> {
                            // SDK gave up. Drive our own back-off unless the user pulled the plug.
                            if (!userInitiatedDisconnect.get()) {
                                scheduleReconnect(reason = event.reason)
                            }
                        }
                    }
                }
            }
    }

    fun onMove(delta: Offset) {
        // While the local user is in a table meeting, they should be anchored
        // to that table — taps that translate to movement are ignored until
        // they explicitly leave the meeting.
        if (meeting.activeTableMeetingId != null) return
        val cache = mapCache ?: return
        val previousNearby = avatarState.nearbyItemId
        avatarState.move(delta, cache)
        spatialDirty.set(true)
        syncZoneAttributes()
        if (avatarState.nearbyItemId != previousNearby) {
            pushUiState()
        }
    }

    /**
     * M1: publish `zone` / `zone_kind` participant attributes when the local
     * avatar crosses a zone boundary. [ZoneTracker] dedups, so movement
     * inside the same zone never rewrites attributes.
     */
    private fun syncZoneAttributes() {
        val config = mapConfig ?: return
        val zoneId = ZonePresence.zoneIdFor(avatarState.position, config)
        val kind = ZonePresence.kindForZoneId(zoneId)
        localZoneId = zoneId
        localZoneKind = kind
        val payload = zoneTracker.crossedInto(zoneId, kind) ?: return
        liveKitService?.setLocalAttributes(payload)
    }

    fun joinTableMeeting(tableId: String) {
        if (meeting.join(tableId)) {
            mapCache?.invalidateProximityCache()
            spatialDirty.set(true)
            // Defensive: re-pull the room snapshot so peers already seated at
            // this table have their tableId reconciled even if a LiveKit
            // attribute event was missed (fixes the symmetric-visibility bug
            // where two users at the same table couldn't see each other).
            seedFromSnapshot()
            pushUiState()
        }
    }

    fun leaveTableMeeting() {
        meeting.leave()
        mapCache?.invalidateProximityCache()
        spatialDirty.set(true)
        pushUiState()
    }

    fun toggleMeetingMic() {
        meeting.toggleMic()
        pushUiState()
    }

    fun toggleMeetingCamera() {
        meeting.toggleCamera()
        pushUiState()
        // No need to schedule a delayed re-push for the local video tile: when
        // the camera track actually publishes (or unpublishes), the SDK fires
        // LocalTrackPublished / LocalTrackUnpublished and we re-push from
        // collectLiveKitEvents().
    }

    private fun startLoops(cache: MapConfigCache) {
        startSyncLoop(cache)
        startInterpolationLoop()
    }

    private fun startSyncLoop(cache: MapConfigCache) {
        val mapConfig = cache.config
        // #34: 20 Hz loop runs on Dispatchers.Default so it doesn't share the
        // Main thread with Compose recomposition and input handling. All work
        // inside is either pure Kotlin (positionSync, meeting state,
        // MapConfigCache), atomic (spatialDirty), or LiveKit SDK calls that
        // are safe off the main thread (publishData / track volume).
        syncJob =
            viewModelScope.launch(Dispatchers.Default) {
                while (isActive) {
                    val seq = positionSync.nextSequence()
                    val payload = positionSync.encodeIfMoved(avatarState.position, seq)
                    if (payload != null) {
                        liveKitService?.publishPosition(payload)
                    }
                    // syncPresence + updateSpatialAudio iterate every remote
                    // participant and allocate a participantByIdentity map; skip
                    // when neither the local avatar nor any remote target has
                    // moved since the last tick. encodeIfMoved already short-
                    // circuits its own publish, so this just guards the heavy
                    // per-peer work.
                    if (spatialDirty.getAndSet(false)) {
                        meeting.syncPresence(cache)
                        val acousticTable =
                            cache.resolveLocalAcousticTable(
                                avatarState.position,
                                meeting.activeTableMeetingId,
                            )
                        liveKitService?.updateSpatialAudio(
                            peerRegistry.snapshot(),
                            avatarState,
                            mapConfig,
                            acousticTable,
                            spatialAudio,
                        )
                    }
                    delay(50)
                }
            }
    }

    private fun startInterpolationLoop() {
        // #34: same rationale as startSyncLoop — peer interpolation math
        // and the spatialDirty toggle don't need the Main thread.
        lerpJob =
            viewModelScope.launch(Dispatchers.Default) {
                while (isActive) {
                    var anyMoving = false
                    peerRegistry.forEach { peer ->
                        if (peer.position != peer.targetPosition) {
                            peer.interpolate(0.2f)
                            anyMoving = true
                        }
                    }
                    // Peer.position drives spatial volume; keep the sync loop
                    // doing work while any peer is animating toward its target.
                    if (anyMoving) spatialDirty.set(true)
                    delay(if (anyMoving) 16 else 50)
                }
            }
    }

    private fun onDataReceived(
        participantId: String,
        data: ByteArray,
    ) {
        val packet = positionSync.decode(data) ?: return
        updatePeerPosition(participantId, Offset(packet.x, packet.y), packet.seq)
    }

    private fun updatePeerPosition(
        id: String,
        position: Offset,
        seq: Long,
    ) {
        val peer = peerRegistry.getOrCreate(id, position)
        if (seq >= peer.lastSequence) {
            peer.targetPosition = position
            peer.lastSequence = seq
            spatialDirty.set(true)
        }
    }

    private fun onParticipantConnected(
        id: String,
        name: String?,
        attributes: Map<String, String>,
    ) {
        // Register the peer immediately so they're visible even before they move
        // (no position packets) or change any attribute (initial attrs are already published).
        val peer = peerRegistry.getOrCreate(id)
        if (!name.isNullOrBlank() && peer.displayName != name) {
            peer.displayName = name
            peerRegistry.markChanged()
        }
        onParticipantAttributes(id, attributes)
        // Snapshot may have new info (tableId, position, color) that the LiveKit
        // attribute events haven't delivered yet. Pull it now so a late joiner
        // shows up in the existing user's UI as soon as they post their first state.
        seedFromSnapshot()
        pushUiState()
    }

    private fun onParticipantDisconnected(id: String) {
        spatialAudio.clearPeer(id)
        peerRegistry.remove(id)
        pushUiState()
    }

    private fun onVideoTrackSubscribed(
        id: String,
        track: io.livekit.android.room.track.VideoTrack,
    ) {
        peerRegistry.getOrCreate(id).videoTrack = track
        // Bump registry revision so pushUiState()'s participant cache key
        // changes; otherwise a new remote video tile won't appear until some
        // other peer field also changes.
        peerRegistry.markChanged()
        pushUiState()
    }

    private fun onActiveSpeakersChanged(speakingIds: Set<String>) {
        if (speakingIds == lastSpeakingIds) return
        lastSpeakingIds = speakingIds
        val localIdentity = liveKitService?.getLocalIdentity()
        avatarState.isSpeaking = localIdentity != null && speakingIds.contains(localIdentity)
        var anyPeerChanged = false
        peerRegistry.forEach { peer ->
            val speaking = speakingIds.contains(peer.id)
            if (peer.isSpeaking != speaking) {
                peer.isSpeaking = speaking
                anyPeerChanged = true
            }
        }
        if (anyPeerChanged) peerRegistry.markChanged()
        pushUiState()
    }

    private fun onParticipantAttributes(
        id: String,
        attributes: Map<String, String>,
    ) {
        // Use getOrCreate so that an attribute event arriving before any position/connect
        // event still materializes the peer.
        val peer = peerRegistry.getOrCreate(id)

        var changed = false
        val statusStr = attributes["status"]
        if (statusStr != null) {
            val status =
                try {
                    UserStatus.valueOf(statusStr)
                } catch (_: Exception) {
                    UserStatus.AVAILABLE
                }
            if (peer.status != status) {
                peer.status = status
                changed = true
            }
        }
        if (attributes.containsKey(TablePresence.ATTR_TABLE_ID)) {
            // Preserve the tri-state distinction: empty string means "explicitly
            // not in a meeting" (peer just left); never-declared stays null so
            // proximity fallback can still bind nearby peers to a table.
            val tableId = attributes[TablePresence.ATTR_TABLE_ID] ?: ""
            if (peer.tableMeetingId != tableId) {
                peer.tableMeetingId = tableId
                changed = true
            }
        }
        attributes[ATTR_COLOR]?.takeIf { it.isNotEmpty() }?.let { newColor ->
            if (peer.color != newColor) {
                peer.color = newColor
                changed = true
            }
        }
        attributes[ATTR_NICKNAME]?.takeIf { it.isNotBlank() }?.let { newNick ->
            if (peer.displayName != newNick) {
                peer.displayName = newNick
                changed = true
            }
        }
        attributes[ATTR_CHARACTER]?.takeIf { it.isNotBlank() }?.let { newChar ->
            if (peer.character != newChar) {
                peer.character = newChar
                changed = true
            }
        }
        if (changed) {
            peerRegistry.markChanged()
            pushUiState()
        }
    }

    private fun publishLocalProfileAttribute() {
        val profile = sessionProfile ?: return
        liveKitService?.setLocalAttributes(
            mapOf(
                ATTR_COLOR to profile.color,
                ATTR_NICKNAME to profile.nickname,
                ATTR_CHARACTER to profile.character,
            ),
        )
    }

    /**
     * #50: persist a profile edit made while connected. Updates ProfileStore,
     * the local avatar, the connection UI, and republishes identity attributes
     * so remote peers see the new nickname / color without a reconnect.
     * Returns true on success; false when the input failed validation (the
     * caller can rely on UI state already carrying the inline error).
     */
    fun applyProfileEdit(
        context: Context,
        nickname: String,
        character: String,
    ): Boolean {
        val trimmedNick = nickname.trim()
        if (!ProfileStore.isValidNickname(trimmedNick)) {
            updateConnection {
                it.copy(
                    nickname = nickname,
                    nicknameError = "Nickname required (max ${ProfileStore.NICKNAME_MAX_LEN})",
                )
            }
            return false
        }
        val ch = ProfileStore.characterById(character)
        val updated = Profile(nickname = trimmedNick, color = ch.color, character = ch.id)
        ProfileStore(context).update(updated)
        sessionProfile = updated
        avatarState.name = trimmedNick
        updateConnection {
            it.copy(
                nickname = trimmedNick,
                nicknameError = null,
                color = ch.color,
                character = ch.id,
            )
        }
        publishLocalProfileAttribute()
        pushUiState()
        return true
    }

    private fun seedFromSnapshot() {
        val selfId = sessionUserId
        viewModelScope.launch {
            val peers = snapshotApi.fetch(sessionRoom)
            var changed = false
            peers.asSequence()
                .filter { it.userId != selfId }
                .forEach { snap ->
                    val pos = Offset(snap.x, snap.y)
                    // For new peers, seed position from snapshot. For peers we
                    // already track, do NOT overwrite position once LiveKit
                    // data packets have started arriving (lastSequence >= 0) —
                    // otherwise snapshot clobbers in-flight interpolation and
                    // causes visible jitter / jumps.
                    val isNew = peerRegistry.get(snap.userId) == null
                    val peer = peerRegistry.getOrCreate(snap.userId, pos)
                    if (peer.displayName != snap.nickname) {
                        peer.displayName = snap.nickname
                        changed = true
                    }
                    if (peer.color != snap.color) {
                        peer.color = snap.color
                        changed = true
                    }
                    if (peer.tableMeetingId != snap.tableId) {
                        peer.tableMeetingId = snap.tableId
                        changed = true
                    }
                    if (isNew || peer.lastSequence < 0) {
                        peer.targetPosition = pos
                        peer.position = pos
                        changed = true
                    }
                }
            if (changed) {
                peerRegistry.markChanged()
                pushUiState()
            }
            SyncleLog.d("Snapshot seeded peers=${peers.size} changed=$changed")
        }
    }

    private fun startStateReporter() {
        reporterJob?.cancel()
        val userId = sessionUserId ?: return
        if (_uiState.value.connection.token.isEmpty()) return
        reporterJob =
            viewModelScope.launch {
                while (isActive) {
                    // Re-read token each tick: refreshSession() may have rotated it.
                    val token = _uiState.value.connection.token
                    if (token.isEmpty()) {
                        delay(REPORTER_INTERVAL_MS)
                        continue
                    }
                    val code =
                        stateReporter.report(
                            room = sessionRoom,
                            userId = userId,
                            token = token,
                            tableId = meeting.activeTableMeetingId,
                            position = avatarState.position,
                            zoneId = localZoneId,
                            zoneKind = localZoneKind.wireValue,
                        )
                    if (code == 401) {
                        // JWT rejected by backend (typically expired). Refresh in-place
                        // and let the next tick retry with the new token.
                        val ctx = appContext
                        if (ctx != null) {
                            SyncleLog.d("State report 401, refreshing session token")
                            refreshSession(ctx)
                        }
                    }
                    // Re-pull the room snapshot from the backend so peers' tableId,
                    // position, nickname and color stay fresh even if LiveKit
                    // attribute / data events are delayed or dropped. Backend is the
                    // source of truth.
                    seedFromSnapshot()
                    delay(REPORTER_INTERVAL_MS)
                }
            }
    }

    private fun onConnectionQualityChanged(
        id: String,
        quality: io.livekit.android.room.participant.ConnectionQuality,
    ) {
        val localIdentity = liveKitService?.getLocalIdentity()
        if (id == localIdentity) {
            if (avatarState.connectionQuality != quality) {
                avatarState.connectionQuality = quality
            }
        } else {
            peerRegistry.get(id)?.let { peer ->
                if (peer.connectionQuality != quality) peer.connectionQuality = quality
            }
        }
    }

    fun setLocalStatus(newStatus: UserStatus) {
        avatarState.status = newStatus
        liveKitService?.setLocalAttributes(mapOf("status" to newStatus.name))
    }

    fun disconnect() {
        userInitiatedDisconnect.set(true)
        reconnectJob?.cancel()
        reconnectJob = null
        reconnectAttempt = 0
        syncJob?.cancel()
        lerpJob?.cancel()
        eventsJob?.cancel()
        reporterJob?.cancel()
        val service = liveKitService
        liveKitService = null
        // Capture state under viewModelScope confinement so a concurrent
        // connect() can't observe half-cleared state.
        val userId = sessionUserId
        val token = _uiState.value.connection.token
        val tableId = meeting.activeTableMeetingId
        val pos = avatarState.position
        viewModelScope.launch {
            // Best-effort final state push so late joiners see our last
            // position even after we leave, until the 60s freshness window
            // expires.
            if (userId != null && token.isNotEmpty()) {
                try {
                    stateReporter.report(sessionRoom, userId, token, tableId, pos)
                } catch (e: Exception) {
                    SyncleLog.w("Final state report failed: ${e.message}")
                }
            }
            // Await full SDK teardown before clearing local state so the next
            // connect() can't race against dangling native handles.
            service?.disconnect()
            peerRegistry.clear()
            spatialAudio.clearAll()
            positionSync.reset()
            meeting.reset()
            zoneTracker.reset()
            localZoneId = null
            localZoneKind = ZonePresence.ZoneKind.NONE
            lastSpeakingIds = emptySet()
            mapCache?.invalidateProximityCache()
            updateConnection { it.copy(status = ConnectionStatus.DISCONNECTED) }
        }
    }

    override fun onCleared() {
        super.onCleared()
        // viewModelScope is cancelled as part of onCleared, so launching the
        // suspending disconnect() there would be a no-op. Use a detached
        // scope on Dispatchers.IO so the SDK still tears down cleanly when
        // the process is leaving the ViewModel behind.
        val service = liveKitService
        liveKitService = null
        if (service != null) {
            CoroutineScope(Dispatchers.IO + SupervisorJob()).launch {
                try {
                    service.disconnect()
                } catch (_: Exception) {
                    // best-effort
                }
            }
        }
    }

    private fun pushUiState(mapReady: Boolean? = null) {
        val config = mapConfig
        val ready = mapReady ?: (config != null)
        val meetingId = meeting.activeTableMeetingId
        val cache = mapCache
        val localIdentity = liveKitService?.getLocalIdentity()
        val localVideo = liveKitService?.getLocalVideoTrack()
        val participants =
            if (cache == null || meetingId == null) {
                participantsCacheKey = null
                participantsCache = emptyList()
                emptyList()
            } else {
                val key =
                    ParticipantsKey(
                        meetingId = meetingId,
                        micEnabled = meeting.meetingMicEnabled,
                        cameraEnabled = meeting.meetingCameraEnabled,
                        localIdentity = localIdentity,
                        localVideoTrack = localVideo,
                        peerRevision = peerRegistry.revision.value,
                        localName = avatarState.name,
                        localSpeaking = avatarState.isSpeaking,
                    )
                if (key == participantsCacheKey) {
                    participantsCache
                } else {
                    val fresh =
                        buildMeetingParticipants(
                            localAvatar = avatarState,
                            localIdentity = localIdentity,
                            localMicEnabled = meeting.meetingMicEnabled,
                            localCameraEnabled = meeting.meetingCameraEnabled,
                            localVideoTrack = localVideo,
                            tablePeers = meeting.peersAtTable(meetingId, cache.config, peerRegistry.snapshot()),
                            localColor = sessionProfile?.color ?: _uiState.value.connection.color,
                            localCharacter = sessionProfile?.character ?: _uiState.value.connection.character,
                        )
                    participantsCacheKey = key
                    participantsCache = fresh
                    fresh
                }
            }
        _uiState.value =
            _uiState.value.copy(
                mapReady = ready,
                meeting =
                    MeetingUi(
                        activeTableId = meetingId,
                        tableTitle = meetingId?.let { id -> config?.let { meeting.tableDisplayName(id, it) } },
                        participants = participants,
                        micEnabled = meeting.meetingMicEnabled,
                        cameraEnabled = meeting.meetingCameraEnabled,
                    ),
                localAvatar =
                    LocalAvatarUi(
                        name = avatarState.name,
                        nearbyItemId = avatarState.nearbyItemId,
                    ),
            )
    }

    private companion object {
        const val ATTR_COLOR = "color"
        const val ATTR_NICKNAME = "nickname"
        const val ATTR_CHARACTER = "character"
        const val REPORTER_INTERVAL_MS = 10_000L
        const val SESSION_REFRESH_MIN_INTERVAL_MS = 30_000L
    }
}

private data class ParticipantsKey(
    val meetingId: String,
    val micEnabled: Boolean,
    val cameraEnabled: Boolean,
    val localIdentity: String?,
    val localVideoTrack: io.livekit.android.room.track.VideoTrack?,
    val peerRevision: Long,
    val localName: String,
    val localSpeaking: Boolean,
)
