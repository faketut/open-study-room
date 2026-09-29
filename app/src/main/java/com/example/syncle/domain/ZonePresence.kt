package com.example.syncle.domain

import androidx.compose.ui.geometry.Offset

/**
 * M1 quiet-semantics zone support (contracts.md, "Zones (M1: quiet semantics)").
 *
 * Zone plumbing is wired end to end (state-report body, participant
 * attributes, boundary-crossing detection), but Android has NO zone data
 * model yet: `MapConfig` carries no zones and `map_config.json` ships no
 * `zones` array, so [zoneIdFor] always resolves `null` / [ZoneKind.NONE].
 * Modeling zones in the Android map config (rect + required `kind`, missing
 * `kind` parses as `discussion`) is an M1-followup. When it lands,
 * [zoneIdFor]/[kindForZoneId] gain the real point-in-zone lookup and
 * everything downstream starts carrying real values with no further
 * plumbing changes.
 */
object ZonePresence {
    /** LiveKit participant attribute keys — verbatim per contracts.md. */
    const val ATTR_ZONE = "zone"
    const val ATTR_ZONE_KIND = "zone_kind"

    /** Wire values for `zone_kind` — verbatim per contracts.md. */
    enum class ZoneKind(val wireValue: String) {
        SILENT("silent"),
        DISCUSSION("discussion"),
        REST("rest"),
        NONE("none"),
    }

    /**
     * Id of the zone containing [position], or null when the avatar is
     * outside every zone (or the map models no zones at all).
     *
     * Currently always null: Android map configs have no zones yet
     * (M1-followup: point-in-zone lookup against `MapConfig.zones`).
     */
    fun zoneIdFor(
        position: Offset,
        mapConfig: MapConfig,
    ): String? = null

    /**
     * Client-computed zone kind for [zoneId].
     *
     * Currently always [ZoneKind.NONE] (no zone model). M1-followup: look the
     * zone's parsed `kind` up by id once `MapConfig.zones` exists.
     */
    fun kindForZoneId(zoneId: String?): ZoneKind = ZoneKind.NONE

    /**
     * Attribute payload for a zone boundary crossing. Per contracts.md,
     * `zone` empty-string means "not inside any zone"; `zone_kind` always
     * carries a real kind (empty would mean "not published — keep existing").
     */
    fun attributesFor(
        zoneId: String?,
        kind: ZoneKind,
    ): Map<String, String> =
        mapOf(
            ATTR_ZONE to (zoneId ?: ""),
            ATTR_ZONE_KIND to kind.wireValue,
        )
}

/**
 * Tracks the last published zone so clients only rewrite participant
 * attributes when crossing a zone boundary — never for movement inside the
 * same zone (contracts.md transport rule).
 *
 * Pre-initialized to `(null, NONE)` as already-published: until the Android
 * zone model lands, resolution is inert and no attribute write ever fires.
 */
class ZoneTracker {
    private var lastZoneId: String? = null
    private var lastKind: ZonePresence.ZoneKind = ZonePresence.ZoneKind.NONE

    /**
     * Records the current zone. Returns the attribute payload to publish if
     * a boundary was crossed, or null when still inside the same zone.
     */
    fun crossedInto(
        zoneId: String?,
        kind: ZonePresence.ZoneKind,
    ): Map<String, String>? {
        if (zoneId == lastZoneId && kind == lastKind) return null
        lastZoneId = zoneId
        lastKind = kind
        return ZonePresence.attributesFor(zoneId, kind)
    }

    fun reset() {
        lastZoneId = null
        lastKind = ZonePresence.ZoneKind.NONE
    }
}
