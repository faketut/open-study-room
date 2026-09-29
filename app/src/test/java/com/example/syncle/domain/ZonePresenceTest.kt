package com.example.syncle.domain

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ZonePresenceTest {
    private val map =
        MapConfig(
            mapName = "test",
            backgroundImage = "bg",
            walkableAreas = listOf(Rect(0f, 0f, 500f, 500f)),
            tables = emptyList(),
            collisionSettings = CollisionSettings("AABB", true),
        )

    @Test
    fun attributeKeys_matchContractVerbatim() {
        // contracts.md "LiveKit participant attributes" — keys must be
        // used verbatim by all clients.
        assertEquals("zone", ZonePresence.ATTR_ZONE)
        assertEquals("zone_kind", ZonePresence.ATTR_ZONE_KIND)
    }

    @Test
    fun zoneKind_wireValues_matchContractVerbatim() {
        assertEquals("silent", ZonePresence.ZoneKind.SILENT.wireValue)
        assertEquals("discussion", ZonePresence.ZoneKind.DISCUSSION.wireValue)
        assertEquals("rest", ZonePresence.ZoneKind.REST.wireValue)
        assertEquals("none", ZonePresence.ZoneKind.NONE.wireValue)
    }

    @Test
    fun kindForZoneId_null_isNone() {
        assertEquals(ZonePresence.ZoneKind.NONE, ZonePresence.kindForZoneId(null))
    }

    @Test
    fun zoneIdFor_noZoneModel_resolvesNull() {
        // Android map configs carry no zones yet (M1-followup); every
        // position resolves to no-zone until the model lands.
        assertNull(ZonePresence.zoneIdFor(Offset(250f, 250f), map))
    }

    @Test
    fun attributesFor_noZone_emptyZoneIdAndNoneKind() {
        val attrs = ZonePresence.attributesFor(null, ZonePresence.ZoneKind.NONE)
        // Contract: `zone` empty-string = "not inside any zone".
        assertEquals("", attrs[ZonePresence.ATTR_ZONE])
        assertEquals("none", attrs[ZonePresence.ATTR_ZONE_KIND])
    }

    @Test
    fun attributesFor_silentZone() {
        val attrs = ZonePresence.attributesFor("study-hall", ZonePresence.ZoneKind.SILENT)
        assertEquals("study-hall", attrs[ZonePresence.ATTR_ZONE])
        assertEquals("silent", attrs[ZonePresence.ATTR_ZONE_KIND])
    }

    @Test
    fun tracker_sameZone_noRewrite() {
        val tracker = ZoneTracker()
        assertNull(tracker.crossedInto(null, ZonePresence.ZoneKind.NONE))
        assertNull(tracker.crossedInto(null, ZonePresence.ZoneKind.NONE))
    }

    @Test
    fun tracker_crossingBoundary_returnsPayload() {
        val tracker = ZoneTracker()
        val payload = tracker.crossedInto("study-hall", ZonePresence.ZoneKind.SILENT)
        assertEquals("study-hall", payload?.get(ZonePresence.ATTR_ZONE))
        assertEquals("silent", payload?.get(ZonePresence.ATTR_ZONE_KIND))
    }

    @Test
    fun tracker_moveWithinSameZone_noRewrite() {
        val tracker = ZoneTracker()
        tracker.crossedInto("study-hall", ZonePresence.ZoneKind.SILENT)
        assertNull(tracker.crossedInto("study-hall", ZonePresence.ZoneKind.SILENT))
    }

    @Test
    fun tracker_crossingBack_returnsPayload() {
        val tracker = ZoneTracker()
        tracker.crossedInto("study-hall", ZonePresence.ZoneKind.SILENT)
        val payload = tracker.crossedInto(null, ZonePresence.ZoneKind.NONE)
        assertEquals("", payload?.get(ZonePresence.ATTR_ZONE))
        assertEquals("none", payload?.get(ZonePresence.ATTR_ZONE_KIND))
        assertTrue(tracker.crossedInto(null, ZonePresence.ZoneKind.NONE) == null)
    }

    @Test
    fun tracker_reset_restoresInertState() {
        val tracker = ZoneTracker()
        tracker.crossedInto("study-hall", ZonePresence.ZoneKind.SILENT)
        tracker.reset()
        assertNull(tracker.crossedInto(null, ZonePresence.ZoneKind.NONE))
    }
}
